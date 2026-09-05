import type { FieldSpec, SerializableRaceSetting } from '../../sim/src/parallel/protocol.ts';
import { SimulationCancelled, type WorkerPool } from '../../sim/src/parallel/pool.ts';
import type { SystemSetting } from '../../sim/src/setting.ts';
import { dedupeByGroup, type CostModel } from './cost.ts';

/**
 * スキルの組み合わせ探索。
 *
 * 候補どうしの比較は、同じ試行番号の結果を引き算する。
 * 乱数をストリームごとに分けてあるので、スキルを 1 つ足しても他の出目は
 * 変わらない。効かないスキルを足したときの差は厳密に 0 になる。
 * docs/solver-design.md 1.1 節と 3 節を参照。
 */

export interface OptimizeContext {
  readonly pool: WorkerPool;
  readonly system: SystemSetting;
  readonly base: SerializableRaceSetting;
  readonly cost: CostModel;
  readonly field?: FieldSpec | null;
  readonly seed: number;
}

/** 候補の評価。試行ごとの値をそのまま持つ。差分はこの配列から取る。 */
export interface Evaluation {
  readonly skillIds: readonly string[];
  readonly times: Float64Array;
  /** 試行ごとの最大スパート成否。1 なら成立。 */
  readonly maxSpurt: Uint8Array;
}

export interface PairedDiff {
  /** 基準から見た短縮量。正なら速い。 */
  readonly mean: number;
  readonly stdError: number;
  readonly trials: number;
  /** 差が厳密に 0 だった試行の割合。共通乱数が効いている証拠でもある。 */
  readonly zeroRate: number;
  /** 最大スパートの成否が入れ替わった試行数 */
  readonly spurtFlips: number;
  /** 最大スパートの成立率の変化 */
  readonly spurtRateDelta: number;
}

/**
 * 2 つの評価を試行ごとに引き算する。共通乱数によるペア比較。
 *
 * 差の分散は、ほとんどの試行では小さい。
 * 大きく効くのは最大スパートの成否が入れ替わった試行で、そこだけ数秒動く。
 * 何本入れ替わったかを併せて返すのは、平均が一握りの試行に乗っているときに
 * それが見えるようにするためである。
 */
export function pairedDiff(baseline: Evaluation, candidate: Evaluation): PairedDiff {
  const n = Math.min(baseline.times.length, candidate.times.length);
  if (n === 0) {
    return { mean: Number.NaN, stdError: Number.NaN, trials: 0, zeroRate: 0, spurtFlips: 0, spurtRateDelta: 0 };
  }
  let sum = 0;
  let zeros = 0;
  let flips = 0;
  let spurtSum = 0;
  for (let i = 0; i < n; i++) {
    const d = baseline.times[i]! - candidate.times[i]!;
    sum += d;
    if (Math.abs(d) < 1e-9) zeros++;
    const before = baseline.maxSpurt[i]!;
    const after = candidate.maxSpurt[i]!;
    if (before !== after) flips++;
    spurtSum += after - before;
  }
  const mean = sum / n;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = baseline.times[i]! - candidate.times[i]! - mean;
    variance += d * d;
  }
  variance /= Math.max(1, n - 1);
  return {
    mean,
    stdError: Math.sqrt(variance / n),
    trials: n,
    zeroRate: zeros / n,
    spurtFlips: flips,
    spurtRateDelta: spurtSum / n,
  };
}

export class Evaluator {
  private readonly cache = new Map<string, Evaluation>();
  /** 走らせたレースの総数 */
  races = 0;
  /** 構成を評価した回数。キャッシュに当たったぶんは数えない。 */
  evaluations = 0;

  constructor(private readonly context: OptimizeContext) {}

  private key(skillIds: readonly string[], trials: number): string {
    return `${trials}|${[...skillIds].sort().join(',')}`;
  }

  /** 指定した構成を trials 回走らせ、試行ごとの結果を返す。 */
  async evaluate(skillIds: readonly string[], trials: number): Promise<Evaluation> {
    const key = this.key(skillIds, trials);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const setting: SerializableRaceSetting = { ...this.context.base, skillIds: [...skillIds] };
    const { results } = await this.context.pool.run(setting, this.context.system, {
      count: trials,
      seed: this.context.seed,
      field: this.context.field ?? null,
    });
    const times = new Float64Array(results.length);
    const maxSpurt = new Uint8Array(results.length);
    for (let i = 0; i < results.length; i++) {
      times[i] = results[i]!.raceTime;
      maxSpurt[i] = results[i]!.maxSpurt ? 1 : 0;
    }
    this.races += results.length;
    this.evaluations++;
    const evaluation: Evaluation = { skillIds: [...skillIds], times, maxSpurt };
    this.cache.set(key, evaluation);
    return evaluation;
  }
}

