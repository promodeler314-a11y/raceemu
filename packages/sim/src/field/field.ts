import { RaceCalculator } from '../calculator.ts';
import { framePerSecond, type Condition, type Style } from '../data/constants.ts';
import type { RaceTrack } from '../data/track.ts';
import { runMultiRace, type MultiEntry } from '../multi/race.ts';
import type { RaceSetting, SystemSetting, TrackRef, UmaStatus } from '../setting.ts';
import type { SkillData } from '../skill/types.ts';
import type { OpponentSkillPool } from './opponent-skills.ts';
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

/** 相手の想定。脚質ごとの頭数と、基準のステータスと、ばらつかせ方。 */
export interface FieldProfile {
  /**
   * 脚質ごとの頭数。`redrawComposition` が真のときは合計だけを使い、
   * 割り振りは束の 1 本ごとに引き直す。
   */
  readonly counts: Readonly<Record<Style, number>>;
  /** 基準のステータス。`matchSelf` が真で自分が渡ったときは、そちらを写す。 */
  readonly uma: Omit<UmaStatus, 'style' | 'charaName'>;
  /**
   * 相手を自分と同格にする。
   *
   * チャンピオンズミーティングの相手は自分と同じ育成をした個体である、
   * という想定を既定にする。自分の設定が渡らないときは `uma` のままになる。
   * docs/order-field.md 4.3 節を参照。
   */
  readonly matchSelf?: boolean;
  /** 基準のステータスに一律で足す値。相手の強さを上下させる口である。 */
  readonly offset?: number;
  /** 各ステータスに乗せるばらつきの標準偏差。0 で固定になる。 */
  readonly sigma?: number;
  /** やる気を引き直す。偽なら全頭が絶好調になる。 */
  readonly drawCondition?: boolean;
  /** 脚質構成を束の 1 本ごとに引き直す。 */
  readonly redrawComposition?: boolean;
  /** 典型スキルを 5 から 8 個持たせる。引き当て表が渡らないと効かない。 */
  readonly withSkills?: boolean;
  /**
   * 相手のスキルに混ぜる、自分の構成のスキル ID。
   *
   * 自己整合。自分だけが強くなる歪みを薄めるためのもので、探索の途中で
   * いま評価している構成を相手にも配る。docs/order-field.md 4.6 節を参照。
   * ID から実体を引く表が渡らないと効かない。
   */
  readonly mixSkillIds?: readonly string[];
  /** 上を配る相手の割合。0 から 1 で、0 なら混ぜない。 */
  readonly mixRate?: number;
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
  return {
    counts: { NIGE: nige, SEN: sen, SASI: sasi, OI: oi, OONIGE: 0 },
    uma,
    // 既定は docs/order-field.md 3 節の D である。相手を自分と同格にし、
    // 束の 1 本ごとに構成・強さ・やる気・スキルを引き直す。
    matchSelf: true,
    offset: 0,
    sigma: 100,
    drawCondition: true,
    redrawComposition: true,
    withSkills: true,
  };
}

/**
 * 相手を固定した、引き直さない想定。
 *
 * 勝率の面の相手の初期値のように、1 組の相手を並べたいところで使う。
 * docs/order-field.md 3 節の A にあたる。
 */
export function fixedFieldProfile(gateCount: number): FieldProfile {
  return {
    ...defaultFieldProfile(gateCount),
    matchSelf: false,
    sigma: 0,
    drawCondition: false,
    redrawComposition: false,
    withSkills: false,
  };
}

/**
 * 脚質構成の候補。9 頭立て（相手 8 頭）での割り振りで、
 * 頭数が違うときは同じ比で割り直す。並びは逃げ・先行・差し・追込。
 */
const COMPOSITIONS: readonly (readonly number[])[] = [
  [2, 3, 3, 0],
  [1, 3, 3, 1],
  [2, 2, 3, 1],
  [3, 3, 2, 0],
  [1, 4, 2, 1],
  [2, 3, 2, 1],
  [2, 2, 2, 2],
  [1, 2, 3, 2],
];

const STYLE_ORDER: readonly Style[] = ['NIGE', 'SEN', 'SASI', 'OI'];

/** やる気の引き当て表。絶好調に寄せてある。 */
const CONDITION_DRAW: readonly Condition[] = ['BEST', 'BEST', 'GOOD', 'GOOD', 'NORMAL'];

