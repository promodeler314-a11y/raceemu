import type { RaceCalculator } from '../calculator.ts';
import type { RaceSetting } from '../setting.ts';
import { runMultiRace, type MultiEntry } from './race.ts';

/**
 * 全頭同時のレースで、1 頭の持ち物を変えた 2 案を、同じ相手・同じ乱数で並べて比べる。
 *
 * 基準（そのまま）と案（スキルを足した）を、同じ相手の組、同じ種、同じ試行番号で回し、
 * 試行ごとの差を取る共通乱数の対比較である。2 案を別々に回して勝率の差を取ると、
 * 相手の引き方と出目の揺れがそのまま差の誤差になる。対で取れば、足したスキルが
 * 順位を動かした試行だけが差として残る。
 *
 * **見る頭は出走表の先頭（0 番）である。** 2 案で違うのはその頭のスキルだけで、
 * 相手は同じ並びの同じ設定を渡す。0 番は `entrySeed` が種そのものを返すので、
 * 持ち物を変えても自分の出目の基になる種は変わらない。
 *
 * 乱数の消費がスキルの本数に依らないことは、`multi-crn.test.ts` が固定している
 * （発動しようがないスキルを足しても、全頭の着順とタイムが 1 ビットも変わらない）。
 * 発動するスキルを足すと、自分の位置が相手の位置取りに効くので、相手のタイムも動く。
 * 相手が完全に固定されるわけではないが、2 案は同じ種から出目を引くので、差は対で取れる。
 * 所持スキルの数で効果が増えるスキル（`SkillEffect.calcValue` の special = 2）を
 * 持つ頭は、発動しないスキルを足しても結果が変わる。それは乱数ではなく本家の仕様である。
 *
 * 計算は `runMultiRace` を呼ぶだけで、並列化はしない（1 つのスレッドで回る）。
 * 1 試行の費用は、9 頭で 2 案ぶん 60 ms ほどからで、相手が多くのスキルを持つと増える。
 */

/** 平均と標準誤差（n - 1 で割った標本分散から） */
export function meanAndSe(values: readonly number[]): { mean: number; se: number } {
  const n = values.length;
  if (n === 0) return { mean: 0, se: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { mean, se: 0 };
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return { mean, se: Math.sqrt(variance / n) };
}

/** 中央値。偶数個なら中央の 2 つの平均。空なら NaN。 */
export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 1 試行ぶんの対。見る頭（0 番）だけの値を持つ。 */
export interface PairedTrial {
  readonly baseOrder: number;
  readonly variantOrder: number;
  readonly baseTime: number;
  readonly variantTime: number;
  /**
   * 案の側で、追跡するスキルが最初に発動した位置（m）。`traceSkillIds` と同じ並び。
   * 発動しなかったスキルは NaN。
   */
  readonly firstPositions: readonly number[];
}

/**
 * 1 試行を 2 案で回す。
 *
 * `base` と `variant` は同じ頭数・同じ並びの出走表で、先頭だけが違う。
 * 出走順から導く種を使うので、`MultiEntry.seed` は付けない（`runMultiChunk` と同じ）。
 */
export function runPairedTrial(
  calculator: RaceCalculator,
  base: readonly MultiEntry[],
  variant: readonly MultiEntry[],
  options: { readonly seed: number; readonly trial: number; readonly traceSkillIds: readonly string[] },
): PairedTrial {
  if (base.length !== variant.length) {
    throw new Error(`2 案の出走頭数が違う: ${base.length} 頭と ${variant.length} 頭`);
  }
  const before = runMultiRace(calculator, base, { seed: options.seed, trial: options.trial });
  const after = runMultiRace(calculator, variant, { seed: options.seed, trial: options.trial });
  const trace = after.states[0]!.simulation.skillTrace;
  return {
    baseOrder: before.entries[0]!.order,
    variantOrder: after.entries[0]!.order,
    baseTime: before.entries[0]!.result.raceTime,
    variantTime: after.entries[0]!.result.raceTime,
    firstPositions: options.traceSkillIds.map((id) => trace.get(id)?.firstPosition ?? Number.NaN),
  };
}

export interface PairedArm {
  readonly winRate: number;
  readonly meanOrder: number;
  readonly meanTime: number;
}

export interface PairedDelta {
  readonly mean: number;
  /** 試行ごとの差から求めた標準誤差 */
  readonly se: number;
}

export interface PairedSkillTrace {
  readonly skillId: string;
  /** 案の側で 1 回でも発動した試行の割合 */
  readonly triggerRate: number;
  /** 最初の発動位置（m）の中央値。1 度も発動しなければ null。 */
  readonly medianFirstPosition: number | null;
}

export interface PairedGroupSummary {
  readonly index: number;
  readonly trials: number;
  readonly baseWinRate: number;
  readonly variantWinRate: number;
}

export interface PairedSummary {
  readonly trials: number;
  readonly base: PairedArm;
  readonly variant: PairedArm;
  /** 案 − 基準。正なら勝率が上がる。 */
  readonly deltaWinRate: PairedDelta;
  /** 案 − 基準。負なら着順が良くなる。 */
  readonly deltaMeanOrder: PairedDelta;
  /** 案 − 基準（秒）。負なら速くなる。 */
  readonly deltaMeanTime: PairedDelta;
  readonly skills: readonly PairedSkillTrace[];
  /** 相手の組ごとの勝率。組の選び方による揺れを読む手掛かり。 */
  readonly groups: readonly PairedGroupSummary[];
}

/** 試行ごとの対を足していき、差の平均と標準誤差にまとめる。 */
export class PairedTally {
  private readonly winDiff: number[] = [];
  private readonly orderDiff: number[] = [];
  private readonly timeDiff: number[] = [];
  private baseWins = 0;
  private variantWins = 0;
  private baseOrderSum = 0;
  private variantOrderSum = 0;
  private baseTimeSum = 0;
  private variantTimeSum = 0;
  private readonly positions: number[][];
  private readonly groups = new Map<number, { trials: number; baseWins: number; variantWins: number }>();

  constructor(private readonly traceSkillIds: readonly string[]) {
    this.positions = traceSkillIds.map(() => []);
  }

  get trials(): number {
    return this.winDiff.length;
  }

  /** `group` は相手の組の番号。組ごとの内訳を取るのに使う。 */
  add(trial: PairedTrial, group = 0): void {
    const baseWin = trial.baseOrder === 1 ? 1 : 0;
    const variantWin = trial.variantOrder === 1 ? 1 : 0;
    this.winDiff.push(variantWin - baseWin);
    this.orderDiff.push(trial.variantOrder - trial.baseOrder);
    this.timeDiff.push(trial.variantTime - trial.baseTime);
    this.baseWins += baseWin;
    this.variantWins += variantWin;
    this.baseOrderSum += trial.baseOrder;
    this.variantOrderSum += trial.variantOrder;
    this.baseTimeSum += trial.baseTime;
    this.variantTimeSum += trial.variantTime;
    trial.firstPositions.forEach((position, k) => {
      if (!Number.isNaN(position)) this.positions[k]!.push(position);
    });
    const slot = this.groups.get(group) ?? { trials: 0, baseWins: 0, variantWins: 0 };
    slot.trials++;
    slot.baseWins += baseWin;
    slot.variantWins += variantWin;
    this.groups.set(group, slot);
  }

  summarize(): PairedSummary {
    const n = Math.max(1, this.trials);
    return {
      trials: this.trials,
      base: {
        winRate: this.baseWins / n,
        meanOrder: this.baseOrderSum / n,
        meanTime: this.baseTimeSum / n,
      },
      variant: {
        winRate: this.variantWins / n,
        meanOrder: this.variantOrderSum / n,
        meanTime: this.variantTimeSum / n,
      },
      deltaWinRate: meanAndSe(this.winDiff),
      deltaMeanOrder: meanAndSe(this.orderDiff),
      deltaMeanTime: meanAndSe(this.timeDiff),
      skills: this.traceSkillIds.map((skillId, k) => {
        const found = this.positions[k]!;
        return {
          skillId,
          triggerRate: found.length / n,
          medianFirstPosition: found.length === 0 ? null : median(found),
        };
      }),
      groups: [...this.groups.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, g]) => ({
          index,
          trials: g.trials,
          baseWinRate: g.baseWins / g.trials,
          variantWinRate: g.variantWins / g.trials,
        })),
    };
  }
}