/** 単体で足したときの効き。並べ替えの手がかりと、UI での表示に使う。 */
export interface SingleEffect {
  readonly skillId: string;
  readonly diff: PairedDiff;
  readonly cost: number;
  /** 1 ポイントあたりの短縮量 */
  readonly efficiency: number;
}

export interface OptimizeOptions {
  /** 選択の候補になるスキル ID */
  readonly candidates: readonly string[];
  /** スキルポイントの予算 */
  readonly budget: number;
  /** 段階ごとの試行回数。少ない試行でふるいにかけ、残ったものに増やす。 */
  readonly stages?: readonly number[];
  /** 局所探索を繰り返す上限 */
  readonly maxRounds?: number;
  /** 改善とみなすのに要求する、差の標準誤差に対する倍率 */
  readonly significance?: number;
  /** ふるいの各段で必ず残す数。最終段に何通りか残して比較できるようにする。 */
  readonly minKeep?: number;
  readonly onProgress?: (message: string) => void;
  readonly signal?: AbortSignal;
}

export interface OptimizeEntry {
  readonly skillIds: readonly string[];
  /** 何も取らない構成から見た短縮量 */
  readonly diff: PairedDiff;
  readonly cost: number;
}

export interface OptimizeResult {
  readonly best: readonly string[];
  readonly bestDiff: PairedDiff;
  /** 最終段まで残った構成を、短縮量の大きい順に並べたもの */
  readonly top: readonly OptimizeEntry[];
  readonly singles: readonly SingleEffect[];
  readonly cost: number;
  readonly races: number;
  readonly evaluations: number;
  readonly rounds: number;
  readonly elapsedMs: number;
}

const DEFAULT_STAGES = [200, 600, 2000];

/**
 * 単体の効率で並べて貪欲に初期解を作り、そこから局所探索で詰める。
 *
 * 単体の効率だけで決めないのは、スキルどうしが独立ではないからである。
 * 速度上昇が同じ区間に重なれば加速が追い付かず、回復は体力に余裕があると
 * 捨てられる。最終的な比較は必ず構成全体を走らせて行う。
 */
