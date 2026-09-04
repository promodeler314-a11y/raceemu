/// <reference lib="webworker" />
import { loadGameData } from '../../../data/src/browser.ts';
import { runChunk } from './runner.ts';
import type { WorkerRequest } from './protocol.ts';

const data = loadGameData();

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    const packed = runChunk(
      data,
      request.setting,
      request.system,
      request.seed,
      request.from,
      request.count,
    );
    (self as unknown as Worker).postMessage({ kind: 'chunk', id: request.id, packed }, [packed.buffer as ArrayBuffer]);
  } catch (error) {
    (self as unknown as Worker).postMessage({
      kind: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
