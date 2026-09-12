import { RaceCalculator } from '../calculator.ts';
import { framePerSecond, type Style } from '../data/constants.ts';
import type { RaceTrack } from '../data/track.ts';
import { runMultiRace, type MultiEntry } from '../multi/race.ts';
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
  /**
   * 相手の脚質。`styles[i]` が i 番目の脚質である。
   * 自分が先頭に対して位置取りするとき、相手の脚質で振る舞いが変わるので持つ
   * （docs/order-field.md 4.2 節）。
   */
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
 * **相手同士を一緒に走らせる。** 1 本の軌跡は、相手 N-1 頭を同時に走らせて
 * 各フレームの位置を記録したものである。
 *
 * 以前は 1 頭ずつ独立に走らせていた。そのほうが軽いが、隊列ができない。
 * 全頭が前に誰もいない前提で走るので、位置取りのペースダウンが起きず、
 * 同じ脚質の相手が固まって、順位が塊の境目にしか現れなかった。
 * 一緒に走らせると順位の分布が全頭同時（勝率の面）とほぼ同じ形になる。
 * 作り方ごとの比較は docs/order-field.md の 3 節にある。
 *
 * 相手同士は互いに位置取りするが、**自分の走りは相手に影響しない**。
 * そのおかげで束は自分の構成に依らず、全試行と全候補で使い回せる。
 * 全頭同時との差はこのぶんで、10 ポイント前後である（同 5 節）。
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
  const styles = settings.map((setting) => setting.uma.style);
  const opponents = settings.length;
  const entries: MultiEntry[] = settings.map((setting) => ({ setting }));

  const samples: FieldSample[] = [];
  for (let s = 0; s < options.samples; s++) {
    // 1 フレームぶんの位置を、そのフレームの頭の値（startPosition）で取る。
    // 読む側も自分の startPosition と比べるので、同じ時刻の位置どうしが並ぶ。
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
    for (let f = 0; f < frames; f++) {
      const row = rows[f];
      for (let i = 0; i < opponents; i++) {
        positions[f * opponents + i] = row === undefined ? courseLength : (row[i] ?? courseLength);
      }
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
/**
 * 位置取りの判定が見る先頭。
 *
 * 判定が読むのはこの 2 つだけである。実在の 1 頭でも、束から読んだ値でもよい。
 */
export interface PaceMakerView {
  readonly startPosition: number;
  readonly style: Style;
}

export interface FieldView {
  readonly opponents: number;
  readonly gateCount: number;
  /**
   * そのフレームで最も前にいる他頭。位置取りの判定が見る相手になる。
   *
   * 戻り値は呼び出しごとに作り直さず、同じ器を書き換えて返してよい。
   * 毎フレーム呼ばれるので、読んだ側はその場で使い切る。
   */
  paceMaker(frameElapsed: number): PaceMakerView | null;
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
}

/** あらかじめ作った束の 1 本を読む実装 */
export class RecordedField implements FieldView {
  private readonly sample: FieldSample;
  /** 先頭を返すための器。毎フレーム作り直さないよう 1 つだけ持つ。 */
  private readonly leader: { startPosition: number; style: Style } = {
    startPosition: 0,
    style: 'NIGE',
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

  /** そのフレームで最も前にいる他頭 */
  paceMaker(frameElapsed: number): PaceMakerView | null {
    const { frames, opponents, positions, styles } = this.sample;
    if (opponents === 0) return null;
    const frame = Math.min(frameElapsed, frames - 1);
    const offset = frame * opponents;
    let best = Number.NEGATIVE_INFINITY;
    let at = 0;
    for (let i = 0; i < opponents; i++) {
      const value = positions[offset + i]!;
      if (value > best) {
        best = value;
        at = i;
      }
    }
    this.leader.startPosition = best;
    this.leader.style = styles[at] ?? 'NIGE';
    return this.leader;
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
