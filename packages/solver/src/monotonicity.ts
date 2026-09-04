import { RaceCalculator } from '../../sim/src/calculator.ts';
import type { RaceTrack } from '../../sim/src/data/track.ts';
import type { RaceSetting, SystemSetting } from '../../sim/src/setting.ts';
import { achieved, withStatus, type Goal, type TargetStatus } from './target.ts';

/**
 * 1 試行の中でステータスを増やしたとき、目標の達成が単調に変わるかを検査する。
 *
 * 乱数はストリームごとに分けてあるので、同じ試行番号ならステータス以外の
 * 出目は変わらない。したがって達成の並びは 0 が続いてから 1 が続く形に
 * なるはずである。そうならない箇所が反転であり、その頻度と幅を測る。
 * docs/solver-design.md 2.3 節を参照。
 */
export interface MonotonicityOptions {
  readonly status: TargetStatus;
  readonly goal: Goal;
  readonly from: number;
  readonly to: number;
  readonly step: number;
  readonly trials: number;
  readonly seed?: number;
}

export interface MonotonicityReport {
  /** 調べた試行数 */
  readonly trials: number;
  /** 1 試行あたりに調べたステータスの点数 */
  readonly points: number;
  /** 達成が 0 のままだった試行数 */
  readonly neverAchieved: number;
  /** 達成が 1 のままだった試行数 */
  readonly alwaysAchieved: number;
  /** 反転を 1 つ以上含む試行数 */
  readonly trialsWithInversion: number;
  /** 反転の総数 */
  readonly inversions: number;
  /** 反転の幅の最大値（ステータスの値で） */
  readonly widestInversion: number;
  /** 単調だった試行における臨界値 */
  readonly criticalValues: number[];
}

export function checkMonotonicity(
  setting: RaceSetting,
  system: SystemSetting,
  trackData: Record<number, RaceTrack>,
  options: MonotonicityOptions,
): MonotonicityReport {
  const calculator = new RaceCalculator(system, trackData);
  const seed = options.seed ?? 1;
  const values: number[] = [];
  for (let value = options.from; value <= options.to; value += options.step) values.push(value);

  let neverAchieved = 0;
  let alwaysAchieved = 0;
  let trialsWithInversion = 0;
  let inversions = 0;
  let widestInversion = 0;
  const criticalValues: number[] = [];

  for (let trial = 0; trial < options.trials; trial++) {
    const flags = values.map((value) => {
      const result = calculator.simulate(withStatus(setting, options.status, value), {
        seed,
        trial,
      }).result;
      return achieved(options.goal, result);
    });

    let trialInversions = 0;
    let widest = 0;
    for (let i = 0; i + 1 < flags.length; i++) {
      if (flags[i] === true && flags[i + 1] === false) {
        trialInversions++;
        // 反転が終わるまでの幅を測る
        let j = i + 1;
        while (j < flags.length && flags[j] === false) j++;
        widest = Math.max(widest, (j - i - 1) * options.step);
      }
    }
    if (trialInversions > 0) {
      trialsWithInversion++;
      inversions += trialInversions;
      widestInversion = Math.max(widestInversion, widest);
    }

    const first = flags.indexOf(true);
    if (first < 0) neverAchieved++;
    else if (first === 0) alwaysAchieved++;
    if (first >= 0 && trialInversions === 0) criticalValues.push(values[first]!);
  }

  return {
    trials: options.trials,
    points: values.length,
    neverAchieved,
    alwaysAchieved,
    trialsWithInversion,
    inversions,
    widestInversion,
    criticalValues,
  };
}
