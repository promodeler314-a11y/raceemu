import { parentPort } from 'node:worker_threads';
import { loadGameData } from '../../../data/src/node.ts';
import { runChunk, runCriticalChunk, runMultiChunk } from './runner.ts';
import type { WorkerRequest } from './protocol.ts';

const port = parentPort;
if (port === null) throw new Error('worker として起動されていない');

const data = loadGameData();

port.on('message', (request: WorkerRequest) => {
  try {
    if (request.kind === 'critical') {
      const { values, races, byCount } = runCriticalChunk(
        data,
        request.setting,
        request.system,
        request.seed,
        request.from,
        request.count,
        request.critical,
      );
      const transfer: ArrayBuffer[] = [values.buffer as ArrayBuffer];
      if (byCount !== undefined) transfer.push(byCount.buffer as ArrayBuffer);
      port.postMessage({ kind: 'critical', id: request.id, values, races, byCount }, transfer);
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
      port.postMessage({ kind: 'multi', id: request.id, packed }, [packed.buffer as ArrayBuffer]);
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
    port.postMessage(
      { kind: 'chunk', id: request.id, packed, skillStats },
      [packed.buffer as ArrayBuffer, skillStats.buffer as ArrayBuffer],
    );
  } catch (error) {
    port.postMessage({
      kind: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
