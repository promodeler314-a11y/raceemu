import { create } from 'zustand';
import { browserWorkerFactory } from '../../../packages/sim/src/parallel/browser.ts';
import { SimulationCancelled, WorkerPool } from '../../../packages/sim/src/parallel/pool.ts';
import {
  MULTI_FIELDS,
  toSerializable,
  toSkillSummaries,
  unpackMultiEntry,
  type SkillSummary,
} from '../../../packages/sim/src/parallel/protocol.ts';
import { RaceCalculator } from '../../../packages/sim/src/calculator.ts';
import {
  DEBUFF_TYPES,
  DerivedSetting,
  defaultSystemSetting,
  emptyPassiveBonus,
  type PositionKeepMode,
  type RaceSetting,
  type RandomPosition,
  type SkillActivateAdjustment,
  type TrackRef,
  type UmaStatus,
} from '../../../packages/sim/src/setting.ts';
import { classifySkills, type SkillFidelity } from '../../../packages/sim/src/skill/classify.ts';
import { summarize, type SimulationSummary } from '../../../packages/sim/src/summary.ts';
import { buildFieldBundle, defaultFieldProfile } from '../../../packages/sim/src/field/field.ts';
import { opponentSkillPool } from '../../../packages/sim/src/field/opponent-skills.ts';
import { OrderTally, type OrderSummary } from '../../../packages/sim/src/multi/summary.ts';
import { replayMultiRace, type MultiReplay } from '../../../packages/sim/src/multi/replay.ts';
import type { Distance, Style } from '../../../packages/sim/src/data/constants.ts';
import { courseDistances, matchCourses, type CourseMatch } from '../../../packages/sim/src/data/track.ts';
import { runCrossCourse, type CrossCourseRow } from '../../../packages/sim/src/parallel/cross.ts';
import { resolveMethod } from '../../../packages/solver/src/critical.ts';
import { createCostModel } from '../../../packages/solver/src/cost.ts';
import { optimizeSkills, type OptimizeResult } from '../../../packages/solver/src/optimize.ts';
import {
  DEFAULT_SCALES,
  baseValueOf,
  measureSensitivity,
  type SensitivityAxis,
  type SensitivityResult,
} from '../../../packages/solver/src/sensitivity.ts';
import {
  buildAllSkillCandidates,
  buildPlanCandidates,
  type PlanCandidates,
} from '../../../packages/solver/src/candidates.ts';
import type { DeckData } from '../../../packages/data/src/deck.ts';
import type { Goal, TargetStatus } from '../../../packages/solver/src/target.ts';
import { decodeShareState, encodeShareState, hashWithTab, readTabFromHash } from './share.ts';
import type { Individual } from './individualsApi.ts';
import { hasEndpoint, runServerSearch, ServerSearchUnavailable } from './searchApi.ts';
import { debounceSave, isPersistenceAvailable, loadPersisted } from './persist.ts';
import { resolveSkillIds, type Preset } from './presets.ts';
import { gameData, skillChoices, skillIndex, NO_CHARA } from './skills.ts';
import { buildTransferIndex, formatTransfer, type ParsedTransfer } from './transfer.ts';
import type { RaceFrame, RaceSimulationResult, RaceState } from '../../../packages/sim/src/state.ts';

export { gameData, skillChoices };

/**
 * サポートカードと育成ウマ娘。
 *
 * 育成計画から候補を組み立てるときにしか要らず、それだけで数百 KB ある。
 * 最初の読み込みに乗せたくないので、計画に切り替えたときに取りに行く。
 */
let deckPromise: Promise<DeckData> | null = null;
function fetchDeckData(): Promise<DeckData> {
  deckPromise ??= import('../../../packages/data/src/deck-browser.ts').then((m) => m.loadDeckData());
  return deckPromise;
}
const system = defaultSystemSetting();

/**
 * スキルポイントの費用。ヒントレベルで割引が変わるので、レベルの組ごとに作る。
 * 同じレベルの組で何度も呼ばれるため、直前のものだけ覚えておく。
 */
let cachedCostKey = '';
let cachedCost: ReturnType<typeof createCostModel> | null = null;
export function costModelFor(hintLevels: Readonly<Record<string, number>>) {
  const key = JSON.stringify(hintLevels);
  if (cachedCost === null || key !== cachedCostKey) {
    cachedCost = createCostModel(gameData.skillsById, { hintLevels });
    cachedCostKey = key;
  }
  return cachedCost;
}

/** 実行オプション。計算モデルは前から受け取っていたが、画面から変える口が無かった。 */
export interface RunOptions {
  readonly skillActivateAdjustment: SkillActivateAdjustment;
  readonly randomPosition: RandomPosition;
  readonly positionKeepMode: PositionKeepMode;
  readonly positionKeepRate: number;
}

export function defaultRunOptions(): RunOptions {
  return {
    skillActivateAdjustment: 'NONE',
    randomPosition: 'RANDOM',
    positionKeepMode: 'APPROXIMATE',
    positionKeepRate: 100,
  };
}

export const debuffTypes = DEBUFF_TYPES;

let pool: WorkerPool | null = null;
function getPool(): WorkerPool {
  if (pool === null) pool = new WorkerPool(browserWorkerFactory);
  return pool;
}

/**
 * 順位条件を判定するときの相手の想定。
 *
 * 束は 1 つの相手ではなく相手の分布である。ここが順位条件つきスキルの
 * 評価をそのまま左右する入力なので、既定を固定したままにはできない。
 * docs/order-field.md 4.3 節を参照。
 */
export interface FieldSetting {
  /** 相手を自分と同格にする。切ると 1100-900-900-600-900 の固定になる。 */
  readonly matchSelf: boolean;
  /** 基準に一律で足す値。相手の強さを上下させる。 */
  readonly offset: number;
  /** ステータスに乗せるばらつきの標準偏差。0 で全頭が同じになる。 */
  readonly sigma: number;
  /** 脚質構成を束の 1 本ごとに引き直す。切ると 1 通りに固定される。 */
  readonly redrawComposition: boolean;
  /** 相手に典型スキルを持たせる。 */
  readonly withSkills: boolean;
}

/**
 * 相手の強さを振ったときの発動率の幅。
 *
 * 相手の分布を変えれば発動率は動く。1 つの数字だけを出すと、その数字が
 * 相手の想定に依ることが見えない。docs/order-field.md 4.5 節を参照。
 */
export interface TriggerBand {
  /** 相手を 100 弱くしたとき */
  readonly weaker: number;
  /** いまの想定 */
  readonly base: number;
  /** 相手を 100 強くしたとき */
  readonly stronger: number;
}

export function defaultFieldSetting(): FieldSetting {
  return { matchSelf: true, offset: 0, sigma: 100, redrawComposition: true, withSkills: true };
}

/** 保存する設定。結果は含めない。 */
export interface PersistedSettings {
  readonly uma: UmaStatus;
  readonly track: TrackRef;
  readonly skillIds: readonly string[];
  readonly count: number;
  readonly seed: number;
  readonly options: RunOptions;
  readonly debuffCounts: Readonly<Record<string, number>>;
  readonly hintLevels: Readonly<Record<string, number>>;
  readonly useField: boolean;
  readonly field?: FieldSetting;
  readonly plan?: PlanSetting & { readonly enabled?: boolean };
  /** サーバ側の探索の宛先。空なら無し（ブラウザで回す）。 */
  readonly searchEndpoint?: string;
  readonly searchTarget?: SearchTarget;
  readonly cross?: CrossSetting;
}

/**
 * 探索をどこで回すか。
 *
 * 宛先が無ければ常にブラウザである。サーバは加速装置であって依存先ではない
 * （docs/server-design.md 2 節）。サーバを選んでいても、応答が JSON でなければ
 * ブラウザに落ちる。
 */
export type SearchTarget = 'browser' | 'server';

/**
 * 探索の候補をどこから作るか。
 *
 * - `selected`：いま選んでいるスキル。育て終わった馬の買い物に答える。
 * - `plan`：育成ウマ娘とデッキと継承から。何を狙って育てるかに答える（docs/solver-design.md 7 節）。
 * - `all`：買えるスキル全体から。入手経路を問わず「取れるとしたら何が効くか」に答える。
 *   候補が数百になるのでブラウザでは回しきれず、サーバ側の探索が要る
 *   （docs/server-design.md 1 節）。
 */
export type CandidateSource = 'selected' | 'plan' | 'all';

/**
 * 育成計画の入力。
 *
 * 候補をいま選んでいるスキルからではなく入手経路から作るときに使う。
 * docs/solver-design.md 7 節を参照。共有 URL には載せない。
 */
export interface PlanSetting {
  readonly source: CandidateSource;
  readonly charaId: number | null;
  readonly charaRank: number;
  readonly cardIds: readonly number[];
  readonly openWhites: boolean;
  readonly openInheritedUniques: boolean;
  /** 全スキルのときだけ効く。金（レア）を候補に入れるか。 */
  readonly openGolds: boolean;
  /** 無視している条件しか持たないスキルを候補に入れるか */
  readonly includeIgnoredOnly: boolean;
  /**
   * 条件を落としている（▲）スキルを候補から外すか。
   *
   * 既定で外す。落とした条件は満たしている扱いになるため発動率が高く出る。
   * 候補を数百に広げると、印が付いていても上位が ▲ で埋まって読めなくなる。
   * docs/server-design.md 8 節の 7 を参照。
   */
  readonly excludeDropped: boolean;
}

export const DEFAULT_PLAN: PlanSetting = {
  source: 'selected',
  charaId: null,
  charaRank: 5,
  cardIds: [],
  openWhites: true,
  openInheritedUniques: true,
  openGolds: true,
  includeIgnoredOnly: false,
  excludeDropped: true,
};

