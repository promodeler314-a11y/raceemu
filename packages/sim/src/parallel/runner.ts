import { RaceCalculator } from '../calculator.ts';
import type { SystemSetting } from '../setting.ts';
import type { RaceSimulationResult } from '../state.ts';
import type { CriticalSpec } from './protocol.ts';
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

/**
 * 逆算の塊を計算する。
 *
 * ステータスを動かす以外は、試行番号が同じなら乱数の出目が変わらない。
 * そのため 1 試行の中では目標の達成だけがステータスの関数になり、
 * その最小値を探せばよい。探し方（二分探索か全走査か）は呼び出し側が決める。
 */
export function runCriticalChunk(
  data: SimData,
  setting: SerializableRaceSetting,
  system: SystemSetting,
  seed: number,
  from: number,
  count: number,
  spec: CriticalSpec,
): { values: Float64Array; races: number } {
  const resolved = fromSerializable(setting, data);
  const calculator = new RaceCalculator(system, data.trackData);
  const points: number[] = [];
  for (let value = spec.from; value <= spec.to; value += spec.step) points.push(value);

  const values = new Float64Array(count);
  let races = 0;

  const achieved = (index: number, trial: number): boolean => {
    races++;
    const uma = { ...resolved.uma, [spec.status]: points[index]! };
    const result = calculator.simulate({ ...resolved, uma }, { seed, trial }).result;
    switch (spec.goalKind) {
      case 'maxSpurt':
        return result.maxSpurt;
      case 'finish':
        return result.goalSp >= 0;
      case 'goalSp':
        return result.goalSp >= (spec.goalValue ?? 0);
    }
  };

  for (let i = 0; i < count; i++) {
    const trial = from + i;
    let found = Number.NaN;
    if (spec.method === 'scan') {
      for (let j = 0; j < points.length; j++) {
        if (achieved(j, trial)) {
          found = points[j]!;
          break;
        }
      }
    } else {
      const last = points.length - 1;
      if (achieved(0, trial)) found = points[0]!;
      else if (achieved(last, trial)) {
        let lo = 0;
        let hi = last;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (achieved(mid, trial)) hi = mid;
          else lo = mid;
        }
        found = points[hi]!;
      }
    }
    values[i] = found;
  }
  return { values, races };
}
