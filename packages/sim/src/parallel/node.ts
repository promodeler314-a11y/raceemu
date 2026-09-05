import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { ChunkRequest, WorkerResponse } from './protocol.ts';
import type { WorkerFactory, WorkerHandle } from './pool.ts';

const workerUrl = new URL('./node-worker-bootstrap.mjs', import.meta.url);

class NodeWorkerHandle implements WorkerHandle {
  private readonly worker: Worker;

  constructor() {
    this.worker = new Worker(workerUrl);
  }

  post(request: ChunkRequest): void {
    this.worker.postMessage(request);
  }

  onMessage(handler: (response: WorkerResponse) => void): void {
    this.worker.on('message', handler);
  }

  async terminate(): Promise<void> {
    await this.worker.terminate();
  }
}

/** Node 上の Worker プール。実測と検証に使う。 */
export const nodeWorkerFactory: WorkerFactory = {
  create: () => new NodeWorkerHandle(),
  defaultConcurrency: Math.max(1, availableParallelism() - 1),
};
