import { RaceCalculator } from '../../sim/src/calculator.ts';
import type { RaceTrack } from '../../sim/src/data/track.ts';
import type { RaceSetting, SystemSetting } from '../../sim/src/setting.ts';
import { ADJUSTMENT_COUNT_BUCKETS } from '../../sim/src/state.ts';
import { achieved, withStatus, type Goal, type TargetStatus } from './target.ts';

export { ADJUSTMENT_COUNT_BUCKETS };

/**
 * 試行ごとの臨界値を求める。
 *
 * 乱数をストリームごとに分けてあるので、1 つの試行の中では逆算するステータス
 * 以外の出目が固定される。その試行で目標を満たす最小のステータスが臨界値であり、
 * 試行を集めればその分布が得られる。達成率 p の必要値は分布の p 分位点になる。
 * docs/solver-design.md 2.2 節を参照。
 */
export type CriticalMethod = 'auto' | 'bisect' | 'scan';

export interface CriticalOptions {
  readonly status: TargetStatus;
  readonly goal: Goal;
  readonly from: number;
  readonly to: number;
  readonly step: number;
  /**
   * 探し方。auto は目標に応じて選ぶ。
   *
   * 最大スパートは 1 試行の中で単調に変わることを実測で確かめてあるので
   * 二分探索でよい。完走は単調ではない。最大スパートに切り替わる位置で
   * 一度だけ体力が尽きる帯ができるため、二分探索は 2 割の試行で
   * 平均 345 も高い値を返す。そのため全走査にする。
   * docs/m5-report.md を参照。
   */
  readonly method?: CriticalMethod;
  /**
   * 二分探索で見つけた境界の左をこの点数ぶん調べ、反転があれば全走査に切り替える。
   * 境界から離れた反転は捕まえられないので、これは保険であって保証ではない。
   */
  readonly verifyWindow?: number;
}

export function resolveMethod(options: CriticalOptions): 'bisect' | 'scan' {
  const method = options.method ?? 'auto';
  if (method !== 'auto') return method;
  return options.goal.kind === 'maxSpurt' ? 'bisect' : 'scan';
}

export interface CriticalOutcome {
  /** 目標を満たす最小のステータス。範囲内で満たせなければ NaN。 */
  readonly value: number;
  /** 二分探索の結果が単調性の確認で覆り、全走査に切り替えたか */
  readonly fellBack: boolean;
  /** この試行で走らせたレースの数 */
  readonly races: number;
}

function makeValues(options: CriticalOptions): number[] {
  const values: number[] = [];
  for (let value = options.from; value <= options.to; value += options.step) values.push(value);
  return values;
}

/** 1 試行ぶんの臨界値を求める。 */
export function criticalValueForTrial(
  calculator: RaceCalculator,
  setting: RaceSetting,
  seed: number,
  trial: number,
  options: CriticalOptions,
  values = makeValues(options),
): CriticalOutcome {
  let races = 0;
  const test = (index: number): boolean => {
    races++;
    const result = calculator.simulate(withStatus(setting, options.status, values[index]!), {
      seed,
      trial,
    }).result;
    return achieved(options.goal, result);
  };

  if (resolveMethod(options) === 'scan') {
    return scan(calculator, setting, seed, trial, options, values, races);
  }

  const last = values.length - 1;
  if (test(0)) return { value: values[0]!, fellBack: false, races };
  if (!test(last)) return { value: Number.NaN, fellBack: false, races };

  // ここから、達成しない添字 lo と達成する添字 hi の間を詰める
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (test(mid)) hi = mid;
    else lo = mid;
  }

  const window = options.verifyWindow ?? 3;
  if (window > 0) {
    // 境界の左側が本当にすべて未達成かを確かめる。
    // 反転があれば二分探索の前提が崩れているので、全走査でやり直す。
    for (let i = Math.max(0, hi - window); i < hi; i++) {
      if (test(i)) {
        return scan(calculator, setting, seed, trial, options, values, races);
      }
    }
  }
  return { value: values[hi]!, fellBack: false, races };
}

/** 全走査。反転があっても、達成する最小の値を必ず返す。 */
function scan(
  calculator: RaceCalculator,
  setting: RaceSetting,
  seed: number,
  trial: number,
  options: CriticalOptions,
  values: number[],
  racesSoFar: number,
): CriticalOutcome {
  let races = racesSoFar;
  for (let i = 0; i < values.length; i++) {
    races++;
    const result = calculator.simulate(withStatus(setting, options.status, values[i]!), {
      seed,
      trial,
    }).result;
    if (achieved(options.goal, result)) {
      return { value: values[i]!, fellBack: racesSoFar > 0, races };
    }
  }
  return { value: Number.NaN, fellBack: racesSoFar > 0, races };
}

