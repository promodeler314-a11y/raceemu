import { charaSkills, supportHint, type DeckData } from '../../data/src/deck.ts';
import { skillLvToFactor } from '../../sim/src/data/constants.ts';
import type { DerivedSetting } from '../../sim/src/setting.ts';
import type { SkillData } from '../../sim/src/skill/types.ts';
import { canTrigger, dependsOnlyOnIgnored } from './screen.ts';

/**
 * 育成計画から候補を組み立てる。
 *
 * 手持ちのスキル表から選ぶ形では、育て終わった馬がどれを買うかしか答えられない。
 * 候補の出どころを入手経路に移すと、同じ探索器を計画に使える。
 * docs/solver-design.md 7.2 節を参照。
 *
 * 入手経路ごとに縛られ方が違う。
 * 汎用の白は継承でいくらでも足せるので、縛るのはスキルポイントだけである。
 * 固有の継承版は 1 回の育成に 6 つまでしか積めない。
 * 金は育成ウマ娘が覚えるものだけで、サポートカードのヒントには出てこない。
 */

export type Route =
  /** 育成ウマ娘が初期か覚醒で覚える。割引は無い。 */
  | 'chara'
  /** デッキのサポートカードがヒントで持つ。ヒントレベルのぶん安くなる。 */
  | 'hint'
  /** 汎用の白を継承で足す。本数に上限は無い。 */
  | 'inherit'
  /** 他のウマ娘の固有の継承版。6 つまで。 */
  | 'inheritedUnique';

export interface Candidate {
  readonly skillId: string;
  readonly name: string;
  readonly rarity: string;
  readonly route: Route;
  /** この経路で取るときの費用 */
  readonly cost: number;
  /** 割引に使ったヒントレベル。割引が無ければ 0。 */
  readonly hintLevel: number;
  /** ヒントを持つカードの名前。他の経路では null。 */
  readonly source: string | null;
}

export interface PlanInput {
  /** 育成ウマ娘の ID。省くと固有と金が候補に入らない。 */
  readonly charaId?: number | null;
  /** 覚醒ランク。省くと最大まで覚えたものとして扱う。 */
  readonly charaRank?: number;
  /** 連れて行くサポートカード */
  readonly cards?: readonly { readonly id: number; readonly talent?: number }[];
}

export interface PlanOptions {
  /** 汎用の白を継承で足せるものとして候補に入れる。既定は入れる。 */
  readonly openWhites?: boolean;
  /** 固有の継承版を候補に入れる。既定は入れる。 */
  readonly openInheritedUniques?: boolean;
  /**
   * モデルが無視している条件しか持たないスキルを候補に入れるか。既定は入れない。
   *
   * 順位や他のウマ娘の顔ぶれに依る条件は「満たしている前提」で落とされるため、
   * そういうスキルは必ず発動する扱いになり、探索が片端から拾う。
   * docs/solver-design.md 8 節を参照。
   */
  readonly includeIgnoredOnly?: boolean;
  /**
   * ヒントレベルを一律この値として扱う。
   *
   * 省いたときはカードが持つ底上げの値を使う。実際にどこまで上がるかは
   * ヒントが何回出たかで決まるので、どちらにしても仮定である。
   */
  readonly hintLevel?: number;
}

export interface PlanCandidates {
  /** 無視している条件しか持たないために外したスキルの ID */
  readonly droppedByIgnored: readonly string[];
  /** 候補。同じスキルは最も安い経路のものだけが残る。 */
  readonly entries: readonly Candidate[];
  /** 探索に渡す候補の ID */
  readonly skillIds: readonly string[];
  /** 費用モデルに渡すヒントレベル */
  readonly hintLevels: Record<string, number>;
  /** 常に持っているスキル。育成ウマ娘の固有がこれにあたる。 */
  readonly alwaysSkillIds: readonly string[];
  /** 経路ごとの数 */
  readonly countByRoute: Readonly<Record<Route, number>>;
}

const PURCHASABLE = new Set(['normal', 'rare']);

function clampLevel(level: number): number {
  return Math.max(0, Math.min(skillLvToFactor.length - 1, Math.trunc(level)));
}

function costOf(skill: SkillData, hintLevel: number): number {
  return Math.trunc(skill.sp * skillLvToFactor[clampLevel(hintLevel)]!);
}

