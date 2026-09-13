import { orderRateBoundaries, resolveOrderRateContinue } from '../data/orderRate.ts';
import { FIELD_COMPUTED_TYPES } from '../field/conditions.ts';
import type { DerivedSetting } from '../setting.ts';
import { approximateConditions, approximateTypeToState, ignoreConditions } from './approximate.ts';
import { orderRateContinueTypes, staticConditionTarget } from './condition.ts';
import type { SkillCondition, SkillData } from './types.ts';

/**
 * スキルを「どこまで本当に判定しているか」で分類する。
 *
 * `unsupportedConditions` は実行中に貯まるグローバルな集合で、どのスキルが
 * どの条件を落としたのかを持っていない。結果の表でスキルごとに印を出すには
 * スキル単位の分類が要る。docs/roadmap.md 4.3 節を参照。
 *
 * **分類はレースを回さなくても決まる。** 条件式とレース設定（コース、脚質、
 * 頭数、順位条件を判定するかどうか）だけで決まり、出目には依らない。
 * そのため Worker 境界を越えて運ぶ必要が無く、画面側でも CLI でも同じ答えになる。
 *
 * 分類の境目は `compileCondition`（condition.ts）の枝と一対一に対応させてある。
 * 実装を足したり落としたりしたら、こちらの表も直す。ずれていないかは
 * `packages/sim/test/skill-fidelity.test.ts` が、実際にコンパイルして貯まる
 * `unsupportedConditions` と突き合わせて見張っている。
 */

/**
 * 条件 1 つの再現度。
 *
 * - `exact`：条件式のとおりに判定している。
 * - `approximate`：判定はするが、相手の位置や接触を確率で置き換えている、
 *   または作り物の相手（フィールド）に対して判定している。
 * - `dropped`：条件を落としている。落とした条件は**満たしている扱い**になるので、
 *   発動率は必ず本来より高く出る。
 */
export type Fidelity = 'exact' | 'approximate' | 'dropped';

/** 印。CLI と画面で同じものを使う。 */
export const FIDELITY_MARK: Readonly<Record<Fidelity, string>> = {
  exact: '',
  approximate: '△',
  dropped: '▲',
};

export const FIDELITY_LABEL: Readonly<Record<Fidelity, string>> = {
  exact: '条件どおりに判定している',
  approximate: '確率近似、または作り物の相手に対して判定している',
  dropped: '条件を落としている（満たしている扱いになり、発動率が高く出る）',
};

/** 悪いほうを残すための順序。落としている > 近似 > 完全。 */
const SEVERITY: Readonly<Record<Fidelity, number>> = { exact: 0, approximate: 1, dropped: 2 };

