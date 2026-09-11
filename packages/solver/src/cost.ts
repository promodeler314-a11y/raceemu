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

  const cost = (skillId: string): number => {
    const skill = skills.get(skillId);
    if (skill === undefined) return 0;
    const level = hintLevels[skillId] ?? 0;
    const factor = skillLvToFactor[Math.max(0, Math.min(skillLvToFactor.length - 1, level))]!;
    return Math.trunc(skill.sp * factor);
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
