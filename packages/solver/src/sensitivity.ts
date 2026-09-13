import { approximateTypeToState } from '../../sim/src/skill/approximate.ts';
import type { SerializableRaceSetting } from '../../sim/src/parallel/protocol.ts';
import { SimulationCancelled } from '../../sim/src/parallel/pool.ts';
import type { SkillData } from '../../sim/src/skill/types.ts';
import {
  Evaluator,
  pairedDiff,
  type Evaluation,
  type OptimizeContext,
  type PairedDiff,
} from './optimize.ts';

/**
 * 近似確率の感度分析。
 *
 * 他のウマ娘との接触や追い抜きは固定の確率で近似してある
 * （`packages/sim/src/skill/approximate.ts`）。その確率はゲームと突き合わせて
 * 確かめたものではないので、結果がどれだけその値に依っているかは分からない。
 * ここでは確率を既定の半分と倍にして走らせ、平均タイムとスキルごとの短縮量が
 * どれだけ動くかを幅として出す。幅が広いスキルは近似に依存しているので、
 * 探索の結果に「この差は近似の中に消える」と添えられる。
 * docs/solver-design.md 4 節と docs/roadmap.md 3.7 節を参照。
 *
 * **測り方はすべて共通乱数によるペア比較である。** 倍率を掛けても引く乱数の
 * 回数と順番は変わらないので（同ファイルの `scaleRate` の注記）、倍率どうしの
 * 比較も、スキルの有無の比較も、同じ試行番号の引き算で取れる。
 * 相手の束は倍率によらず同じものを使う。相手の位置は自分の近似状態に依らないので、
 * 作り直す理由が無く、作り直せばペア比較が崩れる。
 */

/** 既定で振る倍率。半分と倍、そのあいだに既定値を挟む。 */
export const DEFAULT_SCALES: readonly number[] = [0.5, 1.0, 2.0];

export interface SensitivityOptions {
  /** 幅を測るスキル。1 つずつ、入れた構成と入れない構成の差を取る。 */
  readonly candidates: readonly string[];
  /** 倍率 1 つ、構成 1 つあたりの試行数 */
  readonly trials?: number;
  /** 振る倍率。既定の 1.0 を必ず含めること（幅の基準にする）。 */
  readonly scales?: readonly number[];
  /**
   * スキルの実体。渡すと、発動条件に近似条件を含むかを結果に添える。
   * Worker には ID しか送らないので、ここでも省ける形にしてある。
   */
  readonly skillsById?: ReadonlyMap<string, SkillData>;
  readonly onProgress?: (message: string) => void;
  readonly signal?: AbortSignal;
}

/** 倍率 1 つぶんの、候補を持たない構成の成績 */
export interface ScaleSummary {
  readonly scale: number;
  readonly meanTime: number;
  readonly maxSpurtRate: number;
  /** 既定倍率から見た短縮量。正ならその倍率のほうが速い。 */
  readonly shift: PairedDiff;
}

/** スキル 1 つぶんの幅 */
export interface SkillSensitivity {
  readonly skillId: string;
  /** 倍率ごとの、そのスキルを入れた構成と入れない構成の差 */
  readonly byScale: readonly { readonly scale: number; readonly diff: PairedDiff }[];
  /** 既定倍率での短縮量 */
  readonly base: PairedDiff;
  /** 倍率をまたいだ短縮量の幅（最大 − 最小）。広いほど近似に依存している。 */
  readonly width: number;
  /**
   * 幅を、既定倍率の短縮量の誤差（標準誤差の 2 倍）で割ったもの。
   *
   * 幅そのものは試行数を増やしても縮まない（近似の値が違えば結果も違う）。
   * 誤差は試行数を増やせば縮む。両者の比が 1 を超えるなら、**その差は測り方の
   * 揺れではなく近似の置き方で動いている**ということである。
   * 誤差が 0 のとき（どの試行でも差が厳密に 0）は 0 を返す。
   */
  readonly widthPerError: number;
  /** 発動条件に近似条件を含むか。含まないのに幅が出たら、間接的な影響である。 */
  readonly approximate: boolean;
}

export interface SensitivityResult {
  readonly scales: readonly ScaleSummary[];
  readonly skills: readonly SkillSensitivity[];
  readonly trials: number;
  readonly races: number;
  readonly elapsedMs: number;
}

