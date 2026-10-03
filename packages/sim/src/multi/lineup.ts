import type { Condition, FitRank, Style } from '../data/constants.ts';
import { FIT_RANKS } from '../data/constants.ts';
import type { RaceTrack } from '../data/track.ts';
import type { RaceSetting, TrackRef, UmaStatus } from '../setting.ts';
import type { SkillData } from '../skill/types.ts';

/**
 * 出走表（画像から書き起こしたウマ娘の一覧）を、全頭同時のレースに渡せる形にする。
 *
 * スキル名の解決は含まない（`packages/data/src/skill-resolve.ts`）。ここは、解決済みのスキルを
 * 受け取り、コースと脚質に応じて適性を 1 つに絞り、人気を振って `RaceSetting` に組む。
 * 画面の `buildSetting`（apps/web/src/store.ts）と役目が重なるが、画面側の置き換えは別の回にする。
 * docs/mcp-design.md 3.1 節を参照。
 */

export type StyleKey = 'nige' | 'sen' | 'sasi' | 'oi';

export interface LineupStatus {
  readonly speed: number;
  readonly stamina: number;
  readonly power: number;
  readonly guts: number;
  readonly wisdom: number;
}

export interface LineupRunner {
  /** 表示に使う名前 */
  readonly name: string;
  /** `[勝負服]ウマ娘名` またはウマ娘名。固有スキルの持ち主 */
  readonly chara?: string;
  readonly status: LineupStatus;
  /** 画像のランク文字。数値の読み違いを見つけるのに使う。計算には使わない。 */
  readonly statusRank?: Partial<Record<keyof LineupStatus, string>>;
  readonly aptitude: {
    readonly surface: { readonly turf: FitRank; readonly dirt: FitRank };
    readonly distance: {
      readonly short: FitRank;
      readonly mile: FitRank;
      readonly mid: FitRank;
      readonly long: FitRank;
    };
    readonly style: Record<StyleKey, FitRank>;
  };
  readonly unique?: { readonly name: string; readonly level?: number };
  readonly skills: readonly string[];
  /** 省くと適性が最も高い脚質 */
  readonly style?: StyleKey;
  /** 評価点。人気の既定を決める */
  readonly rating?: number;
  readonly condition?: Condition;
}

export const STYLE_BY_KEY: Readonly<Record<StyleKey, Style>> = {
  nige: 'NIGE',
  sen: 'SEN',
  sasi: 'SASI',
  oi: 'OI',
};

export const STYLE_LABEL: Readonly<Record<StyleKey, string>> = {
  nige: '逃げ',
  sen: '先行',
  sasi: '差し',
  oi: '追込',
};

/** 同じランクが並んだときに採る順序。 */
const STYLE_TIE_ORDER: readonly StyleKey[] = ['sen', 'sasi', 'oi', 'nige'];

const RANK_VALUE: Readonly<Record<FitRank, number>> = { S: 8, A: 7, B: 6, C: 5, D: 4, E: 3, F: 2, G: 1 };

/** 固有の `Lv` が写っていないときに使う値 */
export const DEFAULT_UNIQUE_LEVEL = 6;

export interface StyleChoice {
  readonly style: StyleKey;
  /** 利用者が指定したか、適性から決めたか */
  readonly source: 'given' | 'aptitude' | 'aptitude_tie_skills' | 'aptitude_tie_order';
  readonly reason: string;
}

/**
 * 脚質を決める。指定があればそれを採る。
 * 省くと適性が最も高いもの。同じランクが並ぶときは、その脚質向けのスキル（`先行直線◎` など）の数が多いほう。
 * それでも並ぶときは、先行、差し、追込、逃げの順に採る。
 */
