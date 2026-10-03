import type { GameData } from '../../../packages/data/src/index.ts';
import type { DataMeta } from '../../../packages/data/src/node.ts';
import { SkillResolver } from '../../../packages/data/src/skill-resolve.ts';
import { defaultDataDir, IndividualStore } from './individuals.ts';
import type { IndividualLookup } from './lineup-service.ts';
import { Runtime } from './runtime.ts';

/**
 * 道具が共有するもの。
 *
 * 計算に使う Worker のプールと個体の保存先は、重いので最初に使われるまで作らない
 * （`data_info` を呼ぶだけで Worker を立てない）。
 */
export interface McpContext {
  readonly data: GameData;
  readonly meta: DataMeta | null;
  readonly resolver: SkillResolver;
  readonly runtime: Runtime;
  /** 保存した個体。出走表の `individual` で指すときに引く。 */
  readonly individuals: IndividualLookup;
  readonly store: IndividualStore;
}

export interface ContextOptions {
  readonly data: GameData;
  readonly meta: DataMeta | null;
  /** 省くと既定の並列数 */
  readonly concurrency?: number;
  /** 個体の保存先。省くと `RACEEMU_MCP_DATA_DIR`、無ければ `~/.raceemu` */
  readonly store?: IndividualStore;
}

export function createContext(options: ContextOptions): McpContext {
  const store = options.store ?? new IndividualStore(defaultDataDir());
  return {
    data: options.data,
    meta: options.meta,
    resolver: new SkillResolver(options.data.skills),
    runtime: new Runtime(options.concurrency),
    individuals: store,
    store,
  };
}

/** ログは標準エラー出力へ。標準出力は JSON-RPC 専用である（docs/mcp-design.md 2.1 節）。 */
export function log(message: string): void {
  process.stderr.write(`[raceemu-mcp] ${message}\n`);
}
