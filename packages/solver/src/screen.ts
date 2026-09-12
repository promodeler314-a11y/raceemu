import type { DerivedSetting } from '../../sim/src/setting.ts';
import { ignoreConditions } from '../../sim/src/skill/approximate.ts';
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

/**
 * 条件が「モデルが無視しているもの」だけでできているか。
 *
 * 本家は順位や他のウマ娘の顔ぶれに関わる条件を「満たしている前提」で落とす。
 * 落とされた条件しか持たないスキルは、どんな設定でも必ず発動する扱いになる。
 * 候補が 20 個のうちは表に出なかったが、数百個に広げると探索がこれを片端から拾う。
 * おひとり様と対抗意識のように、同時には成り立たないものまで一緒に積まれる。
 *
 * 判定に要る情報をモデルが持っていない以上、正しく判定することはできない。
 * できるのは、どれがそうなのかを示して、外す口を用意することである。
 * docs/solver-design.md 4 節と 8 節を参照。
 */
export function dependsOnlyOnIgnored(skill: SkillData, setting: DerivedSetting): boolean {
  const groups = skill.invokes.flatMap((invoke) => [...invoke.preConditions, ...invoke.conditions]);
  if (groups.length === 0) return false;
  return groups.every((group) =>
    group.every(
      (condition) =>
        staticConditionTarget(condition.type, setting) === null &&
        condition.type in ignoreConditions,
    ),
  );
}
