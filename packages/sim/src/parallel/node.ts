import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { ChunkRequest, WorkerResponse } from './protocol.ts';
import type { WorkerFactory, WorkerHandle } from './pool.ts';

const workerUrl = new URL('./node-worker-bootstrap.mjs', import.meta.url);

class NodeWorkerHandle implements WorkerHandle {
  private readonly worker: Worker;
  /** terminate() を通した停止では 'exit' を落ちたとみなさない。 */
  private terminated = false;

  constructor() {
    this.worker = new Worker(workerUrl);
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
export const nodeWorkerFactory: WorkerFactory = {
  create: () => new NodeWorkerHandle(),
  defaultConcurrency: Math.max(1, availableParallelism() - 1),
};