/** ヘッダのタブ。共有 URL には載せない（見ている面は設定の一部ではない）。 */
export const TABS = ['settings', 'summary', 'compare', 'detail', 'solve', 'field', 'skills'] as const;
export type Tab = (typeof TABS)[number];

/** ハッシュに書いてあった面の名前を検証する。知らない名前なら null。 */
function toTab(value: string | null): Tab | null {
  return value !== null && (TABS as readonly string[]).includes(value) ? (value as Tab) : null;
}

/** 相手 1 頭ぶんの設定 */
export interface Opponent {
  readonly id: number;
  readonly uma: UmaStatus;
  readonly skillIds: readonly string[];
}

/** 全頭同時の 1 試行ぶんの、自分の成績。走らせ直すのに試行番号が要る。 */
export interface MultiTrialRecord {
  readonly trial: number;
  readonly order: number;
  readonly raceTime: number;
}

/** 全頭同時に走らせた結果 */
export interface MultiResult {
  /** 出走順ごとの着順の集計。0 番が自分。 */
  readonly summaries: readonly OrderSummary[];
  readonly trials: number;
  readonly elapsedMs: number;
  readonly cancelled: boolean;
  /**
   * 試行ごとの自分の着順とタイム。着順の分布のどこを開くかを選ぶのに使う。
   * 1 試行あたり数値 3 つなので、フレーム列と違って持ち回れる。
   */
  readonly selfTrials: readonly MultiTrialRecord[];
  /**
   * この結果を出したときの出走設定と種。
   *
   * 1 試行を開くときは、これと試行番号から同じレースを走らせ直す
   * （`showMultiTrial`）。走らせたあとに相手を触られても、結果と
   * 図が食い違わないようにするために、そのときの設定を持っておく。
   */
  readonly entries: readonly RaceSetting[];
  readonly seed: number;
}

/**
 * 勝率の面から開いた 1 本。
 *
 * 保持しているのは「いま開いている 1 本」だけで、走らせ直すたびに入れ替わる。
 * docs/multi-horse-design.md 7 節を参照。
 */
export interface MultiDetail {
  readonly trial: number;
  readonly replay: MultiReplay;
  /** 走らせ直しに掛かった時間 (ms) */
  readonly elapsedMs: number;
}

/**
 * コース横断の評価の条件。
 *
 * 距離は「ぴったりの値」か「距離帯」のどちらかで選ぶ。1 つの選択欄に
 * 両方を並べたいので、`d:2000`（ぴったり）と `c:MIDDLE`（帯）の形の
 * 文字列 1 つで持つ。docs/webapp-design.md 6.5 節を参照。
 */
export interface CrossSetting {
  /** 1=芝 2=ダート */
  readonly surface: number;
  readonly distanceKey: string;
  /** コース 1 本あたりの試行回数 */
  readonly count: number;
}

/**
 * 既定の試行回数は単騎（2000）より少ない。
 *
 * コースの本数ぶん掛かるためである。芝の中距離は 26 コースあるので、
 * 2000 のままだと順位条件ありで数分になる（docs/roadmap.md 3.3 節の実測）。
 */
export function defaultCrossSetting(): CrossSetting {
  return { surface: 1, distanceKey: 'd:2000', count: 500 };
}

/** コース横断の評価の結果 */
export interface CrossResult {
  readonly rows: readonly CrossCourseRow[];
  /** コース 1 本あたりの試行回数 */
  readonly trials: number;
  /** 順位条件を判定したか。結果の読み方が変わるので結果と一緒に持つ。 */
  readonly useField: boolean;
  readonly elapsedMs: number;
  readonly cancelled: boolean;
}

/**
 * 条件に当たるコース。
 *
 * **呼ぶ側は `useMemo` で包むこと。** 毎回新しい配列が返るので、
 * `useStore` のセレクタの中で呼ぶと描画が止まる。
 */
export function crossCourses(cross: CrossSetting): CourseMatch[] {
  const [kind, value] = cross.distanceKey.split(':');
  return matchCourses(gameData.trackData, {
    surface: cross.surface,
    distance: kind === 'd' ? Number(value) : undefined,
    distanceCategory: kind === 'c' ? (value as Distance) : undefined,
  });
}

export type Theme = 'light' | 'dark';

/**
 * テーマだけは localStorage に置く。
 *
 * 他の設定と同じ IndexedDB に入れると読み出しが非同期になり、
 * 最初の描画が明色で出てから暗色に入れ替わる。同期で読める場所に置き、
 * index.html の先頭で data-theme を当てておく。
 */
const THEME_KEY = 'raceemu-theme';

export function loadTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

/**
 * タイムの分布を粗く畳んだもの。
 *
 * 分布を重ねて出すには毎試行の値が要るが、試行は最大 20 万回あるので
 * そのまま持つと 1 件で 1.6 MB になる。ビンに畳めば数百バイトで済み、
 * 図に描くぶんには元の値と区別が付かない。
 */
export interface Histogram {
  readonly min: number;
  readonly max: number;
  readonly counts: readonly number[];
}

export interface Snapshot {
  readonly id: number;
  readonly label: string;
  readonly uma: UmaStatus;
  readonly track: TrackRef;
  readonly skillIds: readonly string[];
  readonly options: RunOptions;
  readonly debuffCounts: Readonly<Record<string, number>>;
  readonly summary: SimulationSummary;
  readonly skillSummaries: readonly SkillSummary[];
  /** 分布の重ね合わせに使う。古いスナップショットには無い。 */
  readonly histogram?: Histogram;
  /** タイムの標準偏差。差の区間を出すのに使う。古いスナップショットには無い。 */
  readonly sd?: number;
}

const HISTOGRAM_BINS = 60;

function histogramOf(times: readonly number[]): Histogram | undefined {
  if (times.length === 0) return undefined;
  let min = Infinity;
  let max = -Infinity;
  for (const time of times) {
    if (time < min) min = time;
    if (time > max) max = time;
  }
  if (!(max > min)) return { min, max: min + 1, counts: [times.length] };
  const counts = new Array<number>(HISTOGRAM_BINS).fill(0);
  const width = (max - min) / HISTOGRAM_BINS;
  for (const time of times) {
    counts[Math.min(HISTOGRAM_BINS - 1, Math.floor((time - min) / width))]! += 1;
  }
  return { min, max, counts };
}

function standardDeviation(times: readonly number[], mean: number): number | undefined {
  if (times.length < 2) return undefined;
  let sum = 0;
  for (const time of times) sum += (time - mean) ** 2;
  return Math.sqrt(sum / (times.length - 1));
}

export interface InverseResult {
  readonly status: TargetStatus;
  readonly goal: Goal;
  readonly values: Float64Array;
  readonly races: number;
  readonly elapsedMs: number;
  readonly from: number;
  readonly to: number;
  readonly step: number;
  readonly method: 'bisect' | 'scan';
  /** 位置取り調整の回数ごとの最小値。試行ごとに ADJUSTMENT_COUNT_BUCKETS 個ずつ並ぶ。 */
  readonly byCount?: Float64Array;
}

export interface DetailData {
  readonly trial: number;
  readonly frames: readonly RaceFrame[];
  readonly state: RaceState;
}

interface AppState {
  uma: UmaStatus;
  track: TrackRef;
  skillIds: string[];
  count: number;
  seed: number;

  running: boolean;
  progress: number;
  elapsedMs: number;
  error: string | null;
  /** 失敗ではないが伝えたいこと。保存できない環境など。 */
  notice: string | null;
  summary: SimulationSummary | null;
  results: RaceSimulationResult[];
  skillSummaries: SkillSummary[];
  detail: DetailData | null;
  snapshots: Snapshot[];
  inverseStatus: TargetStatus;
  inverseGoal: Goal;
  inverseCount: number;
  /** 位置取り調整の回数ごとに段階表示するか。二分探索が使えなくなるぶん遅くなる。 */
  inverseByAdjustmentCount: boolean;
  inverseResult: InverseResult | null;
  /** 順位条件を実際に判定するか。false なら本家と同じく満たしている前提。 */
  useField: boolean;
  /** 順位条件を判定するときの相手の想定 */
  field: FieldSetting;
  /** 相手の強さを振ったときの発動率の幅。測る前は null。 */
  band: Record<string, TriggerBand> | null;
  bandRunning: boolean;
  /** 探索の途中で、いま評価している構成を相手にも配るか。 */
  optimizeSelfConsistent: boolean;
  /**
   * 所要時間の実測。条件ごとに最大 2 点を持つ（`paceKey` が鍵を作る）。
   * 2 点あると固定の費用と 1 試行あたりの費用を分けて出せる。
   */
  pace: Record<string, readonly PaceSample[]>;
  options: RunOptions;
  /** デバフの種類ごとの個数。0 の項目は持たない。 */
  debuffCounts: Record<string, number>;
  /** スキル ID からヒントレベル（0 から 5）。0 の項目は持たない。 */
  hintLevels: Record<string, number>;

  /** 相手の設定。頭数はコースの出走頭数から自分を引いた数に合わせる。 */
  opponents: Opponent[];
  multiTrials: number;
  multiRunning: boolean;
  multiResult: MultiResult | null;
  multiProgress: number;
  /** 勝率の面から開いた 1 本。開いていなければ null。 */
  multiDetail: MultiDetail | null;

  /** コース横断の評価の条件 */
  cross: CrossSetting;
  crossResult: CrossResult | null;
  crossRunning: boolean;
  /** 走り終えたコースの本数 */
  crossProgress: number;

