import courses from '../assets/courses.json';
import skills from '../assets/skills.json';
import { buildGameData, type GameData } from './index.ts';

let cached: GameData | null = null;

/** ブラウザ向け。JSON はバンドル時に埋め込まれる。 */
export function loadGameData(): GameData {
  if (cached === null) cached = buildGameData(courses, skills);
  return cached;
}