export interface CriticalDistribution {
  /** 各試行の臨界値。達成できなかった試行は NaN。 */
  readonly values: Float64Array;
  readonly trials: number;
  /** 範囲内では目標を満たせなかった試行の数 */
  readonly unreachable: number;
  /** 全走査に切り替えた試行の数 */
  readonly fellBack: number;
  readonly races: number;
}

export function criticalDistribution(
  setting: RaceSetting,
  system: SystemSetting,
  trackData: Record<number, RaceTrack>,
  options: CriticalOptions,
  seed: number,
  from: number,
  count: number,
): CriticalDistribution {
  const calculator = new RaceCalculator(system, trackData);
  const values = makeValues(options);
  const out = new Float64Array(count);
  let unreachable = 0;
  let fellBack = 0;
  let races = 0;
  for (let i = 0; i < count; i++) {
    const outcome = criticalValueForTrial(calculator, setting, seed, from + i, options, values);
    out[i] = outcome.value;
    if (Number.isNaN(outcome.value)) unreachable++;
    if (outcome.fellBack) fellBack++;
    races += outcome.races;
  }
  return { values: out, trials: count, unreachable, fellBack, races };
}

/**
 * 臨界値の分布から、達成率ごとの必要値を読む。
 * 達成できなかった試行は最も大きい側として扱う。
 */
export function requiredValue(values: Float64Array, rate: number): number {
  const sorted = [...values].sort((a, b) => {
    if (Number.isNaN(a)) return 1;
    if (Number.isNaN(b)) return -1;
    return a - b;
  });
  const index = Math.ceil(rate * sorted.length) - 1;
  const picked = sorted[Math.max(0, Math.min(sorted.length - 1, index))];
  return picked === undefined ? Number.NaN : picked;
}

export function achievementCurve(
  values: Float64Array,
  rates: readonly number[] = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99],
): { rate: number; value: number }[] {
  return rates.map((rate) => ({ rate, value: requiredValue(values, rate) }));
}

/**
 * 1 試行ぶんの、位置取り調整の回数ごとの臨界値を求める。
 *
 * 調整が起きるかどうかは、その時点の残りスタミナで決まる分岐（持久力温存に
 * 入るかどうか）に左右されるため、逆算するステータスの値によって同じ試行でも
 * 調整の回数が変わりうる。回数ごとに最小値を求めておけば「調整が k 回だけ
 * 起きた場合に必要な値」を段階的に示せる。二分探索では回数が拾えないので、
 * 常に全走査になる。
 */
export function criticalValuesByAdjustmentCountForTrial(
  calculator: RaceCalculator,
  setting: RaceSetting,
  seed: number,
  trial: number,
  options: CriticalOptions,
  values = makeValues(options),
): { byCount: Float64Array; races: number } {
  const byCount = new Float64Array(ADJUSTMENT_COUNT_BUCKETS).fill(Number.NaN);
  let races = 0;
  let filled = 0;
  for (let i = 0; i < values.length && filled < ADJUSTMENT_COUNT_BUCKETS; i++) {
    races++;
    const result = calculator.simulate(withStatus(setting, options.status, values[i]!), { seed, trial }).result;
    if (!achieved(options.goal, result)) continue;
    const bucket = Math.min(result.positionCompetitionCount, ADJUSTMENT_COUNT_BUCKETS - 1);
    if (Number.isNaN(byCount[bucket]!)) {
      byCount[bucket] = values[i]!;
      filled++;
    }
  }
  return { byCount, races };
}

export interface CriticalDistributionByAdjustmentCount {
  /** 試行ごとに ADJUSTMENT_COUNT_BUCKETS 個ずつ並ぶ。 */
  readonly values: Float64Array;
  readonly trials: number;
  readonly races: number;
}

export function criticalDistributionByAdjustmentCount(
  setting: RaceSetting,
  system: SystemSetting,
  trackData: Record<number, RaceTrack>,
  options: CriticalOptions,
  seed: number,
  from: number,
  count: number,
): CriticalDistributionByAdjustmentCount {
  const calculator = new RaceCalculator(system, trackData);
  const values = makeValues(options);
  const out = new Float64Array(count * ADJUSTMENT_COUNT_BUCKETS);
  let races = 0;
  for (let i = 0; i < count; i++) {
    const trialResult = criticalValuesByAdjustmentCountForTrial(calculator, setting, seed, from + i, options, values);
    out.set(trialResult.byCount, i * ADJUSTMENT_COUNT_BUCKETS);
    races += trialResult.races;
  }
  return { values: out, trials: count, races };
}

/** ADJUSTMENT_COUNT_BUCKETS 個ずつ並んだ配列から、調整の回数 k の分布だけを取り出す。 */
export function pickAdjustmentCount(byCountValues: Float64Array, count: number): Float64Array {
  const trials = byCountValues.length / ADJUSTMENT_COUNT_BUCKETS;
  const out = new Float64Array(trials);
  for (let i = 0; i < trials; i++) out[i] = byCountValues[i * ADJUSTMENT_COUNT_BUCKETS + count]!;
  return out;
}
