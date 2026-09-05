import { RaceCalculator } from '../calculator.ts';
import { framePerSecond, type Style } from '../data/constants.ts';
import type { RaceTrack } from '../data/track.ts';
import type { RaceSetting, SystemSetting, TrackRef, UmaStatus } from '../setting.ts';
import type { SkillData } from '../skill/types.ts';

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

function opponentSettings(
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
 * 1 本の軌跡は相手 1 頭ぶんのレースを普通に回して位置を記録したものである。
 * 相手同士も相互作用しないので、頭数ぶん独立に回すだけで済む。
 */
export function buildFieldBundle(
  profile: FieldProfile,
  track: TrackRef,
  system: SystemSetting,
  trackData: Record<number, RaceTrack>,
  options: { readonly samples: number; readonly seed: number; readonly skills?: readonly SkillData[] },
): FieldBundle {
  const settings = opponentSettings(profile, track, options.skills ?? []);
  const calculator = new RaceCalculator(system, trackData);
  const courseLength =
    trackData[track.location]?.courses[track.course]?.distance ?? 0;

  const samples: FieldSample[] = [];
  for (let s = 0; s < options.samples; s++) {
    const runs = settings.map((setting, index) =>
      calculator.simulate(setting, {
        // 相手ごとに別の試行番号を使う。束の中で同じ相手が同じ走りをしないようにする。
        seed: options.seed,
        trial: s * 1000 + index,
        recordFrames: true,
      }),
    );
    const frames = Math.max(1, ...runs.map((run) => run.state.simulation.frames.length));
    const opponents = runs.length;
    const positions = new Float64Array(frames * opponents);
    for (let i = 0; i < opponents; i++) {
      const list = runs[i]!.state.simulation.frames;
      let last = 0;
      for (let f = 0; f < frames; f++) {
        const frame = list[f];
        if (frame !== undefined) last = frame.startPosition;
        else last = courseLength;
        positions[f * opponents + i] = last;
      }
    }
    samples.push({ opponents, frames, positions });
  }
  return { samples, opponents: settings.length, courseLength };
}

/**
 * レース中の順位を、フィールドの 1 本と自分の位置から求める。
 * 毎フレームの計算は頭数に比例するだけで、多くても 18 回の比較で済む。
 */
export class FieldView {
  private readonly sample: FieldSample;

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
}

export const FRAMES_PER_SECOND = framePerSecond;
