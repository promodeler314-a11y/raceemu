import type { SystemSetting } from '../setting.ts';
import type { RaceSimulationResult } from '../state.ts';
import {
  SKILL_STAT_FIELDS,
  unpackResults,
  type ChunkRequest,
  type CriticalRequest,
  type CriticalSpec,
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
}

export interface CriticalOutput {
  readonly values: Float64Array;
  readonly races: number;
}

export interface RunOutput {
  readonly results: RaceSimulationResult[];
  /** スキルごとの集計。設定のスキル順に並ぶ。 */
  readonly skillStats: Float64Array;
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
      this.workers.push(worker);
      this.idle.push(worker);
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
        for (const worker of this.workers) this.handlers.delete(worker);
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

    await this.dispatchAll(
      total,
      Math.max(1, options.chunkSize ?? 256),
      options,
      (id, from, count): ChunkRequest => ({ kind: 'chunk', id, setting, system, seed, from, count }),
      (response, from) => {
        if (response.kind !== 'chunk') return;
        const unpacked = unpackResults(response.packed);
        for (let j = 0; j < unpacked.length; j++) results[from + j] = unpacked[j]!;
        for (let j = 0; j < skillStats.length; j++) skillStats[j] += response.skillStats[j] ?? 0;
      },
    );

    return { results, skillStats };
  }

  /** 試行ごとの臨界値を求める。 */
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
        races += response.races;
      },
    );

    return { values, races };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const workers = this.workers.splice(0, this.workers.length);
    this.idle.length = 0;
    this.handlers.clear();
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}
