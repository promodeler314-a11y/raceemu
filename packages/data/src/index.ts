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

export * from './skill-match.ts';

export * from './deck.ts';