/** 同じ相手の組で回す試行のまとまり */
export interface PairedGroup {
  /** 組の番号。集計の内訳に使う。 */
  readonly index: number;
  /** この組を回す乱数の種。試行番号は 0 から数える。 */
  readonly seed: number;
  readonly count: number;
  /** 見る頭の後ろに並べる相手 */
  readonly opponents: readonly RaceSetting[];
}

export interface PairedSpec {
  /** 基準の設定。見る頭。 */
  readonly base: RaceSetting;
  /** 案の設定。基準にスキルを足したもの。 */
  readonly variant: RaceSetting;
  readonly groups: readonly PairedGroup[];
  /** 案の側で発動を数えるスキルの ID（足したスキル） */
  readonly traceSkillIds: readonly string[];
}

export interface PairedOptions {
  /** 何試行ごとに制御を返すか。既定は 5（1 試行が重いので細かく返す）。 */
  readonly yieldEvery?: number;
  /** 制御を返す処理。既定は `setTimeout(0)`（ブラウザでも Node でも動く）。 */
  readonly yieldControl?: () => Promise<void>;
  readonly signal?: AbortSignal;
  /** 全組を通した完了試行数で呼ばれる。 */
  readonly onProgress?: (done: number, total: number) => void;
}

const DEFAULT_YIELD_EVERY = 5;
const yieldByTimeout = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 組ごとに、基準と案を同じ相手・同じ種・同じ試行番号で回して集計する。
 * 中断されたら、そこまでの集計を返さずに例外を投げる（試行が少ないまま答えとして読まれるため）。
 */
export async function runPaired(
  calculator: RaceCalculator,
  spec: PairedSpec,
  options: PairedOptions = {},
): Promise<PairedSummary> {
  const yieldEvery = Math.max(1, options.yieldEvery ?? DEFAULT_YIELD_EVERY);
  const yieldControl = options.yieldControl ?? yieldByTimeout;
  const total = spec.groups.reduce((sum, group) => sum + group.count, 0);
  const tally = new PairedTally(spec.traceSkillIds);
  let done = 0;
  for (const group of spec.groups) {
    const rest = group.opponents.map((setting) => ({ setting }));
    const base: MultiEntry[] = [{ setting: spec.base }, ...rest];
    const variant: MultiEntry[] = [{ setting: spec.variant }, ...rest];
    for (let trial = 0; trial < group.count; trial++) {
      if (options.signal?.aborted === true) throw new Error('中断されました');
      tally.add(
        runPairedTrial(calculator, base, variant, { seed: group.seed, trial, traceSkillIds: spec.traceSkillIds }),
        group.index,
      );
      done++;
      if (done % yieldEvery === 0) {
        options.onProgress?.(done, total);
        await yieldControl();
      }
    }
  }
  options.onProgress?.(total, total);
  return tally.summarize();
}
