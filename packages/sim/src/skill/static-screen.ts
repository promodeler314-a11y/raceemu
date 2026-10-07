import type { DerivedSetting } from '../setting.ts';
import { staticConditionTarget } from './condition.ts';
import type { SkillCondition, SkillData } from './types.ts';

/**
 * 出走前に値が決まる条件だけを見て、発動しようがないスキルを見分ける。
 *
 * 判定は `packages/solver/src/screen.ts` の `canTrigger` と同じである。sim は solver を
 * import できないので、名簿の相手（`field/opponent-roster.ts`）が使う分をここに置いた。
 * 片側だけ確かで、false なら確かに発動しないが、true でも発動するとは限らない。
 */
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
export function canTriggerStatic(skill: SkillData, setting: DerivedSetting): boolean {
  return skill.invokes.some(
    (invoke) =>
      listPossible(invoke.preConditions, setting) && listPossible(invoke.conditions, setting),
  );
}
