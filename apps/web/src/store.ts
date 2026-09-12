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
import { summarize, type SimulationSummary } from '../../../packages/sim/src/summary.ts';
import { buildFieldBundle, defaultFieldProfile } from '../../../packages/sim/src/field/field.ts';
import { opponentSkillPool } from '../../../packages/sim/src/field/opponent-skills.ts';
import { OrderTally, type OrderSummary } from '../../../packages/sim/src/multi/summary.ts';
import type { Style } from '../../../packages/sim/src/data/constants.ts';
import { resolveMethod } from '../../../packages/solver/src/critical.ts';
import { createCostModel } from '../../../packages/solver/src/cost.ts';
import { optimizeSkills, type OptimizeResult } from '../../../packages/solver/src/optimize.ts';
import {
  buildPlanCandidates,
  type PlanCandidates,
} from '../../../packages/solver/src/candidates.ts';
import type { DeckData } from '../../../packages/data/src/deck.ts';
import type { Goal, TargetStatus } from '../../../packages/solver/src/target.ts';
import { decodeShareState, encodeShareState } from './share.ts';
import type { Individual } from './individualsApi.ts';
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
  readonly plan?: PlanSetting;
}

/**
 * 育成計画の入力。
 *
 * 候補をいま選んでいるスキルからではなく入手経路から作るときに使う。
 * docs/solver-design.md 7 節を参照。共有 URL には載せない。
 */
export interface PlanSetting {
  readonly enabled: boolean;
  readonly charaId: number | null;
  readonly charaRank: number;
  readonly cardIds: readonly number[];
  readonly openWhites: boolean;
  readonly openInheritedUniques: boolean;
  /** 無視している条件しか持たないスキルを候補に入れるか */
  readonly includeIgnoredOnly: boolean;
}

export const DEFAULT_PLAN: PlanSetting = {
  enabled: false,
  charaId: null,
  charaRank: 5,
  cardIds: [],
  openWhites: true,
  openInheritedUniques: true,
  includeIgnoredOnly: false,
};

/** ヘッダのタブ。共有 URL には載せない（見ている面は設定の一部ではない）。 */
export type Tab = 'settings' | 'summary' | 'compare' | 'detail' | 'solve' | 'field';

/** 相手 1 頭ぶんの設定 */
export interface Opponent {
  readonly id: number;
  readonly uma: UmaStatus;
  readonly skillIds: readonly string[];
}

/** 全頭同時に走らせた結果 */
export interface MultiResult {
  /** 出走順ごとの着順の集計。0 番が自分。 */
  readonly summaries: readonly OrderSummary[];
  readonly trials: number;
  readonly elapsedMs: number;
  readonly cancelled: boolean;
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
   * 1 試行あたりの所要時間の実測。条件ごとに持つ（`paceKey` が鍵を作る）。
   * 単位はミリ秒で、並列で走らせた実時間をそのまま試行数で割ったものである。
   */
  pace: Record<string, number>;
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

