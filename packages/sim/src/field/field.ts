import { RaceCalculator } from '../calculator.ts';
import { framePerSecond, type Style } from '../data/constants.ts';
import type { RaceTrack } from '../data/track.ts';
import { runMultiRace, type MultiEntry } from '../multi/race.ts';
import type { RaceSetting, SystemSetting, TrackRef, UmaStatus } from '../setting.ts';
import type { SkillData } from '../skill/types.ts';
import type { RaceState } from '../state.ts';

/**
 * 他のウマ娘の位置の時系列。
 *
 * 他馬は自分の影響を受けないと割り切る。そのぶんフィールドは自分の構成に
 * 依存しないので、あらかじめ生成してキャッシュし、すべての試行と探索候補で
 * 使い回せる。実行時に要るのは位置の比較だけである。
 * docs/order-condition.md 5 節を参照。
 */
export interface FieldSample {
  /** 出走頭数から自分を除いた数 */
  readonly opponents: number;
  /** フレーム数。全頭がゴールするまでの長さ。 */
  readonly frames: number;
  /**
   * 位置の平坦な配列。`positions[frame * opponents + i]` が i 番目の位置。
   * ゴール後はコース長のままにしておく。
   */
  readonly positions: Float64Array;
  /** 相手の脚質。位置取りの判定が先頭馬の脚質を読むので持たせる。 */
  readonly styles: readonly Style[];
}

export interface FieldBundle {
  readonly samples: readonly FieldSample[];
  readonly opponents: number;
  readonly courseLength: number;
}

/** 相手の想定。脚質ごとの頭数と、共通のステータス。 */
export interface FieldProfile {
  readonly counts: Readonly<Record<Style, number>>;
  readonly uma: Omit<UmaStatus, 'style' | 'charaName'>;
}

/** チャンピオンズミーティング（9 頭）とリーグオブヒーローズ（12 頭）の既定 */
export function defaultFieldProfile(gateCount: number): FieldProfile {
  const uma: FieldProfile['uma'] = {
    speed: 1100,
    stamina: 900,
    power: 900,
    guts: 600,
    wisdom: 900,
    condition: 'BEST',
    distanceFit: 'A',
    surfaceFit: 'A',
    styleFit: 'A',
    popularity: 5,
    gateNumber: 0,
    uniqueLevel: 6,
  };
  // 自分を除いた頭数を、逃げ 2 割、先行 3 割、差し 3 割、追込 2 割で割り振る
  const total = gateCount - 1;
  const nige = Math.max(1, Math.round(total * 0.2));
  const sen = Math.max(1, Math.round(total * 0.3));
  const sasi = Math.max(1, Math.round(total * 0.3));
  const oi = Math.max(0, total - nige - sen - sasi);
  return { counts: { NIGE: nige, SEN: sen, SASI: sasi, OI: oi, OONIGE: 0 }, uma };
}

/** 相手の想定から、相手 N-1 頭ぶんの設定を作る。全頭同時に走らせる側でも使う。 */
export function opponentSettings(
  profile: FieldProfile,
  track: TrackRef,
  skills: readonly SkillData[],
): RaceSetting[] {
  const settings: RaceSetting[] = [];
  const styles: Style[] = ['NIGE', 'SEN', 'SASI', 'OI'];
  for (const style of styles) {
    for (let i = 0; i < (profile.counts[style] ?? 0); i++) {
      settings.push({
        uma: { ...profile.uma, charaName: '', style },
        track,
        skills: [...skills],
        skillActivateAdjustment: 'NONE',
        randomPosition: 'RANDOM',
        debuffCounts: {},
        positionKeepMode: 'APPROXIMATE',
        positionKeepRate: 100,
      });
    }
  }
  return settings;
}

/**
 * フィールドの束を作る。
 *
 * 相手 8 頭を一緒に走らせて位置を記録する。
 * 1 頭ずつ独立に回すと、相手は先頭に対して詰めたり離れたりしないので、
 * 同じ脚質どうしが縦に伸びずに塊になり、自分は塊の前か後ろにしか居られない。
 * 順位が塊の境目にしか出ないため、3 位以内や 6 位以降のような条件が
 * 量子化で 0 % になる。docs/order-field.md 2.3 節と 4.1 節を参照。
 */
export function buildFieldBundle(
  profile: FieldProfile,
  track: TrackRef,
  system: SystemSetting,
  trackData: Record<number, RaceTrack>,
  options: { readonly samples: number; readonly seed: number; readonly skills?: readonly SkillData[] },
): FieldBundle {
  const settings = opponentSettings(profile, track, options.skills ?? []);
  const styles = settings.map((setting) => setting.uma.style);
  const calculator = new RaceCalculator(system, trackData);
  const courseLength = trackData[track.location]?.courses[track.course]?.distance ?? 0;
  // 相手も実在の先頭に対して位置取りする。勝率の面と同じ規則にする。
  const entries: MultiEntry[] = settings.map((setting) => ({
    setting: { ...setting, positionKeepMode: 'VIRTUAL' },
  }));

  const samples: FieldSample[] = [];
  const opponents = settings.length;
  for (let s = 0; s < options.samples; s++) {
    const rows: number[][] = [];
    runMultiRace(calculator, entries, {
      seed: options.seed,
      trial: s,
      onFrame: (_frame, states) => {
        rows.push(states.map((state) => Math.min(state.simulation.startPosition, courseLength)));
      },
    });
    const frames = Math.max(1, rows.length);
    const positions = new Float64Array(frames * opponents);
    for (let f = 0; f < rows.length; f++) {
      for (let i = 0; i < opponents; i++) positions[f * opponents + i] = rows[f]![i]!;
    }
    samples.push({ opponents, frames, positions, styles });
  }
  return { samples, opponents, courseLength };
}