export async function optimizeSkills(
  context: OptimizeContext,
  options: OptimizeOptions,
): Promise<OptimizeResult> {
  const started = performance.now();
  const stages = options.stages ?? DEFAULT_STAGES;
  const significance = options.significance ?? 2;
  const maxRounds = options.maxRounds ?? 8;
  const minKeep = options.minKeep ?? 4;
  const evaluator = new Evaluator(context);
  const report = options.onProgress ?? (() => {});
  const abort = () => {
    if (options.signal?.aborted === true) throw new SimulationCancelled();
  };

  const candidates = [...new Set(options.candidates)];
  const firstStage = stages[0]!;
  const lastStage = stages[stages.length - 1]!;

  // 基準は候補を 1 つも取らない構成
  const baseIds = context.base.skillIds.filter((id) => !candidates.includes(id));
  const baseline = await evaluator.evaluate(baseIds, lastStage);

  // 単体評価。並べ替えの手がかりなので、少ない試行で足りる。
  report('単体評価');
  const singles: SingleEffect[] = [];
  const baselineShort = await evaluator.evaluate(baseIds, firstStage);
  for (const id of candidates) {
    abort();
    const evaluation = await evaluator.evaluate([...baseIds, id], firstStage);
    const diff = pairedDiff(baselineShort, evaluation);
    const cost = context.cost.cost(id);
    singles.push({ skillId: id, diff, cost, efficiency: cost === 0 ? 0 : diff.mean / cost });
  }
  singles.sort((a, b) => b.efficiency - a.efficiency);

  // 貪欲な初期解
  let current: string[] = [...baseIds];
  for (const single of singles) {
    if (single.diff.mean <= 0) continue;
    const next = dedupeByGroup(
      [...selected(current, candidates), single.skillId],
      context.cost,
    );
    if (context.cost.totalCost(next) <= options.budget) current = [...baseIds, ...next];
  }
  report(`貪欲な初期解: ${selected(current, candidates).length} 個 / ${context.cost.totalCost(selected(current, candidates))} pt`);

  // 最終段まで残った構成は、採否によらず記録する。
  // 採用したものだけを残すと、僅差で負けた構成が見えなくなるためである。
  const seen = new Map<string, OptimizeEntry>();
  const record = async (ids: readonly string[]) => {
    const picked = selected(ids, candidates);
    const key = [...picked].sort().join(',');
    if (seen.has(key)) return seen.get(key)!;
    const evaluation = await evaluator.evaluate([...baseIds, ...picked], lastStage);
    const entry: OptimizeEntry = {
      skillIds: picked,
      diff: pairedDiff(baseline, evaluation),
      cost: context.cost.totalCost(picked),
    };
    seen.set(key, entry);
    return entry;
  };

  let currentDiff = (await record(current)).diff;

  let rounds = 0;
  for (; rounds < maxRounds; rounds++) {
    abort();
    const neighbours = buildNeighbourhood(current, candidates, context.cost, options.budget, baseIds);
    if (neighbours.length === 0) break;
    report(`第 ${rounds + 1} 巡: 近傍 ${neighbours.length} 通り`);

    // 段階的に試行数を増やし、見込みのないものを落とす
    let survivors = neighbours;
    let improved = false;
    for (let s = 0; s < stages.length; s++) {
      const trials = stages[s]!;
      const currentAtStage = await evaluator.evaluate(current, trials);
      const scored: { ids: string[]; diff: PairedDiff }[] = [];
      for (const ids of survivors) {
        abort();
        const evaluation = await evaluator.evaluate(ids, trials);
        scored.push({ ids, diff: pairedDiff(currentAtStage, evaluation) });
      }
      scored.sort((a, b) => b.diff.mean - a.diff.mean);

      if (s < stages.length - 1) {
        const keep = Math.max(minKeep, Math.ceil(scored.length / 4));
        survivors = scored.slice(0, keep).map((x) => x.ids);
        continue;
      }

      for (const entry of scored) await record(entry.ids);
      const best = scored[0];
      if (best === undefined) break;
      // 改善が誤差の範囲なら、そこで止める
      if (!(best.diff.mean > significance * best.diff.stdError)) {
        report(
          `改善が誤差の範囲に収まった（最良 ${best.diff.mean.toFixed(4)} ± ${(significance * best.diff.stdError).toFixed(4)} 秒）`,
        );
        break;
      }
      current = best.ids;
      currentDiff = (await record(current)).diff;
      improved = true;
      report(`採用: 基準から ${currentDiff.mean.toFixed(4)} 秒短縮`);
    }
    if (!improved) {
      rounds++;
      break;
    }
  }

  const top = [...seen.values()].sort((a, b) => b.diff.mean - a.diff.mean);
  return {
    best: selected(current, candidates),
    bestDiff: currentDiff,
    top,
    singles,
    cost: context.cost.totalCost(selected(current, candidates)),
    races: evaluator.races,
    evaluations: evaluator.evaluations,
    rounds,
    elapsedMs: performance.now() - started,
  };
}

function selected(ids: readonly string[], candidates: readonly string[]): string[] {
  return ids.filter((id) => candidates.includes(id));
}

/**
 * 1 つ足す、1 つ外す、1 つを別のものに入れ替える。
 *
 * 同じグループのスキルは 1 つに絞ってから予算を見る。
 * 予算を超える近傍と、絞った結果いまの構成に戻ってしまう近傍は捨てる。
 */
function buildNeighbourhood(
  current: readonly string[],
  candidates: readonly string[],
  model: CostModel,
  budget: number,
  baseIds: readonly string[],
): string[][] {
  const picked = selected(current, candidates);
  const pickedSet = new Set(picked);
  const currentKey = [...picked].sort().join(',');
  const result: string[][] = [];
  const emitted = new Set<string>([currentKey]);
  const push = (ids: string[]) => {
    const deduped = dedupeByGroup(ids, model);
    const key = [...deduped].sort().join(',');
    if (emitted.has(key)) return;
    if (model.totalCost(deduped) > budget) return;
    emitted.add(key);
    result.push([...baseIds, ...deduped]);
  };

  for (const id of candidates) {
    if (pickedSet.has(id)) continue;
    push([...picked, id]);
  }
  for (const id of picked) {
    push(picked.filter((x) => x !== id));
  }
  for (const out of picked) {
    for (const inId of candidates) {
      if (pickedSet.has(inId)) continue;
      push([...picked.filter((x) => x !== out), inId]);
    }
  }
  return result;
}