export function worseFidelity(a: Fidelity, b: Fidelity): Fidelity {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/** 条件 1 つの分類と、その理由。理由はそのまま画面の説明に出す。 */
export interface FidelityNote {
  readonly type: string;
  readonly fidelity: Fidelity;
  readonly reason: string;
}

/** スキル 1 つの分類。`fidelity` は条件のうち最も悪いものである。 */
export interface SkillFidelity {
  readonly skillId: string;
  readonly fidelity: Fidelity;
  /** `exact` でない条件だけを、型ごとに 1 つずつ。 */
  readonly notes: readonly FidelityNote[];
}

export interface FidelityOptions {
  /**
   * 順位条件を実際に判定するか（フィールドを渡すか）。
   *
   * 渡さないときは本家と同じ単騎で、順位と距離差の族はまるごと落ちる。
   * 渡すときは判定するが、相手は作り物なので近似にとどまる。
   */
  readonly hasField: boolean;
}

/**
 * 本家も移植版も実装していない条件の型。
 *
 * `compileCondition` の `default` に落ち、`unsupportedConditions` に貯まる。
 * ここに載せておくのは、走らせる前から「この型は落ちる」と分かるようにするためである。
 * `packages/sim/test/skill-coverage.test.ts` がこの表と実際に貯まる集合を突き合わせる。
 */
export const knownUnsupportedTypes: readonly string[] = ['succession_skill_count'];

/** 順位と距離差の族。フィールドを渡したときだけ判定できる。 */
const FIELD_DEPENDENT_TYPES: ReadonlySet<string> = new Set([
  'order',
  'distance_diff_top',
  'distance_diff_top_float',
  'bashin_diff_infront',
  'bashin_diff_behind',
  'distance_diff_rate',
]);

/** 他のウマ娘のスキル発動。値ごとの近似が approximate.ts にある。 */
const OTHER_CHARACTER_SKILL_TYPES: ReadonlySet<string> = new Set([
  'is_other_character_activate_advantage_skill',
  'is_popularity_top_character_activate_advantage_skill',
]);

const NO_FIELD_REASON = '順位や距離差の条件。フィールドを渡していないので、満たしている扱いになる';
const ORDER_FIELD_REASON =
  '順位は判定しているが、相手は作り物の束である。順位率の対応表もスキルデータの注記からの読み取りで、ゲームと突き合わせていない';
const DIFF_FIELD_REASON =
  '距離差は判定しているが、相手は作り物の束である。バ身の換算（1 バ身 = 2.5 m）も注記からの読み取りである';
/**
 * 確率近似をやめて位置から計算するようにした型の理由。
 *
 * 印は △ のままである。確率を引かなくなっても相手は作り物の束であり、
 * 「近く」を何メートルと置くかもゲームと突き合わせていないためである。
 * docs/order-field.md 8 節を参照。
 */
const FIELD_COMPUTED_REASON =
  '確率ではなく相手の位置から判定している。ただし相手は作り物の束で、「近く」の距離（既定 1 バ身）も読み取りである';

function approximateReason(condition: SkillCondition): string {
  // 他のウマ娘のスキル発動は、値ごとに別の近似を当てている。
  const key = OTHER_CHARACTER_SKILL_TYPES.has(condition.type)
    ? `is_other_character_activate_advantage_skill${condition.value}`
    : approximateTypeToState[condition.type];
  const approximation = key === undefined ? undefined : approximateConditions[key];
  if (approximation === undefined) return '他のウマ娘の振る舞いを確率で近似している';
  return `${approximation.displayName}を確率で近似している`;
}

/** 条件 1 つを分類する。走らせずに決まる。 */
export function classifyCondition(
  condition: SkillCondition,
  setting: DerivedSetting,
  options: FidelityOptions,
): FidelityNote {
  const type = condition.type;
  const note = (fidelity: Fidelity, reason: string): FidelityNote => ({ type, fidelity, reason });

  // レース前に値が決まる条件。compileCondition もこの表を先に通す。
  if (staticConditionTarget(type, setting) !== null) {
    // 交流重賞はレース場だけで判定している。格の情報を持っていない。
    if (type === 'is_dirtgrade') return note('approximate', ignoreConditions[type]!);
    return note('exact', '条件どおりに判定している');
  }

  if (type in approximateTypeToState) {
    // フィールドを渡していれば、位置から決まる型は確率を引かずに計算している。
    // 印は △ のままで、理由だけが変わる（FIELD_COMPUTED_REASON の注記）。
    if (options.hasField && FIELD_COMPUTED_TYPES.has(type)) {
      return note('approximate', FIELD_COMPUTED_REASON);
    }
    return note('approximate', approximateReason(condition));
  }
  if (OTHER_CHARACTER_SKILL_TYPES.has(type)) return note('approximate', approximateReason(condition));

  if (FIELD_DEPENDENT_TYPES.has(type)) {
    if (!options.hasField) return note('dropped', NO_FIELD_REASON);
    return note('approximate', type === 'order' ? ORDER_FIELD_REASON : DIFF_FIELD_REASON);
  }
  if (type === 'order_rate') {
    if (!options.hasField) return note('dropped', NO_FIELD_REASON);
    const key = `${condition.operator}:${condition.value}:${setting.base.track.gateCount}`;
    if (orderRateBoundaries[key] === undefined) {
      return note('dropped', `順位率の対応表に ${setting.base.track.gateCount} 頭立ての ${key} が無い`);
    }
    return note('approximate', ORDER_FIELD_REASON);
  }
  if (orderRateContinueTypes.has(type)) {
    if (!options.hasField) return note('dropped', NO_FIELD_REASON);
    if (resolveOrderRateContinue(type, setting.base.track.gateCount) === undefined) {
      return note('dropped', `順位率の対応表に ${setting.base.track.gateCount} 頭立ての ${type} が無い`);
    }
    return note('approximate', ORDER_FIELD_REASON);
  }

  // 前提スキルは、同じグループの強い方が発動したかで見ている。
  if (type === 'is_used_skill_id_with_detail_one') return note('approximate', ignoreConditions[type]!);

  if (type in ignoreConditions) return note('dropped', ignoreConditions[type]!);
  if (knownUnsupportedTypes.includes(type)) return note('dropped', '本家も移植版も未対応の条件');

  return note('exact', '条件どおりに判定している');
}

/**
 * スキル 1 つを分類する。
 *
 * 条件の並びはグループ内が「かつ」、グループどうしが「または」だが、
 * **最も悪い条件を全体の分類にする**。落とされた条件を含む枝があれば、
 * その枝からいくらでも発動しうるためである。
 */
export function classifySkill(
  skill: SkillData,
  setting: DerivedSetting,
  options: FidelityOptions,
): SkillFidelity {
  let fidelity: Fidelity = 'exact';
  const notes: FidelityNote[] = [];
  const seen = new Set<string>();
  for (const invoke of skill.invokes) {
    for (const group of [...invoke.preConditions, ...invoke.conditions]) {
      for (const condition of group) {
        const note = classifyCondition(condition, setting, options);
        if (note.fidelity === 'exact') continue;
        fidelity = worseFidelity(fidelity, note.fidelity);
        // 同じ型を何度も並べても読めないので、型ごとに 1 つだけ残す。
        if (seen.has(note.type)) continue;
        seen.add(note.type);
        notes.push(note);
      }
    }
  }
  // 落としている条件を先に読ませる。
  notes.sort((a, b) => SEVERITY[b.fidelity] - SEVERITY[a.fidelity]);
  return { skillId: skill.id, fidelity, notes };
}

export function classifySkills(
  skills: Iterable<SkillData>,
  setting: DerivedSetting,
  options: FidelityOptions,
): Map<string, SkillFidelity> {
  const result = new Map<string, SkillFidelity>();
  for (const skill of skills) result.set(skill.id, classifySkill(skill, setting, options));
  return result;
}
