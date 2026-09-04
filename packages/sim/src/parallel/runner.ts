import { RaceCalculator } from '../calculator.ts';
import type { SystemSetting } from '../setting.ts';
import type { RaceSimulationResult } from '../state.ts';
import {
  fromSerializable,
  packResults,
  type SerializableRaceSetting,
  type SimData,
} from './protocol.ts';

/**
 * 1 つの塊を計算する。Worker の中でも UI スレッドでも同じ関数を使う。
 * フレーム列は作らない。統計だけが要る呼び出しなので、割り当てを減らす。
 */
export function runChunk(
  data: SimData,
  setting: SerializableRaceSetting,
  system: SystemSetting,
  seed: number,
  from: number,
  count: number,
): Float64Array {
  const resolved = fromSerializable(setting, data);
  const calculator = new RaceCalculator(system, data.trackData);
  const results: RaceSimulationResult[] = new Array(count);
  for (let i = 0; i < count; i++) {
    results[i] = calculator.simulate(resolved, { seed, trial: from + i }).result;
  }
  return packResults(results);
}
