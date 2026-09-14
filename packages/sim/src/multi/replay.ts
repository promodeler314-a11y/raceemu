import type { RaceCalculator } from '../calculator.ts';
import { framePerSecond } from '../data/constants.ts';
import type { Style } from '../data/constants.ts';
import type { TrackDetail } from '../data/track.ts';
import type { RaceFrame, RaceSimulationResult } from '../state.ts';
import { runMultiRace, type MultiEntry } from './race.ts';

/**
 * 全頭同時のレースを 1 試行だけ走らせ直し、全頭の走りを取り出す。
 *
 * **フレーム列は保持しない。** 勝率は数百から数万試行を回すので、全試行ぶんの
 * 位置と速度を抱えると桁違いの量になる。乱数は `(baseSeed, trial, streamKey)`
 * から決まる（`rng.ts`）ので、試行番号さえ渡せば同じレースがもう一度出る。
 * 開きたい 1 本だけをその場で走らせ直すほうが、持ち回るより安い。
 * docs/multi-horse-design.md 7 節を参照。
 */

/** 1 頭ぶんの走り。添字はフレーム番号 − 1（先頭のスタート前フレームは外してある）。 */
export interface HorseTrace {
  /** 出走番号。0 番が自分。 */
  readonly index: number;
  /** 1 着を 1 とする着順 */
  readonly order: number;
  readonly raceTime: number;
  readonly style: Style;
  readonly gateNumber: number;
  /** フレームの頭での位置 (m) */
  readonly positions: Float64Array;
  /** 同じフレームの頭での速度 (m/s) */
  readonly speeds: Float64Array;
}

export interface MultiReplay {
  readonly seed: number;
  readonly trial: number;
  /** 最も長く走った頭のフレーム数。`times` の長さと同じ。 */
  readonly frames: number;
  /** フレームごとの時刻 (秒)。`positions` と添字が揃う。 */
  readonly times: Float64Array;
  readonly horses: readonly HorseTrace[];
  readonly courseLength: number;
  /** コーナーとフェーズの境目を図に敷くのに使う。 */
  readonly trackDetail: TrackDetail;
  /** 中身を詳しく見る頭の出走番号。既定は自分（0 番）。 */
  readonly focus: number;
  /**
   * `focus` の頭のフレーム列。スキルの発動位置を拾うのに使う。
   * こちらはスタート前のフレームを含む（時刻 = 添字 / framePerSecond）。
   */
  readonly focusFrames: readonly RaceFrame[];
  readonly focusResult: RaceSimulationResult;
  readonly focusSpMax: number;
}

export function replayMultiRace(
  calculator: RaceCalculator,
  entries: readonly MultiEntry[],
  options: { readonly seed: number; readonly trial: number; readonly focus?: number },
): MultiReplay {
  const focus = options.focus ?? 0;
  const output = runMultiRace(calculator, entries, {
    seed: options.seed,
    trial: options.trial,
    recordAllFrames: true,
  });

  const horses: HorseTrace[] = output.entries.map((entry) => {
    const state = output.states[entry.index]!;
    // 先頭はスタート前の記録用フレームで速度 0 なので、図からは外す。
    // 単騎の詳細（Charts.tsx）と同じ扱いである。
    const frames = state.simulation.frames.slice(1);
    const positions = new Float64Array(frames.length);
    const speeds = new Float64Array(frames.length);
    for (let i = 0; i < frames.length; i++) {
      positions[i] = frames[i]!.startPosition;
      speeds[i] = frames[i]!.speed;
    }
    return {
      index: entry.index,
      order: entry.order,
      raceTime: entry.result.raceTime,
      style: state.setting.base.uma.style,
      gateNumber: state.setting.base.uma.gateNumber,
      positions,
      speeds,
    };
  });

  const frames = horses.reduce((longest, horse) => Math.max(longest, horse.positions.length), 0);
  const times = new Float64Array(frames);
  // 添字 i は元のフレーム番号 i + 1 にあたる（先頭を外したため）。
  for (let i = 0; i < frames; i++) times[i] = (i + 1) / framePerSecond;

  const focusState = output.states[focus]!;
  const focusEntry = output.entries.find((entry) => entry.index === focus)!;
  return {
    seed: options.seed,
    trial: options.trial,
    frames,
    times,
    horses,
    courseLength: focusState.setting.courseLength,
    trackDetail: focusState.setting.trackDetail,
    focus,
    focusFrames: focusState.simulation.frames,
    focusResult: focusEntry.result,
    focusSpMax: focusState.setting.spMax,
  };
}
