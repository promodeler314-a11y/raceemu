import type { SystemSetting } from '../setting.ts';
import { ADJUSTMENT_COUNT_BUCKETS, type RaceSimulationResult } from '../state.ts';
import {
  MULTI_FIELDS,
  SKILL_STAT_FIELDS,
  unpackResults,
  type ChunkRequest,
  type CriticalRequest,
  type CriticalSpec,
  type FieldSpec,
  type MultiRequest,
  type SerializableRaceSetting,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol.ts';

/**
 * Worker の実体を抽象化する。Node の worker_threads とブラウザの Web Worker で
 * 生成と破棄の書き方が違うだけなので、この 3 つのメソッドで吸収する。
 */
export interface WorkerHandle {
  post(request: WorkerRequest): void;
  onMessage(handler: (response: WorkerResponse) => void): void;
  /**
   * Worker が返事をせずに死んだときに呼ばれる。
   * 読み込みに失敗した、例外で落ちた、メモリを使い果たした、など。
   * これを見ないと、返事待ちのまま実行が終わらなくなる。
   */
  onError(handler: (error: Error) => void): void;
  terminate(): Promise<void> | void;
}

export interface WorkerFactory {
  create(): WorkerHandle;
  /** 既定の並列数。ブラウザなら hardwareConcurrency - 1 など。 */
  readonly defaultConcurrency: number;
}

export interface RunOptions {
  readonly count: number;
  readonly seed?: number;
  /** 1 つの塊に入れる試行数。往復の回数と中断の粒度を決める。 */
  readonly chunkSize?: number;
  readonly onProgress?: (done: number, total: number) => void;
  readonly signal?: AbortSignal;
  /** 他のウマ娘の位置。渡すと順位条件を実際に判定する。 */
  readonly field?: FieldSpec | null;
  /**
   * 中断したときに、そこまでに終わった試行を返すか。
   *
   * 既定では中断は例外になり、途中の結果は捨てられる。画面から止めたときに
   * 何も残らないと、長く走らせたあとに手を止めた人が全部やり直すことになる。
   */
  readonly keepPartial?: boolean;
}

export interface MultiOutput {
  /** 試行ごと、出走順ごとに MULTI_FIELDS 個ずつ並ぶ */
  readonly packed: Float64Array;
  /** 出走頭数 */
  readonly entries: number;
  readonly cancelled?: boolean;
}

export interface CriticalOutput {
  readonly values: Float64Array;
  readonly races: number;
  /** spec.byAdjustmentCount を指定したときだけ入る。試行ごとに ADJUSTMENT_COUNT_BUCKETS 個ずつ並ぶ。 */
  readonly byCount?: Float64Array;
}

export interface RunOutput {
  readonly results: RaceSimulationResult[];
  /** スキルごとの集計。設定のスキル順に並ぶ。 */
  readonly skillStats: Float64Array;
  /**
   * 中断されたか。`keepPartial` を指定したときだけ true になりうる。
   *
   * true のとき `results` は要求した数より少ない。塊は順不同で終わるので、
   * 「先頭から N 件」ではなく「終わったものだけ」である。
   */
  readonly cancelled?: boolean;
}

export class SimulationCancelled extends Error {
  constructor() {
    super('シミュレーションが中断された');
    this.name = 'SimulationCancelled';
  }
}

interface Pending {
  readonly from: number;
  readonly count: number;
}

/**
 * Worker を常駐させ、試行の塊を空いた Worker へ順に配る。
 *
 * Worker の起動とデータの読み込みは 1 回で済ませたい。
 * 探索は同じ設定を少しずつ変えて何千回も評価するため、実行のたびに
 * 立ち上げ直すと起動時間が計算時間を上回る。
 */
export class WorkerPool {
  private readonly workers: WorkerHandle[] = [];
  private readonly idle: WorkerHandle[] = [];
  private readonly handlers = new Map<WorkerHandle, (response: WorkerResponse) => void>();
  private readonly errorHandlers = new Map<WorkerHandle, (error: Error) => void>();
  private disposed = false;

  constructor(
    private readonly factory: WorkerFactory,
    readonly concurrency: number = factory.defaultConcurrency,
  ) {}

  private ensureWorkers(): void {
    if (this.disposed) throw new Error('プールは破棄済み');
    while (this.workers.length < this.concurrency) {
      const worker = this.factory.create();
      worker.onMessage((response) => {
        const handler = this.handlers.get(worker);
        if (handler !== undefined) handler(response);
      });
      worker.onError((error) => {
        // 先に取り出す。drop() が控えを消すため、順序を逆にすると誰にも伝わらない。
        const handler = this.errorHandlers.get(worker);
        this.drop(worker);
        if (handler !== undefined) handler(error);
      });
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  /** 死んだ Worker をプールから外す。次の実行で作り直される。 */
  private drop(worker: WorkerHandle): void {
    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);
    const idleIndex = this.idle.indexOf(worker);
    if (idleIndex >= 0) this.idle.splice(idleIndex, 1);
    this.handlers.delete(worker);
    this.errorHandlers.delete(worker);
    try {
      void worker.terminate();
    } catch {
      // 既に死んでいる。
    }
  }

  /**
   * 塊に割った仕事を、空いた Worker へ順に配る。
   * 依頼の作り方と結果の取り込み方だけを呼び出し側から受け取る。
   */
  private async dispatchAll(
    total: number,
    chunkSize: number,
    options: Pick<RunOptions, 'onProgress' | 'signal'>,
    makeRequest: (id: number, from: number, count: number) => WorkerRequest,
    collect: (response: Exclude<WorkerResponse, { kind: 'error' }>, from: number, count: number) => void,
  ): Promise<void> {
    this.ensureWorkers();
    const chunks: Pending[] = [];
    for (let from = 0; from < total; from += chunkSize) {
      chunks.push({ from, count: Math.min(chunkSize, total - from) });
    }

    let nextChunk = 0;
    let done = 0;
    let active = 0;
    let settled = false;

    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        for (const worker of this.workers) {
          this.handlers.delete(worker);
          this.errorHandlers.delete(worker);
        }
        if (error === undefined) resolve();
        else reject(error);
      };

      const isCancelled = () => options.signal?.aborted === true;

      const dispatch = (worker: WorkerHandle) => {
        if (settled) return;
        if (isCancelled()) {
          this.idle.push(worker);
          if (active === 0) finish(new SimulationCancelled());
          return;
        }
        if (nextChunk >= chunks.length) {
          this.idle.push(worker);
          if (active === 0) finish();
          return;
        }
        const id = nextChunk++;
        const chunk = chunks[id]!;
        active++;
        this.errorHandlers.set(worker, (error) => {
          active--;
          finish(
            new Error(
              `計算用の Worker が停止した（${error.message}）。試行回数を減らすか、ページを開き直す。`,
            ),
          );
        });
        this.handlers.set(worker, (response) => {
          active--;
          if (settled) return;
          if (response.kind === 'error') {
            finish(new Error(response.message));
            return;
          }
          const target = chunks[response.id]!;
          collect(response, target.from, target.count);
          done += target.count;
          options.onProgress?.(done, total);
          dispatch(worker);
        });
        worker.post(makeRequest(id, chunk.from, chunk.count));
      };

      const available = this.idle.splice(0, this.idle.length);
      for (const worker of available) dispatch(worker);
      if (active === 0 && !settled) finish();
    });
  }

  /** 同じ設定を count 回走らせる。試行 i の結果は seed と i だけで決まる。 */
  async run(
    setting: SerializableRaceSetting,
    system: SystemSetting,
    options: RunOptions,
  ): Promise<RunOutput> {
    const total = options.count;
    const skillStats = new Float64Array(setting.skillIds.length * SKILL_STAT_FIELDS);
    if (total <= 0) return { results: [], skillStats };
    const seed = options.seed ?? 1;
    const results: RaceSimulationResult[] = new Array(total);

    let cancelled = false;
    try {
      await this.dispatchAll(
        total,
        Math.max(1, options.chunkSize ?? 256),
        options,
        (id, from, count): ChunkRequest => ({
          kind: 'chunk',
          id,
          setting,
          system,
          seed,
          from,
          count,
          field: options.field ?? null,
        }),
        (response, from) => {
          if (response.kind !== 'chunk') return;
          const unpacked = unpackResults(response.packed);
          for (let j = 0; j < unpacked.length; j++) results[from + j] = unpacked[j]!;
          for (let j = 0; j < skillStats.length; j++) skillStats[j] += response.skillStats[j] ?? 0;
        },
      );
    } catch (error) {
      if (!(error instanceof SimulationCancelled) || options.keepPartial !== true) throw error;
      cancelled = true;
    }

    if (!cancelled) return { results, skillStats };
    // 塊は順不同で終わるので、埋まっていない番号が飛び飛びに残る。
    // 穴を落として、終わったものだけを返す。
    return { results: results.filter((result) => result !== undefined), skillStats, cancelled };
  }

  /** 試行ごとの臨界値を求める。 */
  /**
   * 全頭同時のレースを試行のぶんだけ回す。
   * 1 試行が頭数ぶん重いので、塊は小さめにして進捗が細かく返るようにする。
   */
  async runMulti(
    entries: readonly SerializableRaceSetting[],
    system: SystemSetting,
    options: RunOptions,
  ): Promise<MultiOutput> {
    const total = options.count;
    const width = entries.length * MULTI_FIELDS;
    if (total <= 0 || entries.length === 0) return { packed: new Float64Array(0), entries: entries.length };
    const seed = options.seed ?? 1;
    const packed = new Float64Array(total * width);

    let cancelled = false;
    let filled = 0;
    try {
      await this.dispatchAll(
        total,
        Math.max(1, options.chunkSize ?? 32),
        options,
        (id, from, count): MultiRequest => ({
          kind: 'multi',
          id,
          entries: [...entries],
          system,
          seed,
          from,
          count,
        }),
        (response, from, count) => {
          if (response.kind !== 'multi') return;
          packed.set(response.packed, from * width);
          filled += count;
        },
      );
    } catch (error) {
      if (!(error instanceof SimulationCancelled) || options.keepPartial !== true) throw error;
      cancelled = true;
    }
    if (!cancelled) return { packed, entries: entries.length };
    // 塊は順不同で終わるので、埋まった試行だけを詰め直す
    const kept = new Float64Array(filled * width);
    let out = 0;
    for (let trial = 0; trial < total; trial++) {
      // 着順は 1 以上なので、0 のままなら埋まっていない
      if (packed[trial * width] === 0) continue;
      kept.set(packed.subarray(trial * width, (trial + 1) * width), out * width);
      out++;
    }
    return { packed: kept.subarray(0, out * width), entries: entries.length, cancelled };
  }

  async runCritical(
    setting: SerializableRaceSetting,
    system: SystemSetting,
    spec: CriticalSpec,
    options: RunOptions,
  ): Promise<CriticalOutput> {
    const total = options.count;
    if (total <= 0) return { values: new Float64Array(0), races: 0 };
    const seed = options.seed ?? 1;
    const values = new Float64Array(total);
    const byCount = spec.byAdjustmentCount
      ? new Float64Array(total * ADJUSTMENT_COUNT_BUCKETS).fill(Number.NaN)
      : undefined;
    let races = 0;

    await this.dispatchAll(
      total,
      // 1 試行あたり十数本から百数十本走るので、塊は小さめにする
      Math.max(1, options.chunkSize ?? 32),
      options,
      (id, from, count): CriticalRequest => ({
        kind: 'critical',
        id,
        setting,
        system,
        seed,
        from,
        count,
        critical: spec,
      }),
      (response, from) => {
        if (response.kind !== 'critical') return;
        values.set(response.values, from);
        if (byCount !== undefined && response.byCount !== undefined) {
          byCount.set(response.byCount, from * ADJUSTMENT_COUNT_BUCKETS);
        }
        races += response.races;
      },
    );

    return byCount === undefined ? { values, races } : { values, races, byCount };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const workers = this.workers.splice(0, this.workers.length);
    this.idle.length = 0;
    this.handlers.clear();
    this.errorHandlers.clear();
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}
