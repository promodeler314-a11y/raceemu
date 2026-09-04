import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTrackData, type RaceTrack } from '../../sim/src/data/track.ts';
import { SkillData, type RawSkillData } from '../../sim/src/skill/types.ts';

export interface GameData {
  readonly trackData: Record<number, RaceTrack>;
  readonly skills: readonly SkillData[];
  readonly skillsById: ReadonlyMap<string, SkillData>;
  readonly skillsByName: ReadonlyMap<string, SkillData[]>;
}

export function buildGameData(coursesJson: unknown, skillsJson: unknown): GameData {
  const trackData = buildTrackData(coursesJson as never);
  const skills = (skillsJson as RawSkillData[]).map((raw) => SkillData.fromRaw(raw));
  const skillsById = new Map<string, SkillData>();
  const skillsByName = new Map<string, SkillData[]>();
  for (const skill of skills) {
    skillsById.set(skill.id, skill);
    const list = skillsByName.get(skill.name);
    if (list === undefined) skillsByName.set(skill.name, [skill]);
    else list.push(skill);
  }
  return { trackData, skills, skillsById, skillsByName };
}

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

let cached: GameData | null = null;

/** Node 上でアセットを読み込む。ブラウザ側ではバンドルした JSON を buildGameData に渡す。 */
export function loadGameData(): GameData {
  if (cached !== null) return cached;
  const courses = JSON.parse(readFileSync(join(assetsDir, 'courses.json'), 'utf8'));
  const skills = JSON.parse(readFileSync(join(assetsDir, 'skills.json'), 'utf8'));
  cached = buildGameData(courses, skills);
  return cached;
}
