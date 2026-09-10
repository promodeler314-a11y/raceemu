/// <reference lib="webworker" />
import { loadGameData } from '../../../data/src/browser.ts';
import { runChunk, runCriticalChunk, runMultiChunk } from './runner.ts';
import type { WorkerRequest } from './protocol.ts';

const data = loadGameData();

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.kind === 'critical') {
      const { values, races } = runCriticalChunk(
        data,
        request.setting,
        request.system,
        request.seed,
        request.from,
        request.count,
        request.critical,
      );
      (self as unknown as Worker).postMessage({ kind: 'critical', id: request.id, values, races }, [values.buffer as ArrayBuffer]);
      return;
    }
    if (request.kind === 'multi') {
      const packed = runMultiChunk(
        data,
        request.entries,
        request.system,
        request.seed,
        request.from,
        request.count,
      );
      (self as unknown as Worker).postMessage({ kind: 'multi', id: request.id, packed }, [packed.buffer as ArrayBuffer]);
      return;
    }
    const { packed, skillStats } = runChunk(
      data,
      request.setting,
      request.system,
      request.seed,
      request.from,
      request.count,
      request.field,
    );
    (self as unknown as Worker).postMessage(
      { kind: 'chunk', id: request.id, packed, skillStats },
      [packed.buffer as ArrayBuffer, skillStats.buffer as ArrayBuffer],
    );
  } catch (error) {
    (self as unknown as Worker).postMessage({
      kind: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
