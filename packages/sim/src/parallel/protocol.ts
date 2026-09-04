import type { RaceTrack } from '../data/track.ts';
import type { RaceSetting, SystemSetting } from '../setting.ts';
import type { SkillData } from '../skill/types.ts';
import type { RaceSimulationResult } from '../state.ts';

/**
 * Worker との受け渡しに使う形。構造化クローンで送れるプレーンな値だけを持つ。
 * スキルは実体ではなく ID で送り、Worker 側が自分の持つデータから引き直す。
 */
export type SerializableRaceSetting = Omit<RaceSetting, 'skills' | 'virtualLeaderSkills'> & {
  readonly skillIds: readonly string[];
  readonly virtualLeaderSkillIds?: readonly string[];
};

export interface SimData {
  readonly trackData: Record<number, RaceTrack>;
  readonly skillsById: ReadonlyMap<string, SkillData>;
}

export function toSerializable(setting: RaceSetting): SerializableRaceSetting {
  const { skills, virtualLeaderSkills, ...rest } = setting;
  return {
    ...rest,
    skillIds: skills.map((skill) => skill.id),
    virtualLeaderSkillIds: virtualLeaderSkills?.map((skill) => skill.id),
  };
}

export function fromSerializable(setting: SerializableRaceSetting, data: SimData): RaceSetting {
  const resolve = (ids: readonly string[]): SkillData[] =>
    ids.map((id) => {
      const skill = data.skillsById.get(id);
      if (skill === undefined) throw new Error(`スキルが見つからない: ${id}`);
      return skill;
    });
  const { skillIds, virtualLeaderSkillIds, ...rest } = setting;
  return {
    ...rest,
    skills: resolve(skillIds),
    virtualLeaderSkills: virtualLeaderSkillIds === undefined ? undefined : resolve(virtualLeaderSkillIds),
  };
}

/** 1 試行あたりに詰める値の数 */
export const RESULT_FIELDS = 10;

export function packResults(results: readonly RaceSimulationResult[]): Float64Array {
  const packed = new Float64Array(results.length * RESULT_FIELDS);
  results.forEach((r, i) => {
    const offset = i * RESULT_FIELDS;
    packed[offset] = r.raceTime;
    packed[offset + 1] = r.raceTimeDelta;
    packed[offset + 2] = r.raceTimeWithoutRunUp;
    packed[offset + 3] = r.maxSpurt ? 1 : 0;
    packed[offset + 4] = r.spDiff;
    packed[offset + 5] = r.positionCompetitionCount;
    packed[offset + 6] = r.staminaKeepDistance;
    packed[offset + 7] = r.competeFightFinished ? 1 : 0;
    packed[offset + 8] = r.competeFightTime;
    packed[offset + 9] = r.goalSp;
  });
  return packed;
}

export function unpackResults(packed: Float64Array): RaceSimulationResult[] {
  const count = packed.length / RESULT_FIELDS;
  const results: RaceSimulationResult[] = new Array(count);
  for (let i = 0; i < count; i++) {
    const offset = i * RESULT_FIELDS;
    results[i] = {
      raceTime: packed[offset]!,
      raceTimeDelta: packed[offset + 1]!,
      raceTimeWithoutRunUp: packed[offset + 2]!,
      maxSpurt: packed[offset + 3] === 1,
      spDiff: packed[offset + 4]!,
      positionCompetitionCount: packed[offset + 5]!,
      staminaKeepDistance: packed[offset + 6]!,
      competeFightFinished: packed[offset + 7] === 1,
      competeFightTime: packed[offset + 8]!,
      goalSp: packed[offset + 9]!,
    };
  }
  return results;
}

export interface ChunkRequest {
  readonly kind: 'chunk';
  readonly id: number;
  readonly setting: SerializableRaceSetting;
  readonly system: SystemSetting;
  readonly seed: number;
  /** この塊が担当する最初の試行番号 */
  readonly from: number;
  readonly count: number;
}

export interface ChunkResponse {
  readonly kind: 'chunk';
  readonly id: number;
  readonly packed: Float64Array;
  /** スキルごとの集計。設定のスキル順に SKILL_STAT_FIELDS 個ずつ並ぶ。 */
  readonly skillStats: Float64Array;
}

/** スキル 1 つあたりに集計する値の数 */
export const SKILL_STAT_FIELDS = 8;

export const SKILL_STAT = {
  triggered: 0,
  sumFirstPosition: 1,
  doubleTriggered: 2,
  sumSecondPosition: 3,
  phase0: 4,
  phase1: 5,
  phase2: 6,
  phase3: 7,
} as const;

export interface SkillSummary {
  readonly skillId: string;
  readonly trials: number;
  readonly triggerRate: number;
  readonly averageFirstPosition: number;
  readonly doubleTriggerRate: number;
  readonly averageSecondPosition: number;
  /** 初回発動がどのフェーズだったかの割合。添字はフェーズ番号。 */
  readonly phaseRates: readonly number[];
}

export function toSkillSummaries(
  skillIds: readonly string[],
  stats: Float64Array,
  trials: number,
): SkillSummary[] {
  return skillIds.map((skillId, i) => {
    const at = (field: number) => stats[i * SKILL_STAT_FIELDS + field] ?? 0;
    const triggered = at(SKILL_STAT.triggered);
    const doubled = at(SKILL_STAT.doubleTriggered);
    return {
      skillId,
      trials,
      triggerRate: trials === 0 ? 0 : triggered / trials,
      averageFirstPosition: triggered === 0 ? Number.NaN : at(SKILL_STAT.sumFirstPosition) / triggered,
      doubleTriggerRate: trials === 0 ? 0 : doubled / trials,
      averageSecondPosition: doubled === 0 ? Number.NaN : at(SKILL_STAT.sumSecondPosition) / doubled,
      phaseRates: [
        triggered === 0 ? 0 : at(SKILL_STAT.phase0) / triggered,
        triggered === 0 ? 0 : at(SKILL_STAT.phase1) / triggered,
        triggered === 0 ? 0 : at(SKILL_STAT.phase2) / triggered,
        triggered === 0 ? 0 : at(SKILL_STAT.phase3) / triggered,
      ],
    };
  });
}

export interface ErrorResponse {
  readonly kind: 'error';
  readonly id: number;
  readonly message: string;
}

export type WorkerRequest = ChunkRequest;
export type WorkerResponse = ChunkResponse | ErrorResponse;