/**
 * レース中の順位を、フィールドの 1 本と自分の位置から求める。
 * 毎フレームの計算は頭数に比例するだけで、多くても 18 回の比較で済む。
 */
/**
 * 順位と距離差の問い合わせ口。
 *
 * 条件の判定側はこの 5 つしか呼ばない。
 * あらかじめ作った束を読む実装と、同時に走っている他頭を読む実装があり、
 * 差し替えても判定側は変わらない。
 * docs/multi-horse-design.md 2 節を参照。
 */
export interface FieldView {
  readonly opponents: number;
  readonly gateCount: number;
  /** 1 位を 1 とする順位 */
  order(frameElapsed: number, position: number): number;
  /** 先頭との距離。自分が先頭なら 0。 */
  distanceFromTop(frameElapsed: number, position: number): number;
  /** すぐ前にいるウマ娘との距離。前がいなければ無限。 */
  distanceToFront(frameElapsed: number, position: number): number;
  /** すぐ後ろにいるウマ娘との距離。後ろがいなければ無限。 */
  distanceToBehind(frameElapsed: number, position: number): number;
  /** 先頭から最後方までの隔たり。全員が同じ位置なら 0。 */
  spread(frameElapsed: number, position: number): number;
  /**
   * 位置取りの判定に渡す先頭馬。
   *
   * 判定が読むのは先頭の `startPosition` と脚質だけなので、その 2 つが揃っていればよい。
   * docs/order-field.md 4.2 節を参照。
   */
  paceMaker(frameElapsed: number): RaceState | null;
}

/** あらかじめ作った束の 1 本を読む実装 */
export class RecordedField implements FieldView {
  private readonly sample: FieldSample;
  /**
   * 位置取りに渡す先頭馬の器。
   *
   * 位置取りの判定は `simulation.startPosition` と `setting.basicRunningStyle` しか
   * 読まないので、その 2 つだけを持つ器を使い回す。毎フレーム作り直さない。
   */
  private readonly leader = {
    simulation: { startPosition: 0 },
    setting: { basicRunningStyle: 'NIGE' as Style },
  };

  constructor(
    bundle: FieldBundle,
    /** 束の中のどの 1 本を使うか。試行番号から選ぶ。 */
    index: number,
  ) {
    this.sample = bundle.samples[index % bundle.samples.length]!;
  }

  get opponents(): number {
    return this.sample.opponents;
  }

  get gateCount(): number {
    return this.sample.opponents + 1;
  }

  /** 1 位を 1 とする順位 */
  order(frameElapsed: number, position: number): number {
    const { frames, opponents, positions } = this.sample;
    const frame = Math.min(frameElapsed, frames - 1);
    const offset = frame * opponents;
    let ahead = 0;
    for (let i = 0; i < opponents; i++) {
      if (positions[offset + i]! > position) ahead++;
    }
    return ahead + 1;
  }

  /** 先頭との距離。自分が先頭なら 0。 */
  distanceFromTop(frameElapsed: number, position: number): number {
    const { frames, opponents, positions } = this.sample;
    const frame = Math.min(frameElapsed, frames - 1);
    const offset = frame * opponents;
    let top = position;
    for (let i = 0; i < opponents; i++) {
      const other = positions[offset + i]!;
      if (other > top) top = other;
    }
    return top - position;
  }

  /** すぐ前にいるウマ娘との距離。前がいなければ無限。 */
  distanceToFront(frameElapsed: number, position: number): number {
    const { frames, opponents, positions } = this.sample;
    const frame = Math.min(frameElapsed, frames - 1);
    const offset = frame * opponents;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < opponents; i++) {
      const gap = positions[offset + i]! - position;
      if (gap > 0 && gap < best) best = gap;
    }
    return best;
  }

  /** すぐ後ろにいるウマ娘との距離。後ろがいなければ無限。 */
  distanceToBehind(frameElapsed: number, position: number): number {
    const { frames, opponents, positions } = this.sample;
    const frame = Math.min(frameElapsed, frames - 1);
    const offset = frame * opponents;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < opponents; i++) {
      const gap = position - positions[offset + i]!;
      if (gap > 0 && gap < best) best = gap;
    }
    return best;
  }

  /** そのフレームで最も前にいる相手を、位置取りの判定に渡す形で返す。 */
  paceMaker(frameElapsed: number): RaceState | null {
    const { frames, opponents, positions, styles } = this.sample;
    const frame = Math.min(frameElapsed, frames - 1);
    const offset = frame * opponents;
    let best = Number.NEGATIVE_INFINITY;
    let at = 0;
    for (let i = 0; i < opponents; i++) {
      const other = positions[offset + i]!;
      if (other > best) {
        best = other;
        at = i;
      }
    }
    this.leader.simulation.startPosition = best;
    this.leader.setting.basicRunningStyle = styles[at] ?? 'NIGE';
    return this.leader as unknown as RaceState;
  }

  /** 先頭から最後方までの隔たり。全員が同じ位置なら 0。 */
  spread(frameElapsed: number, position: number): number {
    const { frames, opponents, positions } = this.sample;
    const frame = Math.min(frameElapsed, frames - 1);
    const offset = frame * opponents;
    let top = position;
    let last = position;
    for (let i = 0; i < opponents; i++) {
      const other = positions[offset + i]!;
      if (other > top) top = other;
      if (other < last) last = other;
    }
    return top - last;
  }
}

export const FRAMES_PER_SECOND = framePerSecond;