  optimizeBudget: number;
  optimizeResult: OptimizeResult | null;
  optimizeLog: string[];
  optimizeRunning: boolean;
  /** サーバ側の探索の宛先。空なら無し。 */
  searchEndpoint: string;
  /** 投げ先。宛先が無ければブラウザとして扱う。 */
  searchTarget: SearchTarget;
  /** 直前の探索をどこで回したか。結果がどちらのものかを画面に出す。 */
  ranOnServer: boolean;

  /**
   * 近似の感度分析。振った値 1 つ、スキル 1 つあたり 1 構成を走らせる。
   * 相手の強さの幅（`runBand`）はレース 3 回で終わるが、こちらは重さが
   * 候補の数に比例して伸びる。押したときだけ測り、候補は上限で切る。
   * docs/solver-design.md 4.1 節を参照。
   */
  sensitivityAxis: SensitivityAxis;
  sensitivityTrials: number;
  /** 幅を測るスキルの上限。効きの大きいものから取る。 */
  sensitivityLimit: number;
  sensitivityResult: SensitivityResult | null;
  sensitivityLog: string[];
  sensitivityRunning: boolean;
  plan: PlanSetting;
  /** サポートカードと育成ウマ娘。読み込むまでは null。 */
  deck: DeckData | null;
  /** 直前の探索で使った候補。経路と割引を結果の表示に使う。 */
  planCandidates: PlanCandidates | null;

  dismissError: () => void;
  dismissNotice: () => void;
  setUma: (patch: Partial<UmaStatus>) => void;
  setTrack: (patch: Partial<TrackRef>) => void;
  toggleSkill: (id: string) => void;
  clearSkills: () => void;
  /** キャラを選ぶ。固有と進化はここからしか入らない。 */
  setCharaName: (charaName: string) => void;
  /** プリセットを丸ごと当てる。ウマ娘・コース・スキルを一度に差し替える。 */
  applyPreset: (preset: Preset) => void;
  /** 本家の設定文字列を読み込む。ステータス、適性、キャラ、スキルを丸ごと置き換える。 */
  applyTransfer: (parsed: ParsedTransfer) => void;
  setCount: (count: number) => void;
  setUseField: (useField: boolean) => void;
  setField: (patch: Partial<FieldSetting>) => void;
  /** 相手の強さを −100、0、+100 で走らせ、発動率の幅を測る。 */
  runBand: () => Promise<void>;
  setOptimizeSelfConsistent: (value: boolean) => void;
  setSeed: (seed: number) => void;
  setOptions: (patch: Partial<RunOptions>) => void;
  setDebuffCount: (id: string, count: number) => void;
  setHintLevel: (skillId: string, level: number) => void;
  run: () => Promise<void>;
  cancel: () => void;
  tab: Tab;
  setTab: (tab: Tab) => void;
  /** ハッシュが変わったとき（戻る・進む）に面を合わせる。 */
  syncTabFromHash: () => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  showTrial: (trial: number) => void;
  setInverse: (patch: {
    status?: TargetStatus;
    goal?: Goal;
    count?: number;
    byAdjustmentCount?: boolean;
  }) => void;
  solveInverse: () => Promise<void>;
  saveSnapshot: () => void;
  removeSnapshot: (id: number) => void;
  restoreSnapshot: (id: number) => void;
  setOpponent: (id: number, patch: Partial<UmaStatus>) => void;
  toggleOpponentSkill: (id: number, skillId: string) => void;
  /** 保存済みの個体をそのまま割り当てる。ステータスとスキルを丸ごと差し替える。 */
  setOpponentFromIndividual: (id: number, individual: Individual) => void;
  resetOpponents: () => void;
  setMultiTrials: (trials: number) => void;
  runMulti: () => Promise<void>;
  /** 勝率の 1 試行を同じ種で走らせ直して開く。null を渡すと閉じる。 */
  showMultiTrial: (trial: number | null) => void;
  setCross: (patch: Partial<CrossSetting>) => void;
  /** 条件に当たる全コースを順に走らせる。 */
  runCross: () => Promise<void>;
  setOptimizeBudget: (budget: number) => void;
  setSearchEndpoint: (endpoint: string) => void;
  setSearchTarget: (target: SearchTarget) => void;
  setPlan: (patch: Partial<PlanSetting>) => void;
  /** サポートカードと育成ウマ娘を読み込む。すでに読んであれば何もしない。 */
  loadDeck: () => Promise<void>;
  togglePlanCard: (id: number) => void;
  runOptimize: () => Promise<void>;
  /** 振る軸を選ぶ。倍率と「近く」の距離は別の世界なので、まとめずに 1 つずつ測る。 */
  setSensitivityAxis: (axis: SensitivityAxis) => void;
  setSensitivityTrials: (trials: number) => void;
  setSensitivityLimit: (limit: number) => void;
  /** 近似確率を半分と倍に振り、スキルごとの短縮量の幅を測る。 */
  runSensitivity: () => Promise<void>;
  shareUrl: () => string;
  applyShared: () => boolean;
  /** 保存してある設定とスナップショットを読み、そのあと共有 URL を当てる。 */
  bootstrap: () => Promise<void>;
}

/**
 * 読み込んだ設定にキャラを補う。
 *
 * 共有 URL はキャラを載せていない。持っているスキルの持ち主から引けるので、
 * 書式を増やさずに済む。保存してあった設定やスナップショットも、この変更より
 * 前のものはキャラが空なので、同じ道で埋まる。
 * 固有も進化も持っていないときは引けないため、そのまま残す。
 */
function withChara(uma: UmaStatus, skillIds: readonly string[]): UmaStatus {
  const chara = skillIndex.charaOf(skillIds);
  return chara === NO_CHARA ? uma : { ...uma, charaName: chara };
}

/**
 * 育成計画から候補を組み立てる。
 *
 * 静的な絞り込みにレースの設定が要るので、いま画面に入っている設定から作る。
 * コースや脚質を変えると候補も変わる。
 */
export function planCandidatesOf(state: AppState): PlanCandidates | null {
  if (state.plan.source === 'selected') return null;
  const derived = new DerivedSetting(
    { ...buildSetting(state), skills: [] },
    emptyPassiveBonus(),
    gameData.trackData,
  );
  // 落とす判定は 2 つの出どころで共通である。印（▲）は順位条件を判定するか
  // どうかで動くので、いまの設定を必ず添える（classify.ts）。
  const screening = {
    openWhites: state.plan.openWhites,
    openInheritedUniques: state.plan.openInheritedUniques,
    includeIgnoredOnly: state.plan.includeIgnoredOnly,
    excludeDropped: state.plan.excludeDropped,
    hasField: state.useField,
  };
  if (state.plan.source === 'all') {
    // 全スキルは入手経路を問わないので、デッキのデータを読み込まなくてよい。
    return buildAllSkillCandidates(gameData.skills, derived, {
      ...screening,
      openGolds: state.plan.openGolds,
    });
  }
  if (state.deck === null) return null;
  return buildPlanCandidates(
    gameData.skills,
    gameData.skillsByName,
    state.deck,
    derived,
    {
      charaId: state.plan.charaId,
      charaRank: state.plan.charaRank,
      cards: state.plan.cardIds.map((id) => ({ id })),
    },
    screening,
  );
}

/**
 * 保存してあった育成計画を読み直す。
 *
 * 候補の出どころが 2 通り（真偽値の `enabled`）から 3 通り（`source`）になった。
 * 古い保存には `enabled` しか無いので、立っていれば育成計画として読む。
 * 黙って「いま選んでいるスキル」に戻すと、次に探索したとき候補が変わる。
 */
export function restorePlan(saved: (PlanSetting & { enabled?: boolean }) | undefined): PlanSetting {
  const merged = { ...DEFAULT_PLAN, ...saved };
  if (saved?.source === undefined && saved?.enabled === true) merged.source = 'plan';
  return {
    source: merged.source,
    charaId: merged.charaId,
    charaRank: merged.charaRank,
    cardIds: merged.cardIds,
    openWhites: merged.openWhites,
    openInheritedUniques: merged.openInheritedUniques,
    openGolds: merged.openGolds,
    includeIgnoredOnly: merged.includeIgnoredOnly,
    excludeDropped: merged.excludeDropped,
  };
}

const saveSettings = debounceSave<PersistedSettings>('settings');
const saveSnapshots = debounceSave<Snapshot[]>('snapshots', 200);

let controller: AbortController | null = null;