/** 名前から、買えるスキルを 1 つ引く。デバフなど、引けない名前は無視する。 */
function purchasableByName(
  skillsByName: ReadonlyMap<string, readonly SkillData[]>,
  name: string,
): SkillData | undefined {
  return skillsByName.get(name)?.find((skill) => skill.sp > 0 && PURCHASABLE.has(skill.rarity));
}

export function buildPlanCandidates(
  skills: readonly SkillData[],
  skillsByName: ReadonlyMap<string, readonly SkillData[]>,
  deck: DeckData,
  setting: DerivedSetting,
  plan: PlanInput,
  options: PlanOptions = {},
): PlanCandidates {
  const openWhites = options.openWhites ?? true;
  const openInheritedUniques = options.openInheritedUniques ?? true;
  const includeIgnoredOnly = options.includeIgnoredOnly ?? false;
  const dropped: string[] = [];
  const usable = (skill: SkillData): boolean => {
    if (!canTrigger(skill, setting)) return false;
    if (!includeIgnoredOnly && dependsOnlyOnIgnored(skill, setting)) {
      dropped.push(skill.id);
      return false;
    }
    return true;
  };

  // 同じスキルに複数の経路があるときは、最も安いものを残す。
  const best = new Map<string, Candidate>();
  const offer = (candidate: Candidate): void => {
    const current = best.get(candidate.skillId);
    if (current === undefined || candidate.cost < current.cost) best.set(candidate.skillId, candidate);
  };

  const chara = plan.charaId == null ? undefined : deck.charasById.get(plan.charaId);
  const alwaysSkillIds: string[] = [];
  if (chara !== undefined) {
    // 固有は買うものではないので、候補ではなく最初から持っているものとして渡す。
    // 同じ持ち主に複数あるときは後ろのものを採る（apps/web の扱いに合わせる）。
    const unique = skills.filter((s) => s.rarity === 'unique' && s.holder === chara.name).at(-1);
    if (unique !== undefined) alwaysSkillIds.push(unique.id);

    for (const name of charaSkills(chara, plan.charaRank)) {
      const skill = purchasableByName(skillsByName, name);
      if (skill === undefined || !usable(skill)) continue;
      offer({
        skillId: skill.id,
        name: skill.name,
        rarity: skill.rarity,
        route: 'chara',
        cost: costOf(skill, 0),
        hintLevel: 0,
        source: null,
      });
    }
  }

  for (const entry of plan.cards ?? []) {
    const card = deck.supportsById.get(entry.id);
    if (card === undefined) continue;
    const hint = supportHint(card, entry.talent ?? 4);
    const level = clampLevel(options.hintLevel ?? hint?.level ?? 0);
    for (const name of card.skills) {
      const skill = purchasableByName(skillsByName, name);
      if (skill === undefined || !usable(skill)) continue;
      offer({
        skillId: skill.id,
        name: skill.name,
        rarity: skill.rarity,
        route: 'hint',
        cost: costOf(skill, level),
        hintLevel: level,
        source: card.name,
      });
    }
  }

  for (const skill of skills) {
    if (skill.sp <= 0) continue;
    const white = openWhites && skill.rarity === 'normal';
    const inherited = openInheritedUniques && skill.rarity === 'inherit';
    if (!white && !inherited) continue;
    if (!usable(skill)) continue;
    offer({
      skillId: skill.id,
      name: skill.name,
      rarity: skill.rarity,
      route: inherited ? 'inheritedUnique' : 'inherit',
      cost: costOf(skill, 0),
      hintLevel: 0,
      source: null,
    });
  }

  const entries = [...best.values()].sort((a, b) => a.cost - b.cost);
  const hintLevels: Record<string, number> = {};
  const countByRoute: Record<Route, number> = { chara: 0, hint: 0, inherit: 0, inheritedUnique: 0 };
  for (const entry of entries) {
    if (entry.hintLevel > 0) hintLevels[entry.skillId] = entry.hintLevel;
    countByRoute[entry.route]++;
  }

  return {
    entries,
    skillIds: entries.map((entry) => entry.skillId),
    hintLevels,
    alwaysSkillIds,
    countByRoute,
    droppedByIgnored: [...new Set(dropped)],
  };
}
