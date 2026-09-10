/**
 * 探索をサーバ側で回す口。
 *   node --import tsx apps/api/src/main.ts
 *
 * 環境変数は config.ts を参照。
 */
import { loadGameData } from '../../../packages/data/src/node.ts';
import { loadConfig } from './config.ts';
import { createApiServer } from './http.ts';
import { JobRunner } from './jobs.ts';

const config = loadConfig();
const data = loadGameData();
const runner = new JobRunner(config, data);
const server = createApiServer(config, data, runner);

// 終わったジョブを片付ける。放っておくと結果を抱えたまま増え続ける。
const sweeper = setInterval(() => runner.sweep(), 60_000);
sweeper.unref();

server.listen(config.port, () => {
  console.log(
    `listening on ${config.port} / Worker ${config.concurrency} 本` +
      `（${config.concurrencySource} から決定）/ 1 ジョブ上限 ${config.maxRacesPerJob.toLocaleString()} レース`,
  );
  if (config.staticRoot !== null) console.log(`静的ファイル: ${config.staticRoot}`);
  console.log(
    config.tessdataPath === null
      ? '画面の読み取り: 無効（RACEEMU_TESSDATA が未指定）'
      : `画面の読み取り: ${config.tessdataPath}`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