/**
 * 決定的なゆらぎ。標準偏差 1 の、正規に近い値を返す。
 *
 * 束は指定だけから決まらなければならない。Worker ごとに違う束ができると
 * 共通乱数によるペア比較が崩れるので、ここで Math.random は使えない。
 */
function jitter(key: number, k: number): number {
  let h = (key * 7919 + k * 104729 + 12345) >>> 0;
  const u = (): number => {
    h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return (h >>> 8) / 0x1000000;
  };
  // 一様 3 つの和で正規に近づける。1.63 は標準偏差を 1 に合わせる係数である。
  return (u() + u() + u() - 1.5) * 1.63;
}

/** 0 以上 max 未満の整数を、鍵から決めて返す。 */
function drawIndex(key: number, k: number, max: number): number {
  let h = (Math.imul(key, 2654435761) + k * 40503 + 7) >>> 0;
  h = (Math.imul(h ^ (h >>> 13), 0x85ebca6b) + 0x9e3779b9) >>> 0;
  return (h >>> 8) % max;
}

function totalOf(counts: Readonly<Record<Style, number>>): number {
  return STYLE_ORDER.reduce((sum, style) => sum + (counts[style] ?? 0), 0) + (counts.OONIGE ?? 0);
}

/** 束の 1 本ぶんの脚質構成を引く。頭数は変えず、割り振りだけを変える。 */
function drawCounts(total: number, sample: number): Record<Style, number> {
  const base = COMPOSITIONS[drawIndex(sample, 11, COMPOSITIONS.length)]!;
  const sum = base.reduce((a, b) => a + b, 0);
  const exact = base.map((n) => (n * total) / sum);
  const counts = exact.map((x) => Math.floor(x));
  let rest = total - counts.reduce((a, b) => a + b, 0);
  // 端数は小数部の大きい順に配る。同じなら前の脚質から。
  const order = exact
    .map((x, i) => ({ frac: x - Math.floor(x), i }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k++, rest--) counts[order[k % order.length]!.i]!++;
  return { NIGE: counts[0]!, SEN: counts[1]!, SASI: counts[2]!, OI: counts[3]!, OONIGE: 0 };
}

/** 基準のステータス。自分と同格にする指定と、強さの上下をここで畳む。 */
function baseUma(profile: FieldProfile, self: UmaStatus | null | undefined): FieldProfile['uma'] {
  const from = profile.matchSelf === true && self != null ? self : profile.uma;
  const offset = profile.offset ?? 0;
  return {
    ...profile.uma,
    speed: from.speed + offset,
    stamina: from.stamina + offset,
    power: from.power + offset,
    guts: from.guts + offset,
    wisdom: from.wisdom + offset,
    condition: from.condition,
    distanceFit: from.distanceFit,
    surfaceFit: from.surfaceFit,
    styleFit: from.styleFit,
    uniqueLevel: from.uniqueLevel,
  };
}

/** 1 頭ぶんのステータスを引く。鍵が負なら引き直さない。 */
function drawUma(
  base: FieldProfile['uma'],
  profile: FieldProfile,
  key: number,
): FieldProfile['uma'] {
  if (key < 0) return base;
  const sigma = profile.sigma ?? 0;
  const shift = (k: number, value: number): number =>
    sigma <= 0 ? value : Math.max(1, Math.round(value + jitter(key, k) * sigma));
  return {
    ...base,
    speed: shift(1, base.speed),
    stamina: shift(2, base.stamina),
    power: shift(3, base.power),
    guts: shift(4, base.guts),
    wisdom: shift(5, base.wisdom),
    condition:
      profile.drawCondition === true
        ? CONDITION_DRAW[drawIndex(key, 9, CONDITION_DRAW.length)]!
        : base.condition,
  };
}

/** 候補から 5 から 8 個を、連なりで引く。候補が少なければあるだけ。 */
function drawSkills(pool: readonly SkillData[], key: number): SkillData[] {
  if (pool.length === 0) return [];
  const count = Math.min(pool.length, 5 + drawIndex(key, 7, 4));
  const start = drawIndex(key, 8, pool.length);
  return Array.from({ length: count }, (_, j) => pool[(start + j) % pool.length]!);
}

/**
 * 自分の構成を相手にも配る（自己整合）。
 *
 * 全員に配ると相手が一様に強くなるだけなので、鍵から決めた一部にだけ配る。
 * docs/order-field.md 4.6 節を参照。
 */
function mixInto(
  skills: SkillData[],
  profile: FieldProfile,
  skillsById: ReadonlyMap<string, SkillData> | null,
  key: number,
): void {
  const ids = profile.mixSkillIds ?? [];
  const rate = profile.mixRate ?? 0;
  if (key < 0 || rate <= 0 || ids.length === 0 || skillsById === null) return;
  if (drawIndex(key, 12, 1000) >= rate * 1000) return;
  const have = new Set(skills.map((skill) => skill.id));
  for (const id of ids) {
    if (have.has(id)) continue;
    const skill = skillsById.get(id);
    if (skill === undefined) continue;
    skills.push(skill);
    have.add(id);
  }
}

export interface OpponentOptions {
  /** 自分の設定。`matchSelf` のときにステータスを写す。 */
  readonly self?: UmaStatus | null;
  /** 相手に持たせるスキルの候補。`withSkills` にはこれが要る。 */
  readonly skillPool?: OpponentSkillPool | null;
  /** 全頭に同じスキルを持たせる。`withSkills` が働くときはそちらが優先される。 */
  readonly skills?: readonly SkillData[];
  /** ID から実体を引く表。`mixSkillIds` にこれが要る。 */
  readonly skillsById?: ReadonlyMap<string, SkillData> | null;
  /**
   * 束の何本目か。渡すと構成・強さ・やる気・スキルを引き直す。
   * 省くと引き直さず、`profile` の通りに並べる。
   */
  readonly sample?: number | null;
}

/** 相手の想定から、相手 N-1 頭ぶんの設定を作る。全頭同時に走らせる側でも使う。 */
export function opponentSettings(
  profile: FieldProfile,
  track: TrackRef,
  options: OpponentOptions = {},
): RaceSetting[] {
  const sample = options.sample ?? null;
  const base = baseUma(profile, options.self);
  const counts =
    sample !== null && profile.redrawComposition === true
      ? drawCounts(totalOf(profile.counts), sample)
      : profile.counts;
  const pool = options.skillPool ?? null;
  const settings: RaceSetting[] = [];
  let index = 0;
  for (const style of STYLE_ORDER) {
    for (let i = 0; i < (counts[style] ?? 0); i++, index++) {
      // 鍵は束の本と相手の添字から作る。同じ本なら何度作っても同じ相手になる。
      const key = sample === null ? -1 : sample * 32 + index;
      const skills =
        profile.withSkills === true && pool !== null && key >= 0
          ? drawSkills(pool[style] ?? [], key)
          : [...(options.skills ?? [])];
      mixInto(skills, profile, options.skillsById ?? null, key);
      settings.push({
        uma: { ...drawUma(base, profile, key), charaName: '', style },
        track,
        skills,
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
 *
 * 束は 1 つの相手ではなく相手の分布である。`profile` の指定に応じて、
 * 1 本ごとに脚質構成・強さ・やる気・スキルを引き直す（4.3 節）。
 * 引き直しは鍵から決まるので、同じ指定なら何度作っても同じ束になる。
 */
export function buildFieldBundle(
  profile: FieldProfile,
  track: TrackRef,
  system: SystemSetting,
  trackData: Record<number, RaceTrack>,
  options: {
    readonly samples: number;
    readonly seed: number;
    /** 全頭に同じスキルを持たせる。`profile.withSkills` を使うときは要らない。 */
    readonly skills?: readonly SkillData[];
    /** 自分のステータス。`profile.matchSelf` のときに写す。 */
    readonly self?: UmaStatus | null;
    /** 相手に持たせるスキルの候補 */
    readonly skillPool?: OpponentSkillPool | null;
    /** ID から実体を引く表。`profile.mixSkillIds` にこれが要る。 */
    readonly skillsById?: ReadonlyMap<string, SkillData> | null;
  },
): FieldBundle {
  const calculator = new RaceCalculator(system, trackData);
  const courseLength = trackData[track.location]?.courses[track.course]?.distance ?? 0;
  const samples: FieldSample[] = [];
  let opponents = totalOf(profile.counts);
  for (let s = 0; s < options.samples; s++) {
    const settings = opponentSettings(profile, track, {
      self: options.self,
      skillPool: options.skillPool,
      skills: options.skills,
      skillsById: options.skillsById,
      sample: s,
    });
    opponents = settings.length;
    // 相手も実在の先頭に対して位置取りする。勝率の面と同じ規則にする。
    const entries: MultiEntry[] = settings.map((setting) => ({
      setting: { ...setting, positionKeepMode: 'VIRTUAL' },
    }));
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
    samples.push({ opponents, frames, positions, styles: settings.map((setting) => setting.uma.style) });
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
