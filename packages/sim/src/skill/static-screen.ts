import type { DerivedSetting } from '../setting.ts';
import { staticConditionTarget } from './condition.ts';
import type { SkillCondition, SkillData } from './types.ts';

/**
 * 出走前に値が決まる条件だけを見て、発動しようがないスキルを見分ける。
 *
 * `packages/solver/src/screen.ts` の `canTrigger` もこれを呼ぶ。sim は solver を
 * import できないので、名簿の相手（`field/opponent-roster.ts`）と共通の本体をここに置いた。
 * 片側だけ確かで、false なら確かに発動しないが、true でも発動するとは限らない。
 */

/**
 * 判定の前提。どのスキルと一緒に持ちうるかで答えが変わる条件のために要る。
 *
 * いまは人気だけである。人気は出走前に決まるが、「All-in!!」のように人気条件を
 * 無視させる効果（`Invoke.isIgnorePopularity`）を一緒に持つと、レース中に満たす側へ倒れる
 * （`condition.ts` の `popularity`）。無視されうるときに人気で落とすと、発動するものを落とす。
 */
export interface StaticScreenContext {
  /** 人気の条件を人気の値どおりに判定してよいか。無視されうるなら false。 */
  readonly popularityFixed: boolean;
}

function groupPossible(
  group: readonly SkillCondition[],
  setting: DerivedSetting,
  context: StaticScreenContext,
): boolean {
  return group.every((condition) => {
    if (condition.type === 'popularity') {
      return !context.popularityFixed || condition.check(setting.base.uma.popularity);
    }
    const target = staticConditionTarget(condition.type, setting);
    return target === null || condition.check(target);
  });
}

function listPossible(
  groups: readonly SkillCondition[][],
  setting: DerivedSetting,
  context: StaticScreenContext,
): boolean {
  if (groups.length === 0) return true;
  return groups.some((group) => groupPossible(group, setting, context));
}

/** 人気を判定しない前提。人気を無視させる効果の判定そのものに使う（循環させない）。 */
const POPULARITY_OPEN: StaticScreenContext = { popularityFixed: false };

/**
 * このスキルが、この設定で人気条件を無視させうるか。
 *
 * 本家の `applyPassive` は、効果を持つ枠の `check`（conditions）だけを見て旗を立て、
 * preConditions は見ない。「All-in!!」なら説明文の「阪神 2200m かロンシャン」は
 * preConditions にあるので、旗は中距離ならどこでも立つ。ここも conditions だけを見る。
 */
function mayIgnorePopularity(skill: SkillData, setting: DerivedSetting): boolean {
  return skill.invokes.some(
    (invoke) => invoke.isIgnorePopularity && listPossible(invoke.conditions, setting, POPULARITY_OPEN),
  );
}

/**
 * 判定の前提を作る。
 *
 * `pool` には、判定するスキルと一緒に持ちうるスキルをすべて渡す。設定がすでに持っている
 * スキル（`setting.base.skills`）は渡さなくても数える。どれかが人気条件を無視させうるなら、
 * 人気では落とさない。
 */
export function staticScreenContext(
  setting: DerivedSetting,
  pool: Iterable<SkillData> = [],
): StaticScreenContext {
  for (const skill of setting.base.skills) {
    if (mayIgnorePopularity(skill, setting)) return POPULARITY_OPEN;
  }
  for (const skill of pool) {
    if (mayIgnorePopularity(skill, setting)) return POPULARITY_OPEN;
  }
  return { popularityFixed: true };
}

/**
 * この設定で発動しうるか。発動しようがないときだけ false を返す。
 *
 * `context` を省くと、「このスキルを設定に 1 つ足したとき」の前提（設定が持っているスキルと
 * このスキル自身）で判定する。候補の組み合わせを探すときは、候補全体から作った前提を渡す。
 */
export function canTriggerStatic(
  skill: SkillData,
  setting: DerivedSetting,
  context: StaticScreenContext = staticScreenContext(setting, [skill]),
): boolean {
  return skill.invokes.some(
    (invoke) =>
      listPossible(invoke.preConditions, setting, context) &&
      listPossible(invoke.conditions, setting, context),
  );
}
