import type { RaceTrack } from './data/track.ts';
import { RaceCalculator } from './calculator.ts';
import type { RaceSetting, SystemSetting } from './setting.ts';
import type { RaceSimulationResult } from './state.ts';

export interface SummaryEntry {
  readonly count: number;
  readonly averageTime: number;
  readonly bestTime: number;
  readonly worstTime: number;
  readonly medianTime: number;
  readonly averageSpDiff: number;
  readonly averageGoalSp: number;
}

export interface SimulationSummary {
  readonly all: SummaryEntry;
  readonly spurt: SummaryEntry;
  readonly notSpurt: SummaryEntry;
  readonly spurtRate: number;
  readonly finishRate: number;
  readonly elapsedMs: number;
}

const EMPTY: SummaryEntry = {
  count: 0,
  averageTime: Number.NaN,
  bestTime: Number.NaN,
  worstTime: Number.NaN,
  medianTime: Number.NaN,
  averageSpDiff: Number.NaN,
  averageGoalSp: Number.NaN,
};

function average(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function toSummaryEntry(results: readonly RaceSimulationResult[]): SummaryEntry {
  if (results.length === 0) return EMPTY;
  const times = results.map((r) => r.raceTime).sort((a, b) => a - b);
  return {
    count: results.length,
    averageTime: average(times),
    bestTime: times[0]!,
    worstTime: times[times.length - 1]!,
    medianTime: times[Math.floor(times.length / 2)]!,
    averageSpDiff: average(results.map((r) => r.spDiff)),
    averageGoalSp: average(results.map((r) => r.goalSp)),
  };
}

/** 実行済みの結果から統計をまとめる。 */
export function summarize(
  results: readonly RaceSimulationResult[],
  elapsedMs = Number.NaN,
): SimulationSummary {
  const spurt = results.filter((r) => r.maxSpurt);
  const notSpurt = results.filter((r) => !r.maxSpurt);
  return {
    all: toSummaryEntry(results),
    spurt: toSummaryEntry(spurt),
    notSpurt: toSummaryEntry(notSpurt),
    spurtRate: results.length === 0 ? Number.NaN : spurt.length / results.length,
    finishRate:
      results.length === 0 ? Number.NaN : results.filter((r) => r.goalSp >= 0).length / results.length,
    elapsedMs,
  };
}

export interface RunOptions {
  readonly count: number;
  readonly seed?: number;
}

/**
 * 同じ設定を指定回数だけ走らせて集計する。
 * 試行 i はシード (seed, i) で決まるので、同じ seed なら結果を再現できる。
 */
export function runSimulations(
  setting: RaceSetting,
  system: SystemSetting,
  trackData: Record<number, RaceTrack>,
  options: RunOptions,
): { summary: SimulationSummary; results: RaceSimulationResult[] } {
  const calculator = new RaceCalculator(system, trackData);
  const seed = options.seed ?? 1;
  const results: RaceSimulationResult[] = [];
  const started = performance.now();
  for (let trial = 0; trial < options.count; trial++) {
    results.push(calculator.simulate(setting, { seed, trial }).result);
  }
  const elapsedMs = performance.now() - started;
  return { summary: summarize(results, elapsedMs), results };
}
