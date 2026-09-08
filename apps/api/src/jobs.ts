import { randomUUID } from 'node:crypto';
import type { GameData } from '../../../packages/data/src/index.ts';
import { nodeWorkerFactory } from '../../../packages/sim/src/parallel/node.ts';
import { SimulationCancelled, WorkerPool, type RunOptions, type RunOutput } from '../../../packages/sim/src/parallel/pool.ts';
import type { SerializableRaceSetting } from '../../../packages/sim/src/parallel/protocol.ts';
import type { SystemSetting } from '../../../packages/sim/src/setting.ts';
import { createCostModel } from '../../../packages/solver/src/cost.ts';
import { optimizeSkills, type OptimizeResult } from '../../../packages/solver/src/optimize.ts';
import type { Config } from './config.ts';
import type { ResolvedRequest } from './request.ts';

/**
 * 探索のジョブ。
 *
 * 1 本の探索が 25 万レース規模になるので、要求と応答を往復させる形にはしない。
 * 受け付けて ID を返し、進捗と結果は別の口から読む。
 * [サーバ側で探索を回す設計](../../../docs/server-design.md)の 3.1 節を参照。
 */

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  readonly id: string;
  status: JobStatus;
  readonly createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  /** 走らせたレースの数。上限の見張りにも使う。 */
  races: number;
  /** 直近の進捗。全部持つと長い探索で際限なく伸びる。 */
  readonly progress: string[];
  result: OptimizeResult | null;
  error: string | null;
}

const MAX_PROGRESS_LINES = 50;

export class QueueFullError extends Error {}

/**
 * レースの数を数えるプール。
 *
 * 上限を事前の見積もりだけで守ろうとすると、候補数と予算と巡回数から
 * 逆算することになり、探索の内部の詰め方に依存してしまう。
 * 実際に走った数を数えて超えたら止めるほうが、見積もりの誤りに強い。
 *
 * ジョブごとに 1 つ作って終わりに捨てる。使い回すと、同時に走らせたときに
 * 数がまざる。Worker の起動はやり直しになるが、分単位で走る探索の前では小さい。
 */
class CountingPool extends WorkerPool {
  races = 0;

  constructor(
    concurrency: number,
    private readonly limit: number,
    private readonly onExceeded: () => void,
  ) {
    super(nodeWorkerFactory, concurrency);
  }

  override async run(
    setting: SerializableRaceSetting,
    system: SystemSetting,
    options: RunOptions,
  ): Promise<RunOutput> {
    const output = await super.run(setting, system, options);
    this.races += output.results.length;
    if (this.races > this.limit) this.onExceeded();
    return output;
  }
}

export class JobRunner {
  private readonly jobs = new Map<string, Job>();
  private readonly controllers = new Map<string, AbortController>();
  /** 走り出すのを待っているジョブ。先入れ先出し。 */
  private readonly waiting: string[] = [];
  /** 待っているジョブの要求。走り出すまで持っておく必要がある。 */
  private readonly pending = new Map<string, ResolvedRequest>();
  private running = 0;

  constructor(
    private readonly config: Config,
    private readonly data: GameData,
  ) {}

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** いまの混み具合。health で返して、外から見えるようにする。 */
  stats(): { running: number; queued: number; total: number } {
    return { running: this.running, queued: this.waiting.length, total: this.jobs.size };
  }

  submit(request: ResolvedRequest): Job {
    if (this.waiting.length >= this.config.maxQueued) {
      throw new QueueFullError(`待ち行列がいっぱいである（上限 ${this.config.maxQueued}）`);
    }
    const job: Job = {
      id: randomUUID(),
      status: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      races: 0,
      progress: [],
      result: null,
      error: null,
    };
    this.jobs.set(job.id, job);
    this.waiting.push(job.id);
    this.pending.set(job.id, request);
    this.drain();
    return job;
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (job === undefined) return false;
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return false;
    this.controllers.get(id)?.abort();
    const index = this.waiting.indexOf(id);
    if (index >= 0) {
      // まだ走っていないので、ここで終わらせる。
      this.waiting.splice(index, 1);
      this.pending.delete(id);
      job.status = 'cancelled';
      job.finishedAt = Date.now();
    }
    return true;
  }

  /** 保持期間を過ぎた終了済みのジョブを捨てる。 */
  sweep(now = Date.now()): void {
    for (const [id, job] of this.jobs) {
      const finished = job.finishedAt;
      if (finished !== null && now - finished > this.config.jobTtlMs) {
        this.jobs.delete(id);
        this.controllers.delete(id);
      }
    }
  }

  /**
   * 空きがある限り、待っているジョブを順に走らせる。
   *
   * 受け付けたときだけでなく、1 本終わるたびに呼ぶ。
   * 呼ばないと、混んでいる間に積まれたジョブが誰にも起こされない。
   */
  private drain(): void {
    while (this.running < this.config.maxRunning && this.waiting.length > 0) {
      const id = this.waiting.shift()!;
      const request = this.pending.get(id);
      this.pending.delete(id);
      if (request === undefined) continue;
      this.running++;
      void this.execute(request, id).finally(() => {
        this.running--;
        this.drain();
      });
    }
  }

  private async execute(request: ResolvedRequest, id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (job === undefined) return;

    job.status = 'running';
    job.startedAt = Date.now();

    const controller = new AbortController();
    this.controllers.set(id, controller);
    let exceeded = false;
    const pool = new CountingPool(this.config.concurrency, this.config.maxRacesPerJob, () => {
      exceeded = true;
      controller.abort();
    });

    try {
      const result = await optimizeSkills(
        {
          pool,
          system: request.system,
          base: request.base,
          cost: createCostModel(this.data.skillsById, { hintLevels: request.hintLevels }),
          field: request.field,
          seed: request.seed,
        },
        {
          candidates: request.candidates,
          budget: request.budget,
          ...(request.stages === undefined ? {} : { stages: request.stages }),
          signal: controller.signal,
          onProgress: (message) => {
            job.progress.push(message);
            if (job.progress.length > MAX_PROGRESS_LINES) job.progress.shift();
            job.races = pool.races;
          },
        },
      );
      job.result = result;
      job.races = pool.races;
      job.status = 'done';
    } catch (error) {
      job.races = pool.races;
      if (exceeded) {
        job.status = 'failed';
        job.error = `レース数の上限 ${this.config.maxRacesPerJob.toLocaleString()} を超えたので打ち切った。候補か予算か試行回数を減らす。`;
      } else if (error instanceof SimulationCancelled || controller.signal.aborted) {
        job.status = 'cancelled';
      } else {
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      job.finishedAt = Date.now();
      this.controllers.delete(id);
      await pool.dispose();
    }
  }
}
