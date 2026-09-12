import type { DerivedSetting } from '../../sim/src/setting.ts';
import { staticConditionTarget } from '../../sim/src/skill/condition.ts';
import type { SkillCondition, SkillData } from '../../sim/src/skill/types.ts';

/**
 * 走らせずに候補から外せるスキルを落とす。
 *
 * 育成計画から探索を始めると、候補は手持ちのスキル表ではなく、購入できる
 * スキル全体になる。その大半は、距離種別や脚質が噛み合わずそもそも発動しない。
 * 発動条件のうちレース前に値が決まるものだけを見れば、1 レースも走らせずに
 * それを判定できる。docs/solver-design.md 7.3 節を参照。
 *
 * 判定は片側だけ確かである。ここで落としたものは確かに発動しないが、
 * 残ったものが発動するとは限らない。走ってみないと決まらない条件は
 * 満たされうるものとして扱う。
 */

/** 条件の並びは、グループ内が「かつ」、グループどうしが「または」である。 */
function groupPossible(group: readonly SkillCondition[], setting: DerivedSetting): boolean {
  return group.every((condition) => {
    const target = staticConditionTarget(condition.type, setting);
    return target === null || condition.check(target);
  });
}

function listPossible(groups: readonly SkillCondition[][], setting: DerivedSetting): boolean {
  if (groups.length === 0) return true;
  return groups.some((group) => groupPossible(group, setting));
}

/** この設定で発動しうるか。発動しようがないときだけ false を返す。 */
export function canTrigger(skill: SkillData, setting: DerivedSetting): boolean {
  return skill.invokes.some(
    (invoke) =>
      listPossible(invoke.preConditions, setting) && listPossible(invoke.conditions, setting),
  );
}

/** 発動しようがないものを落とす。 */
export function screenSkills(
  skills: Iterable<SkillData>,
  setting: DerivedSetting,
): SkillData[] {
  return [...skills].filter((skill) => canTrigger(skill, setting));
}
