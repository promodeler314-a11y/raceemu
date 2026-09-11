import charas from '../assets/charas.json';
import supports from '../assets/supports.json';
import { buildDeckData, type DeckData } from './deck.ts';

let cached: DeckData | null = null;

/** ブラウザ向け。JSON はバンドル時に埋め込まれる。 */
export function loadDeckData(): DeckData {
  if (cached === null) cached = buildDeckData(supports, charas);
  return cached;
}
