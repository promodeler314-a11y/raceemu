import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { ChunkRequest, WorkerResponse } from './protocol.ts';
import type { WorkerFactory, WorkerHandle } from './pool.ts';

const workerUrl = new URL('./node-worker-bootstrap.mjs', import.meta.url);

/**
 * Worker の標準出力と標準エラー出力の行き先。
 *
 * 既定（`undefined`）では、Worker の出力は親の標準出力と標準エラー出力へそのまま流れる。
 * stdio で JSON-RPC をやり取りする MCP サーバーでは、標準出力に 1 行でも混ざると
 * クライアントが接続を切るので、両方を標準エラー出力へ向けるために使う。
 */
export interface WorkerOutput {
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

class NodeWorkerHandle implements WorkerHandle {
  private readonly worker: Worker;
  /** terminate() を通した停止では 'exit' を落ちたとみなさない。 */
  private terminated = false;

  constructor(output?: WorkerOutput) {
    // stdout: true にすると親へ自動では流れず、worker.stdout から読む形になる。
    this.worker = output === undefined ? new Worker(workerUrl) : new Worker(workerUrl, { stdout: true, stderr: true });
    if (output !== undefined) {
      this.worker.stdout.pipe(output.stdout);
      this.worker.stderr.pipe(output.stderr);
    }
  }

  post(request: ChunkRequest): void {
    this.worker.postMessage(request);
  }

  onMessage(handler: (response: WorkerResponse) => void): void {
    this.worker.on('message', handler);
  }

  onError(handler: (error: Error) => void): void {
    this.worker.on('error', handler);
    this.worker.on('exit', (code) => {
      if (this.terminated) return;
      if (code !== 0) handler(new Error(`Worker が終了コード ${code} で停止した`));
    });
  }

  async terminate(): Promise<void> {
    this.terminated = true;
    await this.worker.terminate();
  }
}

/** Node 上の Worker プール。実測と検証に使う。 */
export const nodeWorkerFactory: WorkerFactory = createNodeWorkerFactory();

/** Worker の出力先を指定できる版。省くと `nodeWorkerFactory` と同じ。 */
export function createNodeWorkerFactory(output?: WorkerOutput): WorkerFactory {
  return {
    create: () => new NodeWorkerHandle(output),
    defaultConcurrency: Math.max(1, availableParallelism() - 1),
  };
}
