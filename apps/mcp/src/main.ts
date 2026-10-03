/**
 * MCP サーバー（stdio）。
 *   pnpm -s mcp
 *
 * **標準出力は JSON-RPC 専用である。** ログは標準エラー出力へ（`log`）。
 * 1 行でも混ざると、クライアントが黙って接続を切る。docs/mcp-design.md 2.1 節を参照。
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadDataMeta, loadGameData } from '../../../packages/data/src/node.ts';
import { createContext, log } from './context.ts';
import { createRaceemuServer } from './server.ts';

const data = loadGameData();
const meta = loadDataMeta();
const context = createContext({ data, meta });
const server = createRaceemuServer(context);

// 終了するときは Worker を止める。止めないと、親が終わっても Worker が残ることがある。
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void context.runtime.dispose().finally(() => process.exit(0));
  });
}
// クライアントが標準入力を閉じたら、それが終了の合図である。
process.stdin.on('close', () => {
  void context.runtime.dispose().finally(() => process.exit(0));
});

process.on('uncaughtException', (error) => {
  log(`未処理の例外: ${error.stack ?? error.message}`);
  process.exit(1);
});

await server.connect(new StdioServerTransport());
log(
  `起動 / スキル ${data.skills.length} 件 / データ ${meta?.syncedAt ?? '取得日不明'}`,
);
