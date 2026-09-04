import { parentPort } from 'node:worker_threads';
import { loadGameData } from '../../../data/src/node.ts';
import { runChunk } from './runner.ts';
import type { WorkerRequest } from './protocol.ts';

const port = parentPort;
if (port === null) throw new Error('worker として起動されていない');

const data = loadGameData();

port.on('message', (request: WorkerRequest) => {
  try {
    const { packed, skillStats } = runChunk(
      data,
      request.setting,
      request.system,
      request.seed,
      request.from,
      request.count,
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
