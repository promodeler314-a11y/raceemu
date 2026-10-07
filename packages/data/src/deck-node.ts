import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDeckData, type DeckData } from './deck.ts';
import { assetsDir } from './node.ts';

let cached: DeckData | null = null;
let cachedDir: string | null = null;

/**
 * Node 上でアセットを読み込む。
 *
 * 置き場は `loadGameData` と同じ `assetsDir()` に揃える（`RACEEMU_ASSETS_DIR` を見る）。
 * 揃えないと、新しいデータを試すときにスキルだけが新しくなり、育成ウマ娘とサポートカードが
 * 古いまま残る（新しいカードが名簿にも育成計画にも出てこない）。
 */
export function loadDeckData(): DeckData {
  const dir = assetsDir();
  if (cached !== null && cachedDir === dir) return cached;
  const supports = JSON.parse(readFileSync(join(dir, 'supports.json'), 'utf8'));
  const charas = JSON.parse(readFileSync(join(dir, 'charas.json'), 'utf8'));
  cached = buildDeckData(supports, charas);
  cachedDir = dir;
  return cached;
}
