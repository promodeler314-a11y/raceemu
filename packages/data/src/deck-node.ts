import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDeckData, type DeckData } from './deck.ts';

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

let cached: DeckData | null = null;

/** Node 上でアセットを読み込む。 */
export function loadDeckData(): DeckData {
  if (cached !== null) return cached;
  const supports = JSON.parse(readFileSync(join(assetsDir, 'supports.json'), 'utf8'));
  const charas = JSON.parse(readFileSync(join(assetsDir, 'charas.json'), 'utf8'));
  cached = buildDeckData(supports, charas);
  return cached;
}