  optimizeBudget: number;
  optimizeResult: OptimizeResult | null;
  optimizeLog: string[];
  optimizeRunning: boolean;
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
  setOptimizeBudget: (budget: number) => void;
  setPlan: (patch: Partial<PlanSetting>) => void;
  /** サポートカードと育成ウマ娘を読み込む。すでに読んであれば何もしない。 */
  loadDeck: () => Promise<void>;
  togglePlanCard: (id: number) => void;
  runOptimize: () => Promise<void>;
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
  if (state.deck === null) return null;
  const derived = new DerivedSetting(
    { ...buildSetting(state), skills: [] },
    emptyPassiveBonus(),
    gameData.trackData,
  );
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
    {
      openWhites: state.plan.openWhites,
      openInheritedUniques: state.plan.openInheritedUniques,
      includeIgnoredOnly: state.plan.includeIgnoredOnly,
    },
  );
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

  optimizeBudget: 600,
  plan: DEFAULT_PLAN,
  deck: null,
  planCandidates: null,
  optimizeResult: null,
  optimizeLog: [],
  optimizeRunning: false,

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
    set({ multiRunning: true, multiProgress: 0, error: null, multiResult: null });
    const started = performance.now();
    try {
      const entries = [
        toSerializable(buildSetting(state)),
        ...opponents.map((opponent) =>
          toSerializable({
            ...buildSetting(state),
            uma: opponent.uma,
            skills: opponent.skillIds.map((id) => gameData.skillsById.get(id)!).filter(Boolean),
          }),
        ),
      ];
      const { packed, entries: width, cancelled } = await getPool().runMulti(entries, system, {
        count: state.multiTrials,
        seed: state.seed,
        onProgress: (done) => set({ multiProgress: done }),
        signal: controller.signal,
        keepPartial: true,
      });
      const tally = new OrderTally(width);
      const trials = width === 0 ? 0 : packed.length / (width * MULTI_FIELDS);
      for (let t = 0; t < trials; t++) {
        tally.add({
          entries: [...Array(width).keys()].map((index) => ({
            index,
            ...unpackMultiEntry(packed, (t * width + index) * MULTI_FIELDS),
          })),
          states: [],
          frames: 0,
        });
      }
      const multiElapsedMs = performance.now() - started;
      set({
        multiResult: {
          summaries: tally.summarizeAll(),
          trials,
          elapsedMs: multiElapsedMs,
          cancelled: cancelled === true,
        },
        pace:
          trials === 0
            ? state.pace
            : { ...state.pace, [multiPaceKey(state.track.gateCount)]: multiElapsedMs / trials },
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

  setOptimizeBudget: (optimizeBudget) => set({ optimizeBudget }),
  setPlan: (patch) => {
    set((s) => ({ plan: { ...s.plan, ...patch } }));
    if (patch.enabled === true) void get().loadDeck();
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
        // 次に押す前の見積もりに使う。中断しても終わったぶんで割れば同じ速さが出る。
        pace: { ...state.pace, [paceKey(state.useField)]: elapsedMs / results.length },
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
    if (get().plan.enabled) await get().loadDeck();
    const state = get();

    // 育成計画からのときは、候補を手持ちではなく入手経路から作る。
    // docs/solver-design.md 7 節を参照。
    const plan = state.plan.enabled ? planCandidatesOf(state) : null;
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
            : '候補が集まらない。育成ウマ娘かサポートカードを選ぶか、白と固有の継承版を開く',
      });
      return;
    }
    controller = new AbortController();
    set({
      optimizeRunning: true,
      error: null,
      optimizeResult: null,
      optimizeLog: [],
      planCandidates: plan,
    });
    try {
      const result = await optimizeSkills(
        {
          pool: getPool(),
          system,
          base: toSerializable({ ...buildSetting(state), skills: always }),
          cost: costModelFor(hintLevels),
          seed: state.seed,
          field: fieldSpec(state),
        },
        {
          candidates,
          budget: state.optimizeBudget,
          selfConsistent: state.optimizeSelfConsistent,
          signal: controller.signal,
          onProgress: (message) => set((s) => ({ optimizeLog: [...s.optimizeLog, message] })),
        },
      );
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
    return `${location.origin}${location.pathname}#s=${encoded}`;
  },

  bootstrap: async () => {
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
        plan: { ...DEFAULT_PLAN, ...settings.plan },
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
 * 見積もりは条件ごとの 1 試行あたりの実時間に回数を掛けるだけである。
 * 実測があればそれを使う。無いあいだは下の値を目安として出す。
 *
 * 目安の値は手元（Windows、24 スレッド、Worker 23 本）で測ったものである。
 *
 * | 条件 | 単一スレッド | 23 並列 |
 * | --- | ---: | ---: |
 * | 単騎・順位条件なし | 1.38 ms | 0.52 ms |
 * | 単騎・順位条件あり | 2.22 ms | 1.37 ms |
 * | 9 頭同時 | 21.3 ms | 5.63 ms |
 *
 * 並列数で割って出すことはしない。順位条件を入れると Worker ごとにフィールドの
 * 束（64 本）を組み直すため、本数を増やしても割り算ぶんには速くならない。
 * 機種差もあるので、1 回走らせて実測に置き換わるまでは外れうる。
 */
const FALLBACK_MS_PER_TRIAL = {
  solo: 0.52,
  field: 1.37,
  /** 全頭同時は頭数にほぼ比例する。9 頭 5.63 ms を 1 頭あたりに割ったもの。 */
  multiPerHorse: 5.63 / 9,
} as const;

/** 実測を覚えるときの鍵。所要時間が変わる条件だけを混ぜる。 */
export function paceKey(useField: boolean): string {
  return useField ? 'single:field' : 'single:solo';
}

export function multiPaceKey(gateCount: number): string {
  return `multi:${gateCount}`;
}

export interface Estimate {
  readonly ms: number;
  /** 直前の実測に基づくか。false なら作り付けの目安である。 */
  readonly measured: boolean;
}

function estimateWith(pace: Readonly<Record<string, number>>, key: string, fallback: number, count: number): Estimate {
  const measured = pace[key];
  if (measured !== undefined) return { ms: measured * count, measured: true };
  return { ms: fallback * count, measured: false };
}

/** 単騎の実行にかかる時間。 */
export function estimateRun(state: { pace: Record<string, number>; useField: boolean; count: number }): Estimate {
  return estimateWith(
    state.pace,
    paceKey(state.useField),
    state.useField ? FALLBACK_MS_PER_TRIAL.field : FALLBACK_MS_PER_TRIAL.solo,
    state.count,
  );
}

/** 全頭同時の実行にかかる時間。 */
export function estimateMulti(state: {
  pace: Record<string, number>;
  track: TrackRef;
  multiTrials: number;
}): Estimate {
  return estimateWith(
    state.pace,
    multiPaceKey(state.track.gateCount),
    FALLBACK_MS_PER_TRIAL.multiPerHorse * state.track.gateCount,
    state.multiTrials,
  );
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
] as const;

useStore.subscribe((state, previous) => {
  if (!hydrated) return;
  if (SETTING_KEYS.some((key) => state[key] !== previous[key])) {
    saveSettings(settingsOf(state));
  }
  if (state.snapshots !== previous.snapshots) saveSnapshots(state.snapshots);
});
