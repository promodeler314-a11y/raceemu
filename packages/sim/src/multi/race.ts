import { goal, updateFrame, type RaceCalculator } from '../calculator.ts';
import { RngSet } from '../rng.ts';
import type { RaceSetting } from '../setting.ts';
import type { RaceSimulationResult, RaceState } from '../state.ts';
import { LiveField } from './field.ts';

/**
 * 出走する全頭を同時に走らせる。
 *
 * 1 フレームを二段階に分け、先に全頭の startPosition を置いてから全頭を進める。
 * こうしないと、先に進めた頭は前フレームの位置を、後の頭は今フレームの位置を
 * 見ることになり、並び順が結果に効いてしまう。
 * docs/multi-horse-design.md を参照。
 */

export interface MultiEntry {
  readonly setting: RaceSetting;
  /** 表示に使う名前。空でよい。 */
  readonly label?: string;
  /**
   * 乱数の種。指定すると出走順に依存しなくなる。
   * 並び順を変えても同じ走りを再現したいときに使う。
   */
  readonly seed?: number;
}

export interface MultiRaceOptions {
  readonly seed: number;
  readonly trial: number;
  /** フレーム列を記録する出走番号。詳細表示に使う。 */
  readonly recordFramesFor?: number;
  /** 各フレームの終わりに呼ばれる。隊列を描いたり、位置取りを数えたりするのに使う。 */
  readonly onFrame?: (frame: number, states: readonly RaceState[]) => void;
}

export interface MultiEntryResult {
  /** 出走番号。entries の添字と同じ。 */
  readonly index: number;
  /** 1 着を 1 とする着順 */
  readonly order: number;
  readonly result: RaceSimulationResult;
}

export interface MultiRaceOutput {
  readonly entries: readonly MultiEntryResult[];
  readonly states: readonly RaceState[];
  /** 全頭がゴールするまでに要したフレーム数 */
  readonly frames: number;
}

/** 頭ごとに乱数の種を分ける。0 番は単独で走らせたときと同じ出目になる。 */
export function entrySeed(seed: number, index: number): number {
  return index === 0 ? seed : (seed ^ Math.imul(index, 0x9e3779b1)) >>> 0;
}

/** 走り切らないレースを打ち切る上限。1 フレームは 1/15 秒なので 400 秒ぶん。 */
const MAX_FRAMES = 6000;

/**
 * 枠番を割り振る。
 *
 * 枠番を 0（おまかせ）にした頭が複数いると、それぞれが勝手に引いて同じ枠に
 * 重なりうる。実際のレースでは重ならないので、空いている枠から配る。
 */
function assignGates(
  entries: readonly MultiEntry[],
  gateCount: number,
  seed: number,
  trial: number,
): number[] {
  const gates = entries.map((entry) => entry.setting.uma.gateNumber);
  const used = new Set(gates.filter((gate) => gate >= 1 && gate <= gateCount));
  const free: number[] = [];
  for (let gate = 1; gate <= gateCount; gate++) if (!used.has(gate)) free.push(gate);
  // 試行ごとに配り方を変える。同じ試行番号なら同じ配り方になる。
  const rng = new RngSet(seed, trial).stream('gateAssign');
  for (let i = free.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    [free[i], free[j]] = [free[j]!, free[i]!];
  }
  let next = 0;
  return gates.map((gate) => (gate >= 1 && gate <= gateCount ? gate : (free[next++] ?? 1)));
}

export function runMultiRace(
  calculator: RaceCalculator,
  entries: readonly MultiEntry[],
  options: MultiRaceOptions,
): MultiRaceOutput {
  const count = entries.length;
  if (count === 0) throw new Error('出走頭数が 0 である');
  const gateCount = entries[0]!.setting.track.gateCount;
  const gates = assignGates(entries, gateCount, options.seed, options.trial);

  // LiveField は配列の参照を持つ。作りながら埋めていくので、
  // 途中の頭は自分より後の頭を見られないが、その時点では全頭が同じ位置にいる。
  const states: RaceState[] = [];
  const fields: LiveField[] = [];
  for (let i = 0; i < count; i++) {
    const entry = entries[i]!;
    const field = new LiveField(states, i, count);
    // 位置取りは実在の先頭に対して行う。専用の仮想先頭馬は作らない。
    const setting: RaceSetting = {
      ...entry.setting,
      uma: { ...entry.setting.uma, gateNumber: gates[i]! },
      positionKeepMode: 'VIRTUAL',
      virtualLeader: undefined,
      virtualLeaderSkills: undefined,
    };
    const state = calculator.createState(setting, {
      seed: entry.seed ?? entrySeed(options.seed, i),
      trial: options.trial,
      recordFrames: options.recordFramesFor === i,
      field,
    });
    state.paceMakerSource = () => field.leader();
    states.push(state);
    fields.push(field);
  }

  const results: (RaceSimulationResult | null)[] = new Array(count).fill(null);
  let remaining = count;
  let frames = 0;
  while (remaining > 0 && frames < MAX_FRAMES) {
    // 第 1 段。ゴール済みの頭も置き直しておくと、位置がコース長のまま前に残る。
    for (let i = 0; i < count; i++) {
      const simulation = states[i]!.simulation;
      simulation.startPosition = simulation.position;
    }
    // 第 2 段
    for (let i = 0; i < count; i++) {
      if (results[i] !== null) continue;
      const state = states[i]!;
      const stopped = updateFrame(state);
      if (stopped || state.simulation.position >= state.setting.courseLength) {
        results[i] = goal(state);
        remaining--;
      }
    }
    frames++;
    options.onFrame?.(frames, states);
  }
  // 打ち切りに掛かった頭も、そこまでの状態から結果を作る
  for (let i = 0; i < count; i++) if (results[i] === null) results[i] = goal(states[i]!);

  const order = [...results.keys()].sort((a, b) => results[a]!.raceTime - results[b]!.raceTime);
  const placed: MultiEntryResult[] = new Array(count);
  order.forEach((index, rank) => {
    placed[index] = { index, order: rank + 1, result: results[index]! };
  });
  return { entries: placed, states, frames };
}
