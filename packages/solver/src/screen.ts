import type { DerivedSetting } from '../../sim/src/setting.ts';
import { ignoreConditions } from '../../sim/src/skill/approximate.ts';
import { staticConditionTarget } from '../../sim/src/skill/condition.ts';
import {
  canTriggerStatic,
  staticScreenContext,
  type StaticScreenContext,
} from '../../sim/src/skill/static-screen.ts';
import type { SkillData } from '../../sim/src/skill/types.ts';

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
 *
 * 判定の本体は `packages/sim/src/skill/static-screen.ts` にある。名簿の相手も同じものを使う。
 */

export type ScreenContext = StaticScreenContext;

/**
 * 判定の前提を作る。`pool` には一緒に持ちうる候補をすべて渡す。
 *
 * 人気は、人気条件を無視させる効果（「All-in!!」）を設定か候補のどれかが持ちうるなら
 * 判定しない。持っているだけで人気の条件が満たされるので、人気で落とすと片側の保証が崩れる。
 */
export function screenContext(setting: DerivedSetting, pool: Iterable<SkillData> = []): ScreenContext {
  return staticScreenContext(setting, pool);
}

/**
 * この設定で発動しうるか。発動しようがないときだけ false を返す。
 *
 * `context` を省くと「このスキルを 1 つ足したとき」の前提で判定する。
 */
export function canTrigger(skill: SkillData, setting: DerivedSetting, context?: ScreenContext): boolean {
  return canTriggerStatic(skill, setting, context);
}

/** 発動しようがないものを落とす。渡したスキルが互いに一緒に持たれうるものとして判定する。 */
export function screenSkills(
  skills: Iterable<SkillData>,
  setting: DerivedSetting,
): SkillData[] {
  const list = [...skills];
  const context = screenContext(setting, list);
  return list.filter((skill) => canTrigger(skill, setting, context));
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
 *
 * スキルごとの印（`packages/sim/src/skill/classify.ts`）とは別物である。
 * こちらは**すべての条件が無視されている**ものを候補から外すための判定で、
 * あちらは**どれか 1 つでも近似か切り落としがある**ものに印を出す。
 * 候補に残ったスキルにも印は付く。
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
