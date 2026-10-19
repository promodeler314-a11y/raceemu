import { skillLvToFactor } from '../../sim/src/data/constants.ts';
import type { SkillData } from '../../sim/src/skill/types.ts';

/**
 * スキルポイントの費用。
 *
 * 表示されているポイントは、そのスキルを持つまでに要する総額である。
 * たとえば「右回りの鬼」は 330 で、下位の「右回り○」90 と「右回り◎」200 を
 * 含んでいる（330 = 90 + 200 + 鬼のぶん 40）。
 * したがって同じグループから 2 つ取ることはなく、上位に乗り換える費用は差額になる。
 *
 * ヒントレベルによる割引は、レベルごとの係数を掛けて求める。
 * 既定はレベル 0、つまり割引なしである。
 *
 * 継承進化のスキル（rarity 'special'、例 91101411 光れ！弾けろ！超新星爆発！）は
 * skills.json に sp が無く、SkillData では 0 になる。これは継承版（同じ group の
 * rarity 'inherit'、例 901411）を買って進化させるものなので、継承版の値段で数える。
 * ヒントレベルは、継承進化のスキル自身の ID に指定があればそれを使い、無ければ継承版の ID のものを使う。
 * ヒントは買える側（継承版）に付くもので、進化にポイントはかからないからである。
 * 継承版が見つからなければ 0 のまま。
 * 継承版と継承進化は同じグループなので、両方を挙げても総額は 1 つぶんである。
 */
export interface CostModel {
  /** スキル ID から、そのスキルを持つまでの総額 */
  cost(skillId: string): number;
  /** 候補の集合の総額。同じグループからは最も高いものだけを数える。 */
  totalCost(skillIds: readonly string[]): number;
  /** スキル ID からグループ番号 */
  group(skillId: string): number;
  /** スキル ID からレア度。固有の継承版だけ本数に上限があるので、探索が見る。 */
  rarity(skillId: string): string;
}

export interface CostOptions {
  /** スキル ID からヒントレベル（0 から 5）。指定が無ければ 0。 */
  readonly hintLevels?: Readonly<Record<string, number>>;
}

export function createCostModel(
  skills: ReadonlyMap<string, SkillData>,
  options: CostOptions = {},
): CostModel {
  const hintLevels = options.hintLevels ?? {};

  // 継承進化の値段の元になる継承版。使うときまで引かない（継承進化を数えない呼び出しが大半）。
  let inheritByGroup: Map<number, SkillData> | undefined;
  /** 継承進化なら、値段とヒントの元になる継承版。それ以外と、継承版が無い継承進化は undefined。 */
  const inheritOf = (skill: SkillData): SkillData | undefined => {
    if (skill.sp > 0 || skill.rarity !== 'special') return undefined;
    if (inheritByGroup === undefined) {
      inheritByGroup = new Map();
      for (const candidate of skills.values()) {
        if (candidate.rarity === 'inherit' && !inheritByGroup.has(candidate.group)) {
          inheritByGroup.set(candidate.group, candidate);
        }
      }
    }
    return inheritByGroup.get(skill.group);
  };

  const cost = (skillId: string): number => {
    const skill = skills.get(skillId);
    if (skill === undefined) return 0;
    const source = inheritOf(skill);
    const level = hintLevels[skillId] ?? (source === undefined ? undefined : hintLevels[source.id]) ?? 0;
    const factor = skillLvToFactor[Math.max(0, Math.min(skillLvToFactor.length - 1, level))]!;
    return Math.trunc((source ?? skill).sp * factor);
  };

  const group = (skillId: string): number => skills.get(skillId)?.group ?? -1;

  return {
    cost,
    group,
    rarity: (skillId) => skills.get(skillId)?.rarity ?? '',
    totalCost: (skillIds) => {
      // 同じグループの中では、最も高いもの（最も上位のもの）だけを数える。
      const best = new Map<number, number>();
      for (const id of skillIds) {
        const g = group(id);
        const c = cost(id);
        if (c > (best.get(g) ?? 0)) best.set(g, c);
      }
      let total = 0;
      for (const value of best.values()) total += value;
      return total;
    },
  };
}

/** 同じグループのスキルを 1 つに絞る。上位（表示ポイントの高いもの）を残す。 */
export function dedupeByGroup(skillIds: readonly string[], model: CostModel): string[] {
  const best = new Map<number, string>();
  for (const id of skillIds) {
    const g = model.group(id);
    const current = best.get(g);
    if (current === undefined || model.cost(id) > model.cost(current)) best.set(g, id);
  }
  return [...best.values()];
}