export function chooseStyle(runner: LineupRunner): StyleChoice {
  if (runner.style !== undefined) {
    return { style: runner.style, source: 'given', reason: '指定された脚質' };
  }
  const best = Math.max(...STYLE_TIE_ORDER.map((key) => RANK_VALUE[runner.aptitude.style[key]]));
  const tied = STYLE_TIE_ORDER.filter((key) => RANK_VALUE[runner.aptitude.style[key]] === best);
  if (tied.length === 1) {
    return { style: tied[0]!, source: 'aptitude', reason: `脚質適性が最も高い（${STYLE_LABEL[tied[0]!]} ${runner.aptitude.style[tied[0]!]}）` };
  }
  const count = (key: StyleKey) => runner.skills.filter((name) => name.startsWith(STYLE_LABEL[key])).length;
  const counts = tied.map((key) => count(key));
  const top = Math.max(...counts);
  const withMost = tied.filter((_, i) => counts[i] === top);
  if (top > 0 && withMost.length === 1) {
    return {
      style: withMost[0]!,
      source: 'aptitude_tie_skills',
      reason: `${tied.map((k) => STYLE_LABEL[k]).join('と')}が同じ適性で、${STYLE_LABEL[withMost[0]!]}向けのスキルが最も多い（${top} 個）`,
    };
  }
  const pick = withMost[0]!;
  return {
    style: pick,
    source: 'aptitude_tie_order',
    reason: `${tied.map((k) => STYLE_LABEL[k]).join('と')}が同じ適性で決め手が無く、先行、差し、追込、逃げの順で ${STYLE_LABEL[pick]} を採った`,
  };
}

/** コースの距離種別（1 短距離、2 マイル、3 中距離、4 長距離）に当たる距離適性 */
export function distanceFitOf(runner: LineupRunner, distanceType: number): FitRank {
  switch (distanceType) {
    case 1:
      return runner.aptitude.distance.short;
    case 2:
      return runner.aptitude.distance.mile;
    case 3:
      return runner.aptitude.distance.mid;
    default:
      return runner.aptitude.distance.long;
  }
}

/** コースのバ場（1 芝、2 ダート）に当たるバ場適性 */
export function surfaceFitOf(runner: LineupRunner, surface: number): FitRank {
  return surface === 1 ? runner.aptitude.surface.turf : runner.aptitude.surface.dirt;
}

/**
 * 人気を振る。評価点の高い順に 1 から。
 * 評価点の無い頭は、評価点のある頭の後に、入力の順で続ける。どの頭にも無ければ入力の順になる。
 * 同じ評価点は入力の順を保つ。
 */
export function assignPopularity(runners: readonly LineupRunner[]): number[] {
  const order = runners
    .map((runner, index) => ({ index, rating: runner.rating }))
    .sort((a, b) => {
      if (a.rating !== undefined && b.rating !== undefined) return b.rating - a.rating || a.index - b.index;
      if (a.rating !== undefined) return -1;
      if (b.rating !== undefined) return 1;
      return a.index - b.index;
    });
  const popularity = new Array<number>(runners.length);
  order.forEach((entry, rank) => {
    popularity[entry.index] = rank + 1;
  });
  return popularity;
}

export interface BuiltRunner {
  readonly setting: RaceSetting;
  readonly style: StyleChoice;
  readonly distanceFit: FitRank;
  readonly surfaceFit: FitRank;
  readonly styleFit: FitRank;
  readonly popularity: number;
  readonly uniqueLevel: number;
}

/** 1 頭を `RaceSetting` に組む。`skills` は解決済みのスキル。 */
export function buildRaceSetting(
  runner: LineupRunner,
  skills: readonly SkillData[],
  track: TrackRef,
  trackData: Record<number, RaceTrack>,
  popularity: number,
): BuiltRunner {
  const detail = trackData[track.location]?.courses[track.course];
  if (detail === undefined) throw new Error(`コースが見つからない: ${track.location} / ${track.course}`);
  const style = chooseStyle(runner);
  const distanceFit = distanceFitOf(runner, detail.distanceType);
  const surfaceFit = surfaceFitOf(runner, detail.surface);
  const styleFit = runner.aptitude.style[style.style];
  const uniqueLevel = runner.unique?.level ?? DEFAULT_UNIQUE_LEVEL;
  const uma: UmaStatus = {
    charaName: runner.chara ?? runner.name,
    speed: runner.status.speed,
    stamina: runner.status.stamina,
    power: runner.status.power,
    guts: runner.status.guts,
    wisdom: runner.status.wisdom,
    condition: runner.condition ?? 'BEST',
    style: STYLE_BY_KEY[style.style],
    distanceFit,
    surfaceFit,
    styleFit,
    popularity,
    gateNumber: 0,
    uniqueLevel,
  };
  return {
    setting: {
      uma,
      track,
      skills,
      skillActivateAdjustment: 'NONE',
      randomPosition: 'RANDOM',
      debuffCounts: {},
      positionKeepMode: 'APPROXIMATE',
      positionKeepRate: 100,
    },
    style,
    distanceFit,
    surfaceFit,
    styleFit,
    popularity,
    uniqueLevel,
  };
}

