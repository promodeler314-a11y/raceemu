import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 実際に使う起動コマンドで、標準出力が JSON-RPC だけであることを確かめる。
 *
 * 標準出力に 1 行でも JSON 以外が混ざると、クライアントが黙って接続を切る。
 * 計算のテストでは捕まらず、使って初めて「つながらない」と分かる種類の失敗なので、
 * 子プロセスとして起動して全部の行を見る（docs/mcp-design.md 2.1 節と 8 節）。
 *
 * 実際に `pnpm mcp` は `> raceemu@ mcp ...` というヘッダを標準出力に出して、これで落ちる。
 * `pnpm -s mcp` の `-s` は省けない。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const main = join(root, 'apps', 'mcp', 'src', 'main.ts');

interface Handshake {
  readonly lines: readonly string[];
  readonly stderr: string;
}

/** 計算を回す呼び出し（Worker を立てる）に使う、2 頭の出走表。 */
const SMALL_LINEUP = ['エルコンドルパサー', 'スーパークリーク'].map((name, i) => ({
  name,
  chara: name,
  status: { speed: 1200 + i, stamina: 800, power: 900, guts: 600, wisdom: 800 },
  aptitude: {
    surface: { turf: 'A', dirt: 'E' },
    distance: { short: 'F', mile: 'B', mid: 'S', long: 'C' },
    style: { nige: 'E', sen: 'A', sasi: 'C', oi: 'G' },
  },
  skills: ['王手', '右回り○'],
}));

/**
 * 起動して initialize、tools/list、data_info、win_rate の呼び出しを送り、4 つの応答が揃ったら止める。
 *
 * win_rate は Worker を立てて回す。Worker の出力が標準出力に流れる経路は、data_info だけでは通らない。
 */
function handshake(command: string, args: readonly string[], cwd: string, shell: boolean): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    // 個体の保存先は、実際のホームではなく一時の場所にしておく（このテストでは使わないが、念のため）。
    const env = { ...process.env, RACEEMU_MCP_DATA_DIR: join(tmpdir(), 'raceemu-mcp-stdio-test') };
    const child = spawn(command, [...args], { cwd, shell, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines: string[] = [];
    let stderr = '';
    let buffer = '';
    let sent = false;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      child.kill();
      if (error !== undefined) reject(error);
      else resolve({ lines, stderr });
    };
    const timer = setTimeout(() => finish(new Error(`応答が揃わなかった。stdout=${lines.join('\n')} stderr=${stderr}`)), 60_000);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on('error', (error) => finish(error));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) if (line.trim() !== '') lines.push(line);
      // initialize の応答が返ってから、残りを送る。
      if (!sent && lines.some((line) => line.includes('"serverInfo"'))) {
        sent = true;
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'data_info', arguments: {} } });
        send({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'win_rate',
            arguments: { lineup: SMALL_LINEUP, track: { location: 10006, course: 10606 }, trials: 12 },
          },
        });
      }
      const ids = lines.flatMap((line) => {
        try {
          return [(JSON.parse(line) as { id?: number }).id];
        } catch {
          return [];
        }
      });
      if (ids.includes(1) && ids.includes(2) && ids.includes(3) && ids.includes(4)) finish();
    });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'stdio-test', version: '0' } },
    });
  });
}

function expectCleanProtocol(result: Handshake): void {
  // すべての行が JSON である。1 行でも違えば、クライアントは接続を切る。
  for (const line of result.lines) {
    expect(() => JSON.parse(line), `JSON ではない行: ${line}`).not.toThrow();
    expect((JSON.parse(line) as { jsonrpc?: string }).jsonrpc).toBe('2.0');
  }
  const byId = new Map(result.lines.map((line) => [(JSON.parse(line) as { id?: number }).id, JSON.parse(line)]));
  const init = byId.get(1) as { result: { instructions?: string; serverInfo: { name: string } } };
  expect(init.result.serverInfo.name).toBe('raceemu');
  // 読み取りの規則（docs/mcp-design.md 3.7 節）が、常に文脈に載る形で渡っている。
  expect(init.result.instructions).toContain('statusRank');
  const tools = byId.get(2) as { result: { tools: { name: string }[] } };
  expect(tools.result.tools.map((tool) => tool.name)).toContain('data_info');
  const info = byId.get(3) as { result: { isError?: boolean; structuredContent: { skills: { total: number } } } };
  expect(info.result.isError).not.toBe(true);
  expect(info.result.structuredContent.skills.total).toBeGreaterThan(1000);
  // Worker を立てて回した win_rate も、標準出力に何も混ぜずに返る（上で全行が JSON だと確かめている）。
  const win = byId.get(4) as { result: { isError?: boolean; structuredContent: { trials: number; runners: unknown[] } } };
  expect(win.result.isError).not.toBe(true);
  expect(win.result.structuredContent.trials).toBe(12);
  expect(win.result.structuredContent.runners).toHaveLength(2);
  // ログは標準エラー出力へ出ている。
  expect(result.stderr).toContain('[raceemu-mcp]');
}

describe('標準出力は JSON-RPC だけである', () => {
  it('リポジトリの外から、node と tsx を絶対パスで呼ぶ形（Claude Desktop の設定向け）', async () => {
    expectCleanProtocol(await handshake(process.execPath, [tsxCli, main], tmpdir(), false));
  });

  it('リポジトリの中から pnpm -s mcp で起動する形（Claude Code の .mcp.json 向け）', async () => {
    expectCleanProtocol(await handshake('pnpm', ['-s', 'mcp'], root, process.platform === 'win32'));
  });

  it('-s を付けない pnpm mcp は、標準出力にヘッダが混ざる（-s が要る理由の確認）', async () => {
    // これが通るのは、pnpm が今も標準出力にヘッダを出しているから。出さなくなったら、
    // -s を付けるという注意書き（設計書 2.1 節）は不要になるので、このテストごと消してよい。
    await expect(handshake('pnpm', ['mcp'], root, process.platform === 'win32').then(expectCleanProtocol)).rejects.toThrow();
  });
});
