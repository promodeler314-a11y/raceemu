import { createNodeWorkerFactory } from '../../../packages/sim/src/parallel/node.ts';
import { WorkerPool } from '../../../packages/sim/src/parallel/pool.ts';

/**
 * 計算の実行環境。Worker のプールと、同時に 1 本だけ回すための順番待ちを持つ。
 * docs/mcp-design.md 2.2 節と 2.3 節を参照。
 *
 * - プールは最初に使われるまで作らない。`data_info` を呼ぶだけで Worker を立てない。
 * - Worker の標準出力と標準エラー出力は、両方とも親の標準エラー出力へ向ける。
 *   標準出力に 1 行でも混ざると、クライアントが接続を切る。
 */
export class Runtime {
  private pool: WorkerPool | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;

  constructor(private readonly concurrency?: number) {}

  /** 使うときに作る。 */
  getPool(): WorkerPool {
    if (this.disposed) throw new Error('実行環境は破棄済み');
    if (this.pool === null) {
      const factory = createNodeWorkerFactory({ stdout: process.stderr, stderr: process.stderr });
      this.pool = new WorkerPool(factory, this.concurrency);
    }
    return this.pool;
  }

  /**
   * 計算を 1 本ずつ順に回す。複数の呼び出しが Worker を取り合うと、全部が遅くなるため。
   * 順番を待っているあいだに中断されたら、回さずに終わる。
   */
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const result = this.tail.then(async () => {
      if (signal?.aborted === true) throw new Error('中断されました');
      return task();
    });
    // 失敗しても次の呼び出しを止めない。
    this.tail = result.catch(() => undefined);
    return result;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.tail;
    if (this.pool !== null) await this.pool.dispose();
    this.pool = null;
  }
}

/** 進捗の通知。`progressToken` が渡されているときだけ、間引いて送る。 */
export interface ProgressReporter {
  (done: number, total: number): void;
}

interface ProgressExtra {
  readonly _meta?: { readonly progressToken?: string | number };
  readonly sendNotification: (notification: {
    method: 'notifications/progress';
    params: { progressToken: string | number; progress: number; total?: number; message?: string };
  }) => Promise<void>;
}

/** 通知の間隔（ミリ秒）。細かく送ると、クライアントの側で処理が詰まる。 */
const PROGRESS_INTERVAL_MS = 500;

export function progressReporter(extra: ProgressExtra, message: string): ProgressReporter {
  const token = extra._meta?.progressToken;
  if (token === undefined) return () => undefined;
  let last = 0;
  return (done, total) => {
    const now = Date.now();
    if (done < total && now - last < PROGRESS_INTERVAL_MS) return;
    last = now;
    // 通知の失敗（接続が切れたなど）で計算を止めない。
    void extra
      .sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: done, total, message } })
      .catch(() => undefined);
  };
}