export const useStore = create<AppState>((set, get) => ({
  uma: {
    charaName: '',
    speed: 1200,
    stamina: 1000,
    power: 900,
    guts: 600,
    wisdom: 900,
    condition: 'BEST',
    style: 'SEN',
    distanceFit: 'A',
    surfaceFit: 'A',
    styleFit: 'A',
    popularity: 1,
    gateNumber: 0,
    uniqueLevel: 6,
  },
  // 季節と天候と時刻の既定は指定あり。指定なしにすると本家と同じ扱いになり、
  // 春夏秋冬のスキルが同時に発動して、探索がそれを片端から拾う。
  track: { location: 10006, course: 10606, condition: 1, gateCount: 9, season: 1, weather: 1, time: 1 },
  skillIds: [],
  count: 2000,
  seed: 1,

  running: false,
  progress: 0,
  elapsedMs: 0,
  error: null,
  notice: null,
  summary: null,
  tab: 'settings',
  setTab: (tab) => set({ tab }),
  theme: loadTheme(),
  setTheme: (theme) => {
    set({ theme });
    document.documentElement.dataset['theme'] = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // 保存できなくても、その場の切替は効く。
    }
  },
  results: [],
  skillSummaries: [],
  detail: null,
  snapshots: [],
  inverseStatus: 'stamina',
  inverseGoal: { kind: 'maxSpurt' },
  inverseCount: 500,
  inverseByAdjustmentCount: false,
  inverseResult: null,
  /**
   * 順位条件を実際に判定するか。
   *
   * 既定で入れる。切ると本家と同じ「順位条件は満たしている前提」になり、
   * 後方寄りの条件が常に成立する甘い評価になる。探索もこの設定に従うので、
   * 切ったままだと探索が過大評価を突く（docs/solver-design.md 4 節）。
   * M6 のレポート 7 節が既定にすべきと書いていたもので、実装が追いついた。
   */
  useField: true,
  field: defaultFieldSetting(),
  band: null,
  bandRunning: false,
  optimizeSelfConsistent: false,
  pace: {},
  options: defaultRunOptions(),
  debuffCounts: {},
  hintLevels: {},

  opponents: [],
  multiTrials: 500,
  multiRunning: false,
  multiResult: null,
  multiProgress: 0,
  multiDetail: null,

  cross: defaultCrossSetting(),
  crossResult: null,
  crossRunning: false,
  crossProgress: 0,

  optimizeBudget: 600,
  // 宛先は既定で空にしてある。空なら今までどおりブラウザで回す。
  // 同一オリジンを既定にすると、静的配信だけの版が毎回 1 往復むだに叩く。
  searchEndpoint: '',
  searchTarget: 'browser',
  ranOnServer: false,
  plan: DEFAULT_PLAN,
  deck: null,
  planCandidates: null,
  optimizeResult: null,
  optimizeLog: [],
  optimizeRunning: false,
  // 既定は候補 8 個・300 試行。倍率 3 通りで 27 構成 × 300 = 8100 試行になる。
  // 手元の実測（2 Worker）でおよそ 25 秒で、押して待てる範囲に収まる。
  // 軸の既定は「近く」の距離である。順位条件の判定（`useField`）が既定で入っており、
  // そのとき位置から決まる 12 型には倍率が効かない。既定の設定で効くほうを先に出す。
  // 判定を切ったときは倍率のほうが効くので、画面が軸を選び直すよう促す。
  // docs/solver-design.md 4.1 節を参照。
  sensitivityAxis: 'near' as SensitivityAxis,
  sensitivityTrials: 300,
  sensitivityLimit: 8,
  sensitivityResult: null,
  sensitivityLog: [],
  sensitivityRunning: false,

  dismissError: () => set({ error: null }),
  dismissNotice: () => set({ notice: null }),
  setUma: (patch) => set((s) => ({ uma: { ...s.uma, ...patch } })),
  setTrack: (patch) => set((s) => ({ track: { ...s.track, ...patch } })),
  toggleSkill: (id) => set((s) => ({ skillIds: skillIndex.toggle(s.skillIds, id) })),
  clearSkills: () => set((s) => ({ uma: { ...s.uma, charaName: NO_CHARA }, skillIds: [] })),
  setCharaName: (charaName) =>
    set((s) => ({
      uma: { ...s.uma, charaName },
      skillIds: skillIndex.applyChara(s.skillIds, charaName),
    })),
  applyPreset: (preset) =>
    set({
      uma: { charaName: NO_CHARA, ...preset.uma },
      track: preset.track,
      skillIds: resolveSkillIds(preset.skillNames),
    }),
  applyTransfer: (parsed) =>
    set((s) => {
      const uma = { ...s.uma, ...parsed.status, ...parsed.fits };
      // 同じグループのものを 2 つ持たない規則は、1 つずつ足して任せる。
      let skillIds: string[] = [];
      for (const id of parsed.skillIds) skillIds = skillIndex.toggle(skillIds, id);
      // キャラ名が書いていなければ未選択にする。持ち込んだ文字列のほうを正とする
      // ので、前のキャラの固有だけが残る状態を作らない。
      const charaName = parsed.charaName ?? NO_CHARA;
      return {
        uma: { ...uma, charaName },
        skillIds: skillIndex.applyChara(skillIds, charaName),
      };
    }),
  setCount: (count) => set({ count }),
  setUseField: (useField) => set({ useField }),
  setField: (patch) => set((s) => ({ field: { ...s.field, ...patch }, band: null })),
  setOptimizeSelfConsistent: (optimizeSelfConsistent) => set({ optimizeSelfConsistent }),

  runBand: async () => {
    const state = get();
    if (state.running || state.bandRunning) return;
    const spec = fieldSpec(state);
    if (spec === null) {
      set({ notice: '順位条件を判定していないので、相手の強さを振っても発動率は動きません。' });
      return;
    }
    controller = new AbortController();
    set({ bandRunning: true, error: null });
    try {
      const setting = buildSetting(state);
      const serializable = toSerializable(setting);
      // 3 通りぶん余計に走るので、試行数は本体より落とす。
      // 見たいのは幅であって、小数第 1 位まで合わせる必要は無い。
      const count = Math.max(100, Math.min(state.count, 2000));
      const rates = await Promise.all(
        [-100, 0, 100].map(async (offset) => {
          const { skillStats, results } = await getPool().run(serializable, system, {
            count,
            seed: state.seed,
            signal: controller?.signal,
            field: { ...spec, profile: { ...spec.profile, offset: spec.profile.offset + offset } },
          });
          const summaries = toSkillSummaries(serializable.skillIds, skillStats, results.length);
          return new Map(summaries.map((summary) => [summary.skillId, summary.triggerRate]));
        }),
      );
      const band: Record<string, TriggerBand> = {};
      for (const id of serializable.skillIds) {
        band[id] = {
          weaker: rates[0]!.get(id) ?? 0,
          base: rates[1]!.get(id) ?? 0,
          stronger: rates[2]!.get(id) ?? 0,
        };
      }
      set({ band });
    } catch (error) {
      if (!(error instanceof SimulationCancelled)) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      set({ bandRunning: false });
    }
  },
  setSeed: (seed) => set({ seed }),
  setOpponent: (id, patch) =>
    set((s) => ({
      opponents: s.opponents.map((o) => (o.id === id ? { ...o, uma: { ...o.uma, ...patch } } : o)),
    })),
  toggleOpponentSkill: (id, skillId) =>
    set((s) => ({
      opponents: s.opponents.map((o) =>
        o.id === id
          ? {
              ...o,
              skillIds: o.skillIds.includes(skillId)
                ? o.skillIds.filter((x) => x !== skillId)
                : [...o.skillIds, skillId],
            }
          : o,
      ),
    })),
  setOpponentFromIndividual: (id, individual) =>
    set((s) => ({
      opponents: s.opponents.map((o) =>
        o.id === id ? { ...o, uma: individual.uma, skillIds: individual.skillIds } : o,
      ),
    })),
  resetOpponents: () => set({ opponents: defaultOpponents(get().track.gateCount) }),
  setMultiTrials: (multiTrials) => set({ multiTrials }),

  /**
   * 出走する全頭を同時に走らせ、着順の分布を出す。
   *
   * 1 試行が頭数ぶん重いので、Worker に投げて進捗を返す。
   * 中断したときは、そこまでに終わった試行だけを集計する。
   */
  runMulti: async () => {
    const state = get();
    if (state.running || state.multiRunning || state.optimizeRunning) return;
    const opponents = state.opponents.length > 0 ? state.opponents : defaultOpponents(state.track.gateCount);
    if (state.opponents.length === 0) set({ opponents });
    controller = new AbortController();
    set({ multiRunning: true, multiProgress: 0, error: null, multiResult: null, multiDetail: null });
    const started = performance.now();
    try {
      // 1 試行を開くときに同じレースを走らせ直せるよう、走らせた設定をそのまま取っておく。
      const settings: RaceSetting[] = [
        buildSetting(state),
        ...opponents.map((opponent) => ({
          ...buildSetting(state),
          uma: opponent.uma,
          skills: opponent.skillIds.map((id) => gameData.skillsById.get(id)!).filter(Boolean),
        })),
      ];
      const entries = settings.map((setting) => toSerializable(setting));
      const { packed, entries: width, cancelled, trialIndices } = await getPool().runMulti(entries, system, {
        count: state.multiTrials,
        seed: state.seed,
        onProgress: (done) => set({ multiProgress: done }),
        signal: controller.signal,
        keepPartial: true,
      });
      const tally = new OrderTally(width);
      const trials = width === 0 ? 0 : packed.length / (width * MULTI_FIELDS);
      const selfTrials: MultiTrialRecord[] = [];
      for (let t = 0; t < trials; t++) {
        const entryResults = [...Array(width).keys()].map((index) => ({
          index,
          ...unpackMultiEntry(packed, (t * width + index) * MULTI_FIELDS),
        }));
        // 中断したときは詰め直しで並びと試行番号がずれるので、番号のほうを見る。
        const trial = trialIndices?.[t] ?? t;
        const self = entryResults[0]!;
        selfTrials.push({ trial, order: self.order, raceTime: self.result.raceTime });
        tally.add({ entries: entryResults, states: [], frames: 0 });
      }
      const multiElapsedMs = performance.now() - started;
      set({
        multiResult: {
          summaries: tally.summarizeAll(),
          trials,
          elapsedMs: multiElapsedMs,
          cancelled: cancelled === true,
          selfTrials,
          entries: settings,
          seed: state.seed,
        },
        pace:
          trials === 0
            ? state.pace
            : recordPace(state.pace, multiPaceKey(state.track.gateCount), {
                count: trials,
                ms: multiElapsedMs,
              }),
        tab: 'field',
      });
    } catch (error) {
      if (!(error instanceof SimulationCancelled)) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      set({ multiRunning: false, multiProgress: 0 });
      controller = null;
    }
  },

  /**
   * 勝率の 1 試行を開く。
   *
   * フレーム列は持っていないので、そのときの設定と種で同じ試行を走らせ直す。
   * 乱数は `(baseSeed, trial, streamKey)` から決まるので、走らせ直しても
   * 着順もタイムも元の実行と同じになる（`packages/sim/test/multi.test.ts`）。
   * 9 頭で数十 ms なので、押してから出るまでの間に合う。
   */
  showMultiTrial: (trial) => {
    if (trial === null) {
      set({ multiDetail: null });
      return;
    }
    const state = get();
    const result = state.multiResult;
    if (result === null || result.entries.length === 0) return;
    const calculator = new RaceCalculator(system, gameData.trackData);
    const started = performance.now();
    const replay = replayMultiRace(
      calculator,
      result.entries.map((setting) => ({ setting })),
      { seed: result.seed, trial, focus: 0 },
    );
    set({ multiDetail: { trial, replay, elapsedMs: performance.now() - started } });
  },

  setCross: (patch) => set((s) => ({ cross: { ...s.cross, ...patch } })),

  /**
   * 条件に当たる全コースを順に走らせる。
   *
   * 順位条件の扱いは単騎の実行と同じ設定（`useField`）に従う。ここだけ別の
   * 回し方にすると、結果の面の数字とコース横断の表の数字が別の意味を持つことに
   * なり、並べて読めない。判定したかどうかは結果に添えて画面に出す。
   *
   * 束はコースごとに作り直す（相手の走りがコースに依る）。鍵から決まるので
   * 同じ指定なら同じ束になり、走らせ直しても行は動かない。
   */
  runCross: async () => {
    const state = get();
    if (state.running || state.multiRunning || state.optimizeRunning || state.crossRunning) return;
    const courses = crossCourses(state.cross);
    if (courses.length === 0) {
      set({ notice: 'この距離とバ場に当たるコースがありません。' });
      return;
    }
    controller = new AbortController();
    set({ crossRunning: true, crossProgress: 0, error: null, crossResult: null });
    const started = performance.now();
    try {
      const spec = fieldSpec(state);
      const { rows, cancelled } = await runCrossCourse(
        getPool(),
        toSerializable(buildSetting(state)),
        system,
        courses,
        {
          count: state.cross.count,
          seed: state.seed,
          signal: controller.signal,
          onCourse: (done) => set({ crossProgress: done }),
          // コースごとに差し替えるので、ここではコースを渡さない。
          field: spec === null ? null : { profile: spec.profile, seed: spec.seed, samples: spec.samples },
        },
      );
      if (rows.length === 0) {
        set({ notice: '中断しました。1 コースも走り終えていません。' });
        return;
      }
      const elapsedMs = performance.now() - started;
      set({
        crossResult: {
          rows,
          trials: state.cross.count,
          useField: state.useField,
          elapsedMs,
          cancelled,
        },
        // 見積もりはコース 1 本あたりで持つ。本数は条件で変わるので、
        // 覚えるのは「1 本にいくらかかったか」のほうである。
        pace: recordPace(state.pace, crossPaceKey(state.useField), {
          count: state.cross.count,
          ms: elapsedMs / rows.length,
        }),
        notice: cancelled
          ? `${courses.length} コースのうち ${rows.length} コースで中断しました。ここまでの結果を出しています。`
          : null,
        tab: 'compare',
      });
    } catch (error) {
      if (!(error instanceof SimulationCancelled)) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      set({ crossRunning: false, crossProgress: 0 });
      controller = null;
    }
  },

  setOptimizeBudget: (optimizeBudget) => set({ optimizeBudget }),
  setSearchEndpoint: (searchEndpoint) => set({ searchEndpoint }),
  setSearchTarget: (searchTarget) => set({ searchTarget }),
  setPlan: (patch) => {
    set((s) => ({ plan: { ...s.plan, ...patch } }));
    // デッキのデータは育成計画のときにしか要らない。全スキルは経路を問わない。
    if (patch.source === 'plan') void get().loadDeck();
  },
  loadDeck: async () => {
    if (get().deck !== null) return;
    try {
      set({ deck: await fetchDeckData() });
    } catch {
      set({ error: 'サポートカードと育成ウマ娘のデータを読み込めませんでした。' });
    }
  },
  togglePlanCard: (id) =>
    set((s) => {
      const held = s.plan.cardIds.includes(id);
      // デッキは 6 枚まで。7 枚目を選んだら、いちばん古いものを押し出す。
      const next = held
        ? s.plan.cardIds.filter((x) => x !== id)
        : [...s.plan.cardIds, id].slice(-6);
      return { plan: { ...s.plan, cardIds: next } };
    }),
  setOptions: (patch) => set((s) => ({ options: { ...s.options, ...patch } })),
  setDebuffCount: (id, count) =>
    set((s) => {
      const next = { ...s.debuffCounts };
      if (count > 0) next[id] = count;
      else delete next[id];
      return { debuffCounts: next };
    }),
  setHintLevel: (skillId, level) =>
    set((s) => {
      const next = { ...s.hintLevels };
      if (level > 0) next[skillId] = level;
      else delete next[skillId];
      return { hintLevels: next };
    }),

  run: async () => {
    const state = get();
    if (state.running) return;
    controller = new AbortController();
    set({ running: true, progress: 0, error: null, detail: null, skillSummaries: [], band: null });
    const started = performance.now();
    try {
      const setting = buildSetting(state);
      const serializable = toSerializable(setting);
      const { results, skillStats, cancelled } = await getPool().run(serializable, system, {
        count: state.count,
        seed: state.seed,
        onProgress: (done) => set({ progress: done }),
        signal: controller.signal,
        // 止めたときに何も残らないと、長く走らせたあとに手を止めた人が
        // 最初からやり直すことになる。終わったぶんは見せる。
        keepPartial: true,
        field: fieldSpec(state),
      });
      const elapsedMs = performance.now() - started;
      if (results.length === 0) {
        // 1 件も終わる前に止めた。前の結果を消さずにそのままにする。
        set({ notice: '中断しました。結果はまだ 1 件も集まっていません。' });
        return;
      }
      set({
        summary: summarize(results, elapsedMs),
        results,
        elapsedMs,
        // 次に押す前の見積もりに使う。中断しても、終わったぶんの回数で数えれば点になる。
        pace: recordPace(state.pace, paceKey(state.useField), {
          count: results.length,
          ms: elapsedMs,
        }),
        skillSummaries: toSkillSummaries(serializable.skillIds, skillStats, results.length),
        notice:
          cancelled === true
            ? `${state.count.toLocaleString('ja-JP')} 件のうち ${results.length.toLocaleString('ja-JP')} 件で中断しました。ここまでの結果を出しています。`
            : null,
      });
      get().showTrial(0);
      // 走らせた人が次に見たいのは結果である。設定の面に留まらせない。
      set({ tab: 'summary' });
    } catch (error) {
      if (error instanceof SimulationCancelled) set({ error: null });
      else set({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      set({ running: false, progress: 0 });
      controller = null;
    }
  },

  cancel: () => controller?.abort(),

  showTrial: (trial) => {
    const state = get();
    const setting = buildSetting(state);
    const calculator = new RaceCalculator(system, gameData.trackData);
    const { state: raceState } = calculator.simulate(setting, {
      seed: state.seed,
      trial,
      recordFrames: true,
      field: state.useField ? getDetailField(state) : null,
    });
    set({ detail: { trial, frames: raceState.simulation.frames, state: raceState } });
  },

  setInverse: (patch) =>
    set((s) => ({
      inverseStatus: patch.status ?? s.inverseStatus,
      inverseGoal: patch.goal ?? s.inverseGoal,
      inverseCount: patch.count ?? s.inverseCount,
      inverseByAdjustmentCount: patch.byAdjustmentCount ?? s.inverseByAdjustmentCount,
    })),

  solveInverse: async () => {
    const state = get();
    if (state.running) return;
    controller = new AbortController();
    set({ running: true, progress: 0, error: null, inverseResult: null });
    const started = performance.now();
    // 探索範囲は 200 から 1600 まで 10 刻み。ステータスの現実的な幅に合わせる。
    const from = 200;
    const to = 1600;
    const step = 10;
    const goal = state.inverseGoal;
    const byAdjustmentCount = state.inverseByAdjustmentCount;
    // 回数ごとの内訳が要るときは二分探索では拾えないので、常に全走査にする。
    const method = byAdjustmentCount ? 'scan' : resolveMethod({ status: state.inverseStatus, goal, from, to, step });
    try {
      const { values, races, byCount } = await getPool().runCritical(
        toSerializable(buildSetting(state)),
        system,
        {
          status: state.inverseStatus,
          goalKind: goal.kind,
          goalValue: goal.kind === 'goalSp' ? goal.atLeast : undefined,
          from,
          to,
          step,
          method,
          byAdjustmentCount,
        },
        {
          count: state.inverseCount,
          seed: state.seed,
          onProgress: (done) => set({ progress: done }),
          signal: controller.signal,
          // 結果や探索と同じ相手で測る。ここだけ順位条件を素通りさせると、
          // 必要量が小さく出る（足りない側に外れる）。
          field: fieldSpec(state),
        },
      );
      set({
        inverseResult: {
          status: state.inverseStatus,
          goal,
          values,
          races,
          elapsedMs: performance.now() - started,
          from,
          to,
          step,
          method,
          byCount,
        },
      });
    } catch (error) {
      if (!(error instanceof SimulationCancelled)) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      set({ running: false, progress: 0 });
      controller = null;
    }
  },

  saveSnapshot: () => {
    const state = get();
    if (state.summary === null) return;
    const id = (state.snapshots[0]?.id ?? 0) + 1;
    const track = currentTrackDetail(state.track);
    const times = state.results.map((r) => r.raceTime);
    const label = `#${id} ${track?.name ?? ''} ${state.uma.speed}/${state.uma.stamina}/${state.uma.power}/${state.uma.guts}/${state.uma.wisdom}`;
    set({
      snapshots: [
        {
          id,
          label,
          uma: state.uma,
          track: state.track,
          skillIds: [...state.skillIds],
          options: state.options,
          debuffCounts: { ...state.debuffCounts },
          summary: state.summary,
          skillSummaries: state.skillSummaries,
          histogram: histogramOf(times),
          sd: standardDeviation(times, state.summary.all.averageTime),
        },
        ...state.snapshots,
      ],
    });
  },

  removeSnapshot: (id) => set((s) => ({ snapshots: s.snapshots.filter((x) => x.id !== id) })),

  restoreSnapshot: (id) => {
    const snapshot = get().snapshots.find((x) => x.id === id);
    if (snapshot === undefined) return;
    set({
      uma: withChara(snapshot.uma, snapshot.skillIds),
      track: snapshot.track,
      skillIds: [...snapshot.skillIds],
      options: snapshot.options,
      debuffCounts: { ...snapshot.debuffCounts },
    });
  },

  /**
   * いま選んでいるスキルを候補の集合として、予算に収まる最良の組み合わせを探す。
   *
   * 候補どうしの比較は同じ試行番号どうしの引き算で行う。
   * 効かないスキルを足したときの差は厳密に 0 になるので、
   * 何千本も走らせなくても順序が付く。
   */
  runOptimize: async () => {
    if (get().running || get().optimizeRunning) return;
    if (get().plan.source === 'plan') await get().loadDeck();
    const state = get();

    // 育成計画と全スキルのときは、候補を手持ちではなく入手経路から作る。
    // docs/solver-design.md 7 節と docs/server-design.md 1 節を参照。
    const plan = planCandidatesOf(state);
    const candidates = plan === null ? [...state.skillIds] : [...plan.skillIds];
    const hintLevels = plan === null ? state.hintLevels : plan.hintLevels;
    const always =
      plan === null
        ? []
        : plan.alwaysSkillIds
            .map((id) => gameData.skillsById.get(id))
            .filter((skill): skill is NonNullable<typeof skill> => skill !== undefined);

    if (candidates.length < 2) {
      set({
        error:
          plan === null
            ? '候補にするスキルを 2 つ以上選ぶ'
            : state.plan.source === 'all'
              ? '候補が集まらない。白・金・固有の継承版のどれかを開く'
              : '候補が集まらない。育成ウマ娘かサポートカードを選ぶか、白と固有の継承版を開く',
      });
      return;
    }
    controller = new AbortController();
    const signal = controller.signal;
    const base = toSerializable({ ...buildSetting(state), skills: always });
    const field = fieldSpec(state);
    set({
      optimizeRunning: true,
      error: null,
      optimizeResult: null,
      optimizeLog: [],
      planCandidates: plan,
      ranOnServer: false,
    });
    try {
      let result: OptimizeResult | null = null;

      // 宛先があってサーバを選んでいれば、まずそちらに投げる。
      // 落ちたらブラウザで回す。サーバは加速装置であって依存先ではない
      // （docs/server-design.md 2 節）ので、ここで倒れてはならない。
      if (hasEndpoint(state.searchEndpoint) && state.searchTarget === 'server') {
        try {
          set({ optimizeLog: ['サーバに投げた。順番待ちがあれば待つ。'], ranOnServer: true });
          result = await runServerSearch(
            state.searchEndpoint,
            {
              base,
              candidates,
              budget: state.optimizeBudget,
              seed: state.seed,
              // 相手の中身はサーバ側が既定で作る。頭数だけを渡す（同 7 節）。
              field: field === null ? null : { gateCount: state.track.gateCount },
              hintLevels,
            },
            {
              signal,
              onProgress: (lines, races) =>
                set({
                  optimizeLog: [
                    `サーバで実行中（レース ${races.toLocaleString()} 本）`,
                    ...lines,
                  ],
                }),
            },
          );
        } catch (error) {
          // サーバが居ないときだけ落とす。断られたとき（候補が多すぎる、混んでいる、
          // レース数の上限を超えた）は落とさない。サーバに投げるほど重い探索を
          // 黙ってブラウザに回すと、数十分固まるためである。
          if (!(error instanceof ServerSearchUnavailable)) throw error;
          set({
            ranOnServer: false,
            optimizeLog: [`サーバが居なかった: ${error.message}`, 'ブラウザで回す。'],
          });
        }
      }

      if (result === null) {
        result = await optimizeSkills(
          {
            pool: getPool(),
            system,
            base,
            cost: costModelFor(hintLevels),
            seed: state.seed,
            field,
          },
          {
            candidates,
            budget: state.optimizeBudget,
            selfConsistent: state.optimizeSelfConsistent,
            signal,
            onProgress: (message) => set((s) => ({ optimizeLog: [...s.optimizeLog, message] })),
          },
        );
      }
      set({ optimizeResult: result });
    } catch (error) {
      if (!(error instanceof SimulationCancelled)) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      set({ optimizeRunning: false });
      controller = null;
    }
  },

  setSensitivityAxis: (sensitivityAxis) => set({ sensitivityAxis, sensitivityResult: null }),
  setSensitivityTrials: (sensitivityTrials) => set({ sensitivityTrials }),
  setSensitivityLimit: (sensitivityLimit) => set({ sensitivityLimit }),

  /**
   * 近似の置き方を振り、スキルごとの短縮量がどれだけ動くかを測る。
   *
   * 振る軸は 2 つある。近似確率の倍率（`rate`）と「近く」の距離（`near`）で、
   * 別々に置いた値なので 1 つの幅にまとめず、選んだほうだけを測る
   * （docs/solver-design.md 4.1 節）。
   *
   * 相手の強さの幅（`runBand`）と違って、振った値 1 つにつきスキルの数だけ構成を
   * 走らせる。3 通り × (1 + 候補数) 構成なので、候補を絞らないと終わらない。
   * 探索を先に走らせてあれば、その解と効きの大きい候補から上限ぶんを取る。
   */
  runSensitivity: async () => {
    const state = get();
    if (state.running || state.optimizeRunning || state.sensitivityRunning) return;

    // 基準は候補を 1 つも取らない構成にする。探索の「単体」と同じ測り方にして、
    // 短縮量をそのまま突き合わせられるようにするためである。
    const plan = state.plan.source === 'selected' ? null : state.planCandidates;
    const always =
      plan === null
        ? []
        : plan.alwaysSkillIds
            .map((id) => gameData.skillsById.get(id))
            .filter((skill): skill is NonNullable<typeof skill> => skill !== undefined);
    const candidates = sensitivityCandidates(state);
    if (candidates.length === 0) {
      set({ error: '幅を測るスキルを選ぶか、先に探索を走らせる' });
      return;
    }

    controller = new AbortController();
    set({ sensitivityRunning: true, error: null, sensitivityResult: null, sensitivityLog: [] });
    try {
      const result = await measureSensitivity(
        {
          pool: getPool(),
          system,
          base: toSerializable({ ...buildSetting(state), skills: always }),
          cost: costModelFor(plan === null ? state.hintLevels : plan.hintLevels),
          seed: state.seed,
          field: fieldSpec(state),
        },
        {
          candidates,
          trials: state.sensitivityTrials,
          axis: state.sensitivityAxis,
          scales: sensitivityScales(state.sensitivityAxis),
          skillsById: gameData.skillsById,
          signal: controller.signal,
          onProgress: (message) => set((s) => ({ sensitivityLog: [...s.sensitivityLog, message] })),
        },
      );
      set((s) => ({
        sensitivityResult: result,
        // 次に押す前の見積もりに使う。走った試行の総数で数えれば点になる。
        pace: recordPace(s.pace, sensitivityPaceKey(s.useField, s.sensitivityAxis), {
          count: result.races,
          ms: result.elapsedMs,
        }),
      }));
    } catch (error) {
      if (!(error instanceof SimulationCancelled)) {
        set({ error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      set({ sensitivityRunning: false });
      controller = null;
    }
  },

  shareUrl: () => {
    const state = get();
    const encoded = encodeShareState({
      uma: state.uma,
      track: state.track,
      skillIds: state.skillIds,
      count: state.count,
      seed: state.seed,
      options: state.options,
      debuffCounts: state.debuffCounts,
      hintLevels: state.hintLevels,
      useField: state.useField,
      field: state.field,
    });
    // 面も載せる。「この設定の探索の面を見て」をリンク 1 本で渡せるようにする。
    return `${location.origin}${location.pathname}${hashWithTab(`#s=${encoded}`, state.tab)}`;
  },

  bootstrap: async () => {
    // 面はハッシュから同期で読む。描き始めてから移ると画面が跳ねる。
    const tab = toTab(readTabFromHash(location.hash));
    if (tab !== null) set({ tab });
    // 共有 URL はハッシュから同期で読めるので先に当てる。
    // IndexedDB を待つと、リンクを開いた人に既定値が一瞬見えてしまう。
    // 保存してある設定より共有 URL のほうが強い、という順序でもある。
    const shared = get().applyShared();
    const [settings, snapshots] = await Promise.all([
      loadPersisted<PersistedSettings>('settings'),
      loadPersisted<Snapshot[]>('snapshots'),
    ]);
    if (!shared && settings !== null) {
      set({
        uma: withChara(settings.uma, settings.skillIds),
        track: settings.track,
        skillIds: [...settings.skillIds],
        count: settings.count,
        seed: settings.seed,
        options: settings.options,
        debuffCounts: { ...settings.debuffCounts },
        hintLevels: { ...settings.hintLevels },
        useField: settings.useField,
        // 相手の想定と育成計画は後から足した項目なので、古い保存には入っていない。
        field: { ...defaultFieldSetting(), ...settings.field },
        plan: restorePlan(settings.plan),
        searchEndpoint: settings.searchEndpoint ?? '',
        searchTarget: settings.searchTarget ?? 'browser',
        cross: { ...defaultCrossSetting(), ...settings.cross },
      });
    }
    if (snapshots !== null) set({ snapshots });
    if (!(await isPersistenceAvailable())) {
      set({
        notice:
          'このブラウザでは設定を保存できません。閉じると入力は消えます。共有リンクを作っておくと戻せます。',
      });
    }
    hydrated = true;
  },

  syncTabFromHash: () => {
    const tab = toTab(readTabFromHash(location.hash));
    if (tab !== null && tab !== get().tab) set({ tab });
  },

  applyShared: () => {
    const match = /[#&]s=([^&]+)/.exec(location.hash);
    if (match === null) return false;
    const shared = decodeShareState(match[1]!);
    if (shared === null) {
      // 途中で切れたリンクや、古すぎる書式。黙って既定値で開くと、
      // 送った側と違う設定を見ていることに気付けない。
      set({
        error:
          '共有リンクの設定を読み取れませんでした。リンクが途中で切れているか、書式が古い可能性があります。既定の設定で開いています。',
      });
      return false;
    }
    set({
      uma: withChara(shared.uma, shared.skillIds),
      track: shared.track,
      skillIds: [...shared.skillIds],
      count: shared.count,
      seed: shared.seed,
      options: shared.options,
      debuffCounts: { ...shared.debuffCounts },
      hintLevels: { ...shared.hintLevels },
      useField: shared.useField,
      field: { ...defaultFieldSetting(), ...shared.field },
    });
    return true;
  },
}));

/**
 * 相手の既定。フィールド軌跡モデルと同じ想定から作るので、
 * 二つの方式を同じ相手で比べられる。
 */
export function defaultOpponents(gateCount: number): Opponent[] {
  const profile = defaultFieldProfile(gateCount);
  const styles: Style[] = ['NIGE', 'SEN', 'SASI', 'OI'];
  const list: Opponent[] = [];
  for (const style of styles) {
    for (let i = 0; i < (profile.counts[style] ?? 0); i++) {
      list.push({
        id: list.length + 1,
        uma: { ...profile.uma, charaName: '', style, gateNumber: 0 },
        skillIds: [],
      });
    }
  }
  return list;
}

/**
 * 軸ごとに振る値。どちらも基準値を真ん中に挟み、半分と倍に振る。
 *
 * 倍率は `approximateRateScale` の 0.5 / 1.0 / 2.0、距離は `nearLaneMeters` の
 * 1.25 / 2.5 / 5 m である。根拠のある値ではなく、**桁で振って動くかを見るための目盛り**
 * である（docs/solver-design.md 4.1 節）。基準値は `baseValueOf` から引き、
 * 幅の基準が計算側とずれないようにしてある。
 */
export function sensitivityScales(axis: SensitivityAxis): readonly number[] {
  if (axis === 'rate') return DEFAULT_SCALES;
  const base = baseValueOf('near');
  return [base / 2, base, base * 2];
}

/**
 * 近似の感度分析で幅を測るスキルを選ぶ。
 *
 * 倍率 1 つにつき候補の数だけ構成を走らせるので、候補を全部は測れない。
 * 探索を先に走らせてあれば、その最良の構成を先に取り、残りを効きの大きい順
 * （`singles` は限界貢献度で並べてある）で埋める。走らせていなければ、
 * いま選んでいるスキルの先頭から取る。
 */
export function sensitivityCandidates(state: {
  skillIds: readonly string[];
  optimizeResult: OptimizeResult | null;
  sensitivityLimit: number;
}): string[] {
  const limit = Math.max(1, Math.min(30, Math.floor(state.sensitivityLimit)));
  const result = state.optimizeResult;
  const ordered =
    result === null
      ? [...state.skillIds]
      : [...result.best, ...result.singles.map((single) => single.skillId)];
  return [...new Set(ordered)].slice(0, limit);
}

/** 順位条件を判定するときの相手の想定。頭数は 9 と 12 だけを扱う。 */
function fieldSpec(state: AppState) {
  if (!state.useField) return null;
  const base = defaultFieldProfile(state.track.gateCount);
  const field = state.field;
  return {
    profile: {
      ...base,
      matchSelf: field.matchSelf,
      offset: field.offset,
      sigma: field.sigma,
      // やる気はステータスのばらつきと一緒に扱う。片方だけ固定する意味が無い。
      drawCondition: field.sigma > 0,
      redrawComposition: field.redrawComposition,
      withSkills: field.withSkills,
    },
    track: state.track,
    seed: 9001,
    samples: 64,
  };
}

/** 本家の設定文字列を読み書きするための引き当て表。 */
export const transferIndex = buildTransferIndex(gameData, skillIndex);

/** いまの設定を本家に渡す 1 行にする。 */
export function transferTextOf(state: { uma: UmaStatus; skillIds: readonly string[] }): string {
  return formatTransfer(state.uma, state.skillIds, transferIndex);
}

/**
 * 所要時間の見積もり。
 *
 * 試行回数は単騎で 20 万、全頭同時で 5 万まで指定できる。押す前に何も出ないと、
 * 数十分かかる設定を作ってから初めて気付くことになる（docs/roadmap.md 4.2 節）。
 *
 * **回数に比例しない費用がある。** Worker を立てる手間と、順位条件を入れたときに
 * Worker ごとにフィールドの束（64 本）を組む手間は、回数を増やしても変わらない。
 * 順位条件ありでは 2 秒を超え、2000 試行の実測からそのまま比例で伸ばすと
 * 20000 試行を 2.5 倍に見積もる。そこで固定のぶんと 1 試行あたりのぶんを分け、
 * 回数の違う 2 点が揃ったら直線を当てる。
 *
 * 下の目安は手元（Windows、24 スレッド、Worker 23 本、東京 芝2400m）で測った。
 *
 * | 条件 | 固定 | 1 試行 |
 * | --- | ---: | ---: |
 * | 単騎・順位条件なし | 1.9 秒 | 0.24 ms |
 * | 単騎・順位条件あり | 2.7 秒 | 0.64 ms |
 * | 9 頭同時 | 0.6 秒 | 4.43 ms |
 *
 * 機種差が 1.5 倍ほどあるので、走らせて実測に置き換わるまでは外れうる。
 */
interface Pace {
  /** 回数によらずかかるぶん（ミリ秒） */
  readonly fixedMs: number;
  /** 1 試行あたり（ミリ秒） */
  readonly perTrialMs: number;
}

const FALLBACK_PACE = {
  solo: { fixedMs: 1900, perTrialMs: 0.24 },
  field: { fixedMs: 2700, perTrialMs: 0.64 },
  /** 全頭同時は 1 試行のぶんが頭数にほぼ比例する。9 頭 4.43 ms を割ったもの。 */
  multi: { fixedMs: 600, perTrialMsPerHorse: 4.43 / 9 },
  /**
   * コース横断は**コース 1 本あたり**の目安である。全体はこれに本数を掛ける。
   *
   * 1 試行あたりは単騎と同じで、固定のぶんだけが違う。Worker を立てる手間は
   * 最初の 1 本にしか掛からないかわりに、順位条件ありでは**コースごとに束を
   * 作り直す**（相手の走りがコースに依る）ぶんが毎回乗る。これが順位条件ありの
   * 大半を占める。docs/roadmap.md 3.3 節の実測を参照。
   */
  cross: {
    solo: { fixedMs: 200, perTrialMs: 0.24 },
    field: { fixedMs: 1000, perTrialMs: 0.64 },
  },
} as const;

/** 実測の 1 点。回数と、そのときかかった実時間。 */
export interface PaceSample {
  readonly count: number;
  readonly ms: number;
}

/**
 * 実測を書き足す。いちばん新しい 1 点と、回数の違う直前の 1 点を残す。
 * 同じ回数で何度も走らせても 2 点目が埋まらないので、古いほうを捨てない。
 */
export function recordPace(
  pace: Readonly<Record<string, readonly PaceSample[]>>,
  key: string,
  sample: PaceSample,
): Record<string, readonly PaceSample[]> {
  const previous = pace[key] ?? [];
  const other = previous.find((entry) => entry.count !== sample.count);
  return { ...pace, [key]: other === undefined ? [sample] : [sample, other] };
}

/** 2 点あれば直線を当てる。当てられなければ比例で伸ばす。 */
function paceOf(samples: readonly PaceSample[], fallback: Pace): { pace: Pace; measured: boolean } {
  const [latest, other] = samples;
  if (latest === undefined) return { pace: fallback, measured: false };
  if (other !== undefined && other.count !== latest.count) {
    const perTrialMs = (latest.ms - other.ms) / (latest.count - other.count);
    const fixedMs = latest.ms - perTrialMs * latest.count;
    // 揺らぎで傾きや固定のぶんが負に出ることがある。そのときは比例に落とす。
    if (perTrialMs > 0 && fixedMs >= 0) return { pace: { fixedMs, perTrialMs }, measured: true };
  }
  return {
    pace: { fixedMs: 0, perTrialMs: latest.count === 0 ? 0 : latest.ms / latest.count },
    measured: true,
  };
}

/** 実測を覚えるときの鍵。所要時間が変わる条件だけを混ぜる。 */
export function paceKey(useField: boolean): string {
  return useField ? 'single:field' : 'single:solo';
}

export function multiPaceKey(gateCount: number): string {
  return `multi:${gateCount}`;
}

/** コース横断は 1 本あたりで覚える。本数は条件で変わるので鍵に混ぜない。 */
export function crossPaceKey(useField: boolean): string {
  return useField ? 'cross:field' : 'cross:solo';
}

/**
 * 近似の感度分析の実測を覚えるときの鍵。
 *
 * 単騎の実行と同じ計算を走らせるので 1 試行あたりの費用は近いが、
 * 構成を何度も切り替えるぶん固定の費用の入り方が違う。実測が混ざらないように鍵を分ける。
 */
export function sensitivityPaceKey(useField: boolean, axis: SensitivityAxis = 'rate'): string {
  return `sensitivity:${axis}:${useField ? 'field' : 'solo'}`;
}

export interface Estimate {
  readonly ms: number;
  /** 直前の実測に基づくか。false なら作り付けの目安である。 */
  readonly measured: boolean;
}

function estimateWith(
  pace: Readonly<Record<string, readonly PaceSample[]>>,
  key: string,
  fallback: Pace,
  count: number,
): Estimate {
  const { pace: fitted, measured } = paceOf(pace[key] ?? [], fallback);
  return { ms: fitted.fixedMs + fitted.perTrialMs * count, measured };
}

/** 単騎の実行にかかる時間。 */
export function estimateRun(state: {
  pace: Record<string, readonly PaceSample[]>;
  useField: boolean;
  count: number;
}): Estimate {
  return estimateWith(
    state.pace,
    paceKey(state.useField),
    state.useField ? FALLBACK_PACE.field : FALLBACK_PACE.solo,
    state.count,
  );
}

/** 全頭同時の実行にかかる時間。 */
export function estimateMulti(state: {
  pace: Record<string, readonly PaceSample[]>;
  track: TrackRef;
  multiTrials: number;
}): Estimate {
  return estimateWith(
    state.pace,
    multiPaceKey(state.track.gateCount),
    {
      fixedMs: FALLBACK_PACE.multi.fixedMs,
      perTrialMs: FALLBACK_PACE.multi.perTrialMsPerHorse * state.track.gateCount,
    },
    state.multiTrials,
  );
}

/**
 * コース横断の実行にかかる時間。
 *
 * 本数を掛けるので、単騎の何十倍にもなる。押す前にこれが出ていないと、
 * 数分かかる条件を作ってから初めて気付くことになる。
 */
export function estimateCross(state: {
  pace: Record<string, readonly PaceSample[]>;
  useField: boolean;
  count: number;
  courses: number;
}): Estimate {
  const one = estimateWith(
    state.pace,
    crossPaceKey(state.useField),
    state.useField ? FALLBACK_PACE.cross.field : FALLBACK_PACE.cross.solo,
    state.count,
  );
  return { ms: one.ms * state.courses, measured: one.measured };
}

/** バ場ごとの距離の一覧。選択欄を作るのに使う。 */
export function distancesOf(surface: number): number[] {
  return courseDistances(gameData.trackData, surface);
}

/**
 * 近似の感度分析にかかる時間。
 *
 * 走るのは「振る値の数 × (1 + 候補の数)」構成ぶんで、1 構成が指定した試行数である。
 * 軸（倍率 / 近くの距離）で 1 レースの重さが変わるので、実測の鍵も軸ごとに分ける。
 * 相手の強さの幅（3 回）と違って桁で重いので、押す前に見込みを出す。
 * 実測が無いあいだは単騎の実行の目安を試行の総数ぶんに伸ばして使う。
 */
export function estimateSensitivity(state: {
  pace: Record<string, readonly PaceSample[]>;
  useField: boolean;
  sensitivityAxis?: SensitivityAxis;
  sensitivityTrials: number;
  candidateCount: number;
}): Estimate & { readonly totalTrials: number } {
  const axis = state.sensitivityAxis ?? 'rate';
  const scales = sensitivityScales(axis).length;
  const totalTrials = scales * (1 + state.candidateCount) * state.sensitivityTrials;
  const estimate = estimateWith(
    state.pace,
    sensitivityPaceKey(state.useField, axis),
    state.useField ? FALLBACK_PACE.field : FALLBACK_PACE.solo,
    totalTrials,
  );
  return { ...estimate, totalTrials };
}

function buildSetting(state: AppState): RaceSetting {
  return {
    uma: state.uma,
    track: state.track,
    skills: state.skillIds.map((id) => gameData.skillsById.get(id)!),
    skillActivateAdjustment: state.options.skillActivateAdjustment,
    randomPosition: state.options.randomPosition,
    debuffCounts: state.debuffCounts,
    positionKeepMode: state.options.positionKeepMode,
    positionKeepRate: state.options.positionKeepRate,
  };
}

/** 詳細表示は UI スレッドで走らせるので、束もこちら側で作って使い回す。 */
let detailFieldKey = '';
let detailField: ReturnType<typeof buildFieldBundle> | null = null;
function getDetailField(state: AppState) {
  const spec = fieldSpec(state);
  if (spec === null) return null;
  // 相手を自分と同格にするときは束が自分のステータスに依るので、鍵に混ぜる。
  const key = JSON.stringify([spec, spec.profile.matchSelf ? state.uma : null]);
  if (key !== detailFieldKey) {
    detailField = buildFieldBundle(spec.profile, spec.track, system, gameData.trackData, {
      samples: spec.samples,
      seed: spec.seed,
      self: state.uma,
      skillPool: opponentSkillPool(gameData.skillsById),
    });
    detailFieldKey = key;
  }
  return detailField;
}

/**
 * スキルごとの再現度（近似の印）。
 *
 * 分類はレースを回さなくても条件式から決まるので、結果にも Worker 境界にも
 * 載せず、ここで解く。相手の強さの幅（`runBand`）と違って走らせる必要が無い。
 * docs/roadmap.md 4.3 節を参照。
 *
 * 呼ぶ側は `useMemo` で包むこと。毎回新しい Map が返るので、
 * `useStore` のセレクタの中で呼ぶと描画が止まる。
 */
export function skillFidelities(
  state: {
    uma: UmaStatus;
    track: TrackRef;
    skillIds: readonly string[];
    options: RunOptions;
    debuffCounts: Readonly<Record<string, number>>;
    useField: boolean;
  },
  skillIds: readonly string[],
): Map<string, SkillFidelity> {
  const derived = new DerivedSetting(
    { ...buildSetting(state as AppState), skills: [] },
    emptyPassiveBonus(),
    gameData.trackData,
  );
  const skills = skillIds
    .map((id) => gameData.skillsById.get(id))
    .filter((skill): skill is NonNullable<typeof skill> => skill !== undefined);
  return classifySkills(skills, derived, { hasField: state.useField });
}

/**
 * 適性ややる気の補正を当てたあとのステータス。
 *
 * 入力した値がそのまま使われるわけではないので、入力欄の下に出す。
 * 計算は本体と同じ `DerivedSetting` に任せる。ここで作り直すと、
 * 本体の式が変わったときに黙ってずれる。
 */
export function modifiedStatus(state: {
  uma: UmaStatus;
  track: TrackRef;
  skillIds: readonly string[];
  options: RunOptions;
  debuffCounts: Readonly<Record<string, number>>;
}): Record<'speed' | 'stamina' | 'power' | 'guts' | 'wisdom', number> {
  const derived = new DerivedSetting(
    buildSetting(state as AppState),
    emptyPassiveBonus(),
    gameData.trackData,
  );
  return {
    speed: derived.modifiedSpeed,
    stamina: derived.modifiedStamina,
    power: derived.modifiedPower,
    guts: derived.modifiedGuts,
    wisdom: derived.modifiedWisdom,
  };
}

export function currentTrackDetail(track: TrackRef) {
  return gameData.trackData[track.location]?.courses[track.course];
}

/**
 * 読み込みが終わるまでは書かない。既定値で上書きしてしまうためである。
 */
let hydrated = false;

function settingsOf(state: AppState): PersistedSettings {
  return {
    uma: state.uma,
    track: state.track,
    skillIds: state.skillIds,
    count: state.count,
    seed: state.seed,
    options: state.options,
    debuffCounts: state.debuffCounts,
    hintLevels: state.hintLevels,
    useField: state.useField,
    field: state.field,
    plan: state.plan,
    searchEndpoint: state.searchEndpoint,
    searchTarget: state.searchTarget,
    cross: state.cross,
  };
}

const SETTING_KEYS = [
  'uma',
  'track',
  'skillIds',
  'count',
  'seed',
  'options',
  'debuffCounts',
  'hintLevels',
  'useField',
  'field',
  'plan',
  'searchEndpoint',
  'searchTarget',
  'cross',
] as const;

useStore.subscribe((state, previous) => {
  if (!hydrated) return;
  if (SETTING_KEYS.some((key) => state[key] !== previous[key])) {
    saveSettings(settingsOf(state));
  }
  if (state.snapshots !== previous.snapshots) saveSnapshots(state.snapshots);
});

/**
 * 面が変わったらハッシュに書く。
 *
 * 実行すると自動で結果の面に移るので、タブを押した経路だけを拾っても足りない。
 * 状態の変化を見れば、どこから移っても履歴に残る。
 *
 * ハッシュが既にその面を指しているときは何もしない。戻る・進むで面を合わせた
 * 直後にここが走っても、履歴を増やさないためである。
 */
useStore.subscribe((state, previous) => {
  if (state.tab === previous.tab) return;
  if (typeof location === 'undefined' || typeof history === 'undefined') return;
  if (readTabFromHash(location.hash) === state.tab) return;
  history.pushState(null, '', hashWithTab(location.hash, state.tab));
});