/**
 * このスキルが近似条件を見ているか。
 *
 * 条件型の表（`approximateTypeToState`）に載っている型を 1 つでも使っていれば真。
 * 判定を本番の計算と同じ表から引いているのは、表が増えたときに黙ってずれないようにするためである。
 */
export function dependsOnApproximate(skill: SkillData): boolean {
  for (const invoke of skill.invokes) {
    for (const group of [...invoke.conditions, ...invoke.preConditions]) {
      for (const condition of group) {
        if (condition.type in approximateTypeToState) return true;
      }
    }
  }
  return false;
}

/** 倍率ごとの評価器を作る。設定に数値を 1 つ足すだけで Worker まで届く。 */
function contextForScale(context: OptimizeContext, scale: number): OptimizeContext {
  const base: SerializableRaceSetting = { ...context.base, approximateRateScale: scale };
  return { ...context, base };
}

export async function measureSensitivity(
  context: OptimizeContext,
  options: SensitivityOptions,
): Promise<SensitivityResult> {
  const started = performance.now();
  const trials = options.trials ?? 1000;
  const scales = options.scales ?? DEFAULT_SCALES;
  const defaultIndex = scales.findIndex((scale) => scale === 1.0);
  if (defaultIndex < 0) {
    throw new Error('倍率の一覧には既定の 1.0 を含めること（幅の基準にする）');
  }
  const report = options.onProgress ?? (() => {});
  const abort = () => {
    if (options.signal?.aborted === true) throw new SimulationCancelled();
  };

  const candidates = [...new Set(options.candidates)];
  // 基準は候補を 1 つも取らない構成。既に持っているスキルはそのまま残す。
  const baseIds = context.base.skillIds.filter((id) => !candidates.includes(id));

  const evaluators = scales.map((scale) => new Evaluator(contextForScale(context, scale)));

  // 倍率ごとの基準。ここが平均タイムの幅になる。
  const baselines: Evaluation[] = [];
  for (const [index, scale] of scales.entries()) {
    abort();
    report(`倍率 ${scale.toFixed(2)}: 基準 ${trials} 試行`);
    baselines.push(await evaluators[index]!.evaluate(baseIds, trials));
  }

  const mean = (xs: Float64Array): number => {
    let sum = 0;
    for (const x of xs) sum += x;
    return xs.length === 0 ? Number.NaN : sum / xs.length;
  };
  const rate = (xs: Uint8Array): number => {
    let sum = 0;
    for (const x of xs) sum += x;
    return xs.length === 0 ? Number.NaN : sum / xs.length;
  };

  const scaleSummaries: ScaleSummary[] = scales.map((scale, index) => ({
    scale,
    meanTime: mean(baselines[index]!.times),
    maxSpurtRate: rate(baselines[index]!.maxSpurt),
    shift: pairedDiff(baselines[defaultIndex]!, baselines[index]!),
  }));

  // スキルごとの幅。倍率ごとに「入れた構成 − 入れない構成」を取り、その振れ幅を見る。
  const skills: SkillSensitivity[] = [];
  for (const [index, skillId] of candidates.entries()) {
    const skill = options.skillsById?.get(skillId);
    const byScale: { scale: number; diff: PairedDiff }[] = [];
    for (const [s, scale] of scales.entries()) {
      abort();
      const evaluation = await evaluators[s]!.evaluate([...baseIds, skillId], trials);
      byScale.push({ scale, diff: pairedDiff(baselines[s]!, evaluation) });
    }
    const means = byScale.map((x) => x.diff.mean);
    const base = byScale[defaultIndex]!.diff;
    const width = Math.max(...means) - Math.min(...means);
    const error = 2 * base.stdError;
    skills.push({
      skillId,
      byScale,
      base,
      width,
      widthPerError: error > 0 ? width / error : 0,
      approximate: skill === undefined ? false : dependsOnApproximate(skill),
    });
    report(`  スキル ${index + 1} / ${candidates.length}`);
  }

  let races = 0;
  for (const evaluator of evaluators) races += evaluator.races;

  return {
    scales: scaleSummaries,
    skills,
    trials,
    races,
    elapsedMs: performance.now() - started,
  };
}
