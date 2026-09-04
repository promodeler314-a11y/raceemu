import { RaceCalculator } from '../calculator.ts';
import type { SystemSetting } from '../setting.ts';
import type { RaceSimulationResult } from '../state.ts';
import {
  fromSerializable,
  packResults,
  SKILL_STAT,
  SKILL_STAT_FIELDS,
  type SerializableRaceSetting,
  type SimData,
} from './protocol.ts';

/**
 * 1 つの塊を計算する。Worker の中でも UI スレッドでも同じ関数を使う。
 * フレーム列は作らない。統計だけが要る呼び出しなので、割り当てを減らす。
 */
export interface ChunkOutput {
  readonly packed: Float64Array;
  readonly skillStats: Float64Array;
}

export function runChunk(
  data: SimData,
  setting: SerializableRaceSetting,
  system: SystemSetting,
  seed: number,
  from: number,
  count: number,
): ChunkOutput {
  const resolved = fromSerializable(setting, data);
  const calculator = new RaceCalculator(system, data.trackData);
  const results: RaceSimulationResult[] = new Array(count);
  const skillIds = setting.skillIds;
  const index = new Map(skillIds.map((id, i) => [id, i]));
  const skillStats = new Float64Array(skillIds.length * SKILL_STAT_FIELDS);

  for (let i = 0; i < count; i++) {
    const { result, state } = calculator.simulate(resolved, { seed, trial: from + i });
    results[i] = result;
    for (const [skillId, trace] of state.simulation.skillTrace) {
      const slot = index.get(skillId);
      if (slot === undefined) continue;
      const offset = slot * SKILL_STAT_FIELDS;
      skillStats[offset + SKILL_STAT.triggered] += 1;
      skillStats[offset + SKILL_STAT.sumFirstPosition] += trace.firstPosition;
      if (trace.count >= 2) {
        skillStats[offset + SKILL_STAT.doubleTriggered] += 1;
        skillStats[offset + SKILL_STAT.sumSecondPosition] += trace.secondPosition;
      }
      const phase = Math.max(0, Math.min(3, trace.firstPhase));
      skillStats[offset + SKILL_STAT.phase0 + phase] += 1;
    }
  }
  return { packed: packResults(results), skillStats };
}
