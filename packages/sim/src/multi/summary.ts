import type { MultiRaceOutput } from './race.ts';

/** 試行を重ねたときの、1 頭ぶんの着順の集計 */
export interface OrderSummary {
  readonly index: number;
  /** 着順ごとの回数。`counts[1]` が 1 着の回数。 */
  readonly counts: readonly number[];
  readonly trials: number;
  readonly winRate: number;
  /** 2 着以内 */
  readonly quinellaRate: number;
  /** 3 着以内 */
  readonly showRate: number;
  readonly meanOrder: number;
  readonly meanTime: number;
  readonly timeSd: number;
}

export class OrderTally {
  private readonly counts: number[][];
  private readonly timeSum: number[];
  private readonly timeSquareSum: number[];
  private trialCount = 0;

  constructor(private readonly gateCount: number) {
    this.counts = Array.from({ length: gateCount }, () => new Array(gateCount + 1).fill(0));
    this.timeSum = new Array(gateCount).fill(0);
    this.timeSquareSum = new Array(gateCount).fill(0);
  }

  add(output: MultiRaceOutput): void {
    for (const entry of output.entries) {
      this.counts[entry.index]![entry.order]!++;
      const time = entry.result.raceTime;
      this.timeSum[entry.index]! += time;
      this.timeSquareSum[entry.index]! += time * time;
    }
    this.trialCount++;
  }

  get trials(): number {
    return this.trialCount;
  }

  summarize(index: number): OrderSummary {
    const counts = this.counts[index]!;
    const trials = Math.max(1, this.trialCount);
    let meanOrder = 0;
    for (let order = 1; order <= this.gateCount; order++) meanOrder += order * counts[order]!;
    meanOrder /= trials;
    const mean = this.timeSum[index]! / trials;
    // 標本分散。試行が 1 回なら 0 とする。
    const variance =
      trials > 1 ? Math.max(0, (this.timeSquareSum[index]! - trials * mean * mean) / (trials - 1)) : 0;
    const within = (limit: number) => {
      let sum = 0;
      for (let order = 1; order <= limit; order++) sum += counts[order]!;
      return sum / trials;
    };
    return {
      index,
      counts: [...counts],
      trials: this.trialCount,
      winRate: within(1),
      quinellaRate: within(2),
      showRate: within(3),
      meanOrder,
      meanTime: mean,
      timeSd: Math.sqrt(variance),
    };
  }

  summarizeAll(): OrderSummary[] {
    return [...Array(this.gateCount).keys()].map((index) => this.summarize(index));
  }
}
