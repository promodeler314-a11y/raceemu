import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGameData, type GameData } from './index.ts';

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

let cached: GameData | null = null;

/** Node 上でアセットを読み込む。 */
export function loadGameData(): GameData {
  if (cached !== null) return cached;
  const courses = JSON.parse(readFileSync(join(assetsDir, 'courses.json'), 'utf8'));
  const skills = JSON.parse(readFileSync(join(assetsDir, 'skills.json'), 'utf8'));
  cached = buildGameData(courses, skills);
  return cached;
}
