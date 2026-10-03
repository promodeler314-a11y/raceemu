import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGameData, type GameData } from './index.ts';

const defaultAssetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

/**
 * アセットの置き場。環境変数 `RACEEMU_ASSETS_DIR` で別の場所を指せる。
 *
 * 本家から取り直した新しいデータを、リポジトリの `assets` を書き換えずに試すために使う
 * （docs/mcp-design.md 5 節）。`index.ts` ではなくここに置くのは、`index.ts` が
 * ブラウザのバンドルに入るためである。
 */
export function assetsDir(): string {
  const override = process.env['RACEEMU_ASSETS_DIR'];
  return override !== undefined && override !== '' ? override : defaultAssetsDir;
}

let cached: GameData | null = null;
let cachedDir: string | null = null;

/** Node 上でアセットを読み込む。 */
export function loadGameData(): GameData {
  const dir = assetsDir();
  if (cached !== null && cachedDir === dir) return cached;
  const courses = JSON.parse(readFileSync(join(dir, 'courses.json'), 'utf8'));
  const skills = JSON.parse(readFileSync(join(dir, 'skills.json'), 'utf8'));
  cached = buildGameData(courses, skills);
  cachedDir = dir;
  return cached;
}

/** `assets/meta.json`。取り直した日と、4 つのデータの指紋。 */
export interface DataMeta {
  readonly syncedAt: string;
  readonly digest: string;
  readonly source: string;
}

/** `meta.json` を読む。無い、または壊れていれば null。 */
export function loadDataMeta(): DataMeta | null {
  const path = join(assetsDir(), 'meta.json');
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<DataMeta>;
    if (typeof raw.syncedAt !== 'string' || typeof raw.digest !== 'string' || typeof raw.source !== 'string') {
      return null;
    }
    return { syncedAt: raw.syncedAt, digest: raw.digest, source: raw.source };
  } catch {
    return null;
  }
}
