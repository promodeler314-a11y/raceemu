import { charaSkills, supportHint, type DeckData } from '../../data/src/deck.ts';
import { skillLvToFactor } from '../../sim/src/data/constants.ts';
import type { DerivedSetting } from '../../sim/src/setting.ts';
import { classifySkill } from '../../sim/src/skill/classify.ts';
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
  | 'inheritedUnique'
  /**
   * 入手経路を問わない。全スキルを候補にしたときに使う。
   *
   * どのデッキで育てれば取れるかを問わず「取れるとしたら何が効くか」を見る。
   * 実際に取れるかは別の問いなので、割引も経路の縛りも当てない。
   */
  | 'any';

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
  /**
   * 条件を落としているスキル（印は ▲）を候補から外す。既定は外さない。
   *
   * 落とした条件は**満たしている扱い**になるので、発動率も短縮量も本来より
   * 高く出る（`packages/sim/src/skill/classify.ts`）。候補が 20 個のうちは
   * 表の印で見分けられたが、数百に広げると上位が ▲ で埋まって使いものに
   * ならない。docs/server-design.md 8 節の 7 を参照。
   *
   * `includeIgnoredOnly` より広い。あちらは**すべての条件**が無視されている
   * ものだけを外すので、これを立てるとあちらは効かなくなる。
   */
  readonly excludeDropped?: boolean;
  /**
   * ▲ の判定に使う。順位条件を判定するか（フィールドを渡すか）。既定は渡さない。
   *
   * 順位と距離差の族は、渡さなければ ▲、渡せば △ になる。
   * つまり同じスキルでもこの値で印が動くので、外す判定にも必ず添える。
   */
  readonly hasField?: boolean;
}

/** 全スキルを候補にするときの指定。経路では縛らず、種類で選ぶ。 */
export interface AllSkillOptions extends PlanOptions {
  /** 金（レア）を候補に入れる。既定は入れる。 */
  readonly openGolds?: boolean;
}

export interface PlanCandidates {
  /** 無視している条件しか持たないために外したスキルの ID */
  readonly droppedByIgnored: readonly string[];
  /** 条件を落としている（▲）ために外したスキルの ID。つまみが切ってあれば空。 */
  readonly droppedByFidelity: readonly string[];
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

/**
 * 走らせる前に候補から落とす判定。
 *
 * 育成計画からでも全スキルからでも、落とし方は同じである。
 * 落とした理由ごとに分けて持ち、画面が「何個を何の理由で外したか」を出せるようにする。
 */
function createScreen(setting: DerivedSetting, options: PlanOptions) {
  const includeIgnoredOnly = options.includeIgnoredOnly ?? false;
  const excludeDropped = options.excludeDropped ?? false;
  const hasField = options.hasField ?? false;
  const byIgnored: string[] = [];
  const byFidelity: string[] = [];
  const usable = (skill: SkillData): boolean => {
    if (!canTrigger(skill, setting)) return false;
    if (!includeIgnoredOnly && dependsOnlyOnIgnored(skill, setting)) {
      byIgnored.push(skill.id);
      return false;
    }
    if (excludeDropped && classifySkill(skill, setting, { hasField }).fidelity === 'dropped') {
      byFidelity.push(skill.id);
      return false;
    }
    return true;
  };
  return { usable, byIgnored, byFidelity };
}

/** 同じスキルに複数の経路があるときは、最も安いものを残す。 */
function createOffer() {
  const best = new Map<string, Candidate>();
  return {
    best,
    offer(candidate: Candidate): void {
      const current = best.get(candidate.skillId);
      if (current === undefined || candidate.cost < current.cost) {
        best.set(candidate.skillId, candidate);
      }
    },
  };
}

/** 候補の一覧から、探索に渡す形にまとめる。 */
function collect(
  best: ReadonlyMap<string, Candidate>,
  screen: ReturnType<typeof createScreen>,
  alwaysSkillIds: readonly string[],
): PlanCandidates {
  const entries = [...best.values()].sort((a, b) => a.cost - b.cost);
  const hintLevels: Record<string, number> = {};
  const countByRoute: Record<Route, number> = {
    chara: 0, hint: 0, inherit: 0, inheritedUnique: 0, any: 0,
  };
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
    droppedByIgnored: [...new Set(screen.byIgnored)],
    droppedByFidelity: [...new Set(screen.byFidelity)],
  };
}

/**
 * 買えるスキル全体を候補にする。
 *
 * 育成計画は「このデッキで何が取れるか」を問う。こちらはその縛りを外し、
 * 「取れるとしたら何が効くか」を問う。数百の候補になるのでブラウザでは
 * 回しきれず、サーバ側の探索（docs/server-design.md 1 節）で初めて意味を持つ。
 *
 * 割引は当てない。ヒントは誰のデッキに何があるかで決まり、経路を問わない以上
 * 仮定の置きようがないためである。費用は表示どおりの総額になる。
 */
export function buildAllSkillCandidates(
  skills: readonly SkillData[],
  setting: DerivedSetting,
  options: AllSkillOptions = {},
): PlanCandidates {
  const openWhites = options.openWhites ?? true;
  const openGolds = options.openGolds ?? true;
  const openInheritedUniques = options.openInheritedUniques ?? true;
  const screen = createScreen(setting, options);
  const { best, offer } = createOffer();

  for (const skill of skills) {
    if (skill.sp <= 0) continue;
    const kind =
      skill.rarity === 'normal' ? openWhites
      : skill.rarity === 'rare' ? openGolds
      : skill.rarity === 'inherit' ? openInheritedUniques
      : false;
    if (!kind) continue;
    if (!screen.usable(skill)) continue;
    offer({
      skillId: skill.id,
      name: skill.name,
      rarity: skill.rarity,
      route: 'any',
      cost: costOf(skill, 0),
      hintLevel: 0,
      source: null,
    });
  }

  return collect(best, screen, []);
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
  const screen = createScreen(setting, options);
  const usable = screen.usable;
  const { best, offer } = createOffer();

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

  return collect(best, screen, alwaysSkillIds);
}