// ---- 点検 ----

export type LineupIssueCode =
  /** ステータスが 1 から 2000 の外にある */
  | 'status_range'
  /** ステータスの数値と、画像のランク文字が合わない */
  | 'rank_mismatch'
  /** 適性の文字が S から G のどれでもない */
  | 'invalid_aptitude'
  /** 保存した個体を使ったとき、スキルの解決結果が保存したときと違う（データの取り直しで起こりうる） */
  | 'individual_changed';

export interface LineupIssue {
  readonly code: LineupIssueCode;
  readonly message: string;
}

/** 数値の範囲に対応する、ランク文字の表。100 刻み。画像 11 枚から読んだもの（docs/mcp-design.md 3.7 節）。 */
const RANK_RANGES: Readonly<Record<string, readonly [number, number]>> = {
  C: [400, 499],
  'C+': [500, 599],
  B: [600, 699],
  'B+': [700, 799],
  A: [800, 899],
  'A+': [900, 999],
  S: [1000, 1099],
};

/** `A＋` や空白の揺れを寄せる */
function normalizeRank(rank: string): string {
  return rank.normalize('NFKC').replace(/\s+/g, '').toUpperCase();
}

const STATUS_LABEL: Readonly<Record<keyof LineupStatus, string>> = {
  speed: 'スピード',
  stamina: 'スタミナ',
  power: 'パワー',
  guts: '根性',
  wisdom: '賢さ',
};

/**
 * 数値とランク文字の突き合わせ。
 *
 * 検査するのは C 以上 S 以下に限る。`S` を超える数値は、ランク文字が表にあるものでなければよしとする
 * （`U` 系や `SS` 系は細かく見ない）。C 未満は画像に無かったので検査しない。
 * 食い違いは警告にとどめる。表はゲームの仕様と突き合わせていない。
 */
export function checkStatusRank(status: LineupStatus, rank: LineupRunner['statusRank']): LineupIssue[] {
  const issues: LineupIssue[] = [];
  for (const key of Object.keys(STATUS_LABEL) as (keyof LineupStatus)[]) {
    const value = status[key];
    const label = STATUS_LABEL[key];
    if (!Number.isFinite(value) || value < 1 || value > 2000) {
      issues.push({ code: 'status_range', message: `${label} ${value} は 1 から 2000 の範囲にありません。数字の読み違いかもしれません。` });
      continue;
    }
    const raw = rank?.[key];
    if (raw === undefined) continue;
    const letter = normalizeRank(raw);
    const range = RANK_RANGES[letter];
    if (range !== undefined) {
      if (value < range[0] || value > range[1]) {
        issues.push({
          code: 'rank_mismatch',
          message: `${label} ${value} はランク ${raw} の範囲（${range[0]} から ${range[1]}）にありません。数字かランク文字の読み違いかもしれません。`,
        });
      }
    } else if (/^(U|SS)/.test(letter) && value < 1100) {
      issues.push({
        code: 'rank_mismatch',
        message: `${label} ${value} はランク ${raw} としては低すぎます（1100 以上のはずです）。数字かランク文字の読み違いかもしれません。`,
      });
    }
  }
  return issues;
}

/** 適性の文字が S から G のどれかか。 */
export function checkAptitude(aptitude: LineupRunner['aptitude']): LineupIssue[] {
  const issues: LineupIssue[] = [];
  const entries: [string, string][] = [
    ['芝', aptitude.surface.turf], ['ダート', aptitude.surface.dirt],
    ['短距離', aptitude.distance.short], ['マイル', aptitude.distance.mile],
    ['中距離', aptitude.distance.mid], ['長距離', aptitude.distance.long],
    ['逃げ', aptitude.style.nige], ['先行', aptitude.style.sen],
    ['差し', aptitude.style.sasi], ['追込', aptitude.style.oi],
  ];
  for (const [label, letter] of entries) {
    if (!(FIT_RANKS as readonly string[]).includes(letter)) {
      issues.push({ code: 'invalid_aptitude', message: `${label}適性 ${letter} は S から G のどれでもありません。` });
    }
  }
  return issues;
}
