import type { ChunkRequest, WorkerResponse } from './protocol.ts';
import type { WorkerFactory, WorkerHandle } from './pool.ts';

/**
 * ブラウザ向けの Worker プール。
 * バンドラが `new Worker(new URL(...), { type: 'module' })` の形を見て
 * Worker のエントリを別チャンクに切り出す。
 *
 * 実行の確認は M3 の UI 側で行う。現時点では Node 版だけがテスト済みである。
 */
class BrowserWorkerHandle implements WorkerHandle {
  private readonly worker: Worker;

  constructor() {
    this.worker = new Worker(new URL('./browser-worker.ts', import.meta.url), { type: 'module' });
  }

  post(request: ChunkRequest): void {
    this.worker.postMessage(request);
  }

  onMessage(handler: (response: WorkerResponse) => void): void {
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => handler(event.data);
  }

  onError(handler: (error: Error) => void): void {
    // 読み込みや実行に失敗したとき。message は空のことがある。
    this.worker.onerror = (event: ErrorEvent) =>
      handler(new Error(event.message === '' ? '読み込みに失敗した' : event.message));
    // 構造化クローンできない値を送り返そうとしたとき。
    this.worker.onmessageerror = () => handler(new Error('結果を受け取れなかった'));
  }

  terminate(): void {
    this.worker.terminate();
  }
}

export const browserWorkerFactory: WorkerFactory = {
  create: () => new BrowserWorkerHandle(),
  defaultConcurrency: Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 4) - 1),
};
