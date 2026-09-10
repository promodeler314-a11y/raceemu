import { create } from 'zustand';
import { browserWorkerFactory } from '../../../packages/sim/src/parallel/browser.ts';
import { SimulationCancelled, WorkerPool } from '../../../packages/sim/src/parallel/pool.ts';
import { toSerializable, toSkillSummaries, type SkillSummary } from '../../../packages/sim/src/parallel/protocol.ts';
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
import { resolveMethod } from '../../../packages/solver/src/critical.ts';
import { createCostModel } from '../../../packages/solver/src/cost.ts';
import { optimizeSkills, type OptimizeResult } from '../../../packages/solver/src/optimize.ts';
import type { Goal, TargetStatus } from '../../../packages/solver/src/target.ts';
import { decodeShareState, encodeShareState } from './share.ts';
import { debounceSave, isPersistenceAvailable, loadPersisted } from './persist.ts';
import { resolveSkillIds, type Preset } from './presets.ts';
import { gameData, skillChoices, skillIndex, NO_CHARA } from './skills.ts';
import type { RaceFrame, RaceSimulationResult, RaceState } from '../../../packages/sim/src/state.ts';

export { gameData, skillChoices };
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
}

/** ヘッダのタブ。共有 URL には載せない（見ている面は設定の一部ではない）。 */
export type Tab = 'settings' | 'summary' | 'compare' | 'detail' | 'solve';

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
  inverseResult: InverseResult | null;
  /** 順位条件を実際に判定するか。false なら本家と同じく満たしている前提。 */
  useField: boolean;
  options: RunOptions;
  /** デバフの種類ごとの個数。0 の項目は持たない。 */
  debuffCounts: Record<string, number>;
  /** スキル ID からヒントレベル（0 から 5）。0 の項目は持たない。 */
  hintLevels: Record<string, number>;

  optimizeBudget: number;
  optimizeResult: OptimizeResult | null;
  optimizeLog: string[];
  optimizeRunning: boolean;

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
  setCount: (count: number) => void;
  setUseField: (useField: boolean) => void;
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
  setInverse: (patch: { status?: TargetStatus; goal?: Goal; count?: number }) => void;
  solveInverse: () => Promise<void>;
  saveSnapshot: () => void;
  removeSnapshot: (id: number) => void;
  restoreSnapshot: (id: number) => void;
  setOptimizeBudget: (budget: number) => void;
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
  track: { location: 10006, course: 10606, condition: 1, gateCount: 9 },
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
  inverseResult: null,
  useField: false,
  options: defaultRunOptions(),
  debuffCounts: {},
  hintLevels: {},

  optimizeBudget: 600,
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
  setCount: (count) => set({ count }),
  setUseField: (useField) => set({ useField }),
  setSeed: (seed) => set({ seed }),
  setOptimizeBudget: (optimizeBudget) => set({ optimizeBudget }),
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
    set({ running: true, progress: 0, error: null, detail: null, skillSummaries: [] });
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
    const method = resolveMethod({ status: state.inverseStatus, goal, from, to, step });
    try {
      const { values, races } = await getPool().runCritical(
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
    const state = get();
    if (state.running || state.optimizeRunning) return;
    if (state.skillIds.length < 2) {
      set({ error: '候補にするスキルを 2 つ以上選ぶ' });
      return;
    }
    controller = new AbortController();
    set({ optimizeRunning: true, error: null, optimizeResult: null, optimizeLog: [] });
    try {
      const result = await optimizeSkills(
        {
          pool: getPool(),
          system,
          base: toSerializable({ ...buildSetting(state), skills: [] }),
          cost: costModelFor(state.hintLevels),
          seed: state.seed,
          field: fieldSpec(state),
        },
        {
          candidates: [...state.skillIds],
          budget: state.optimizeBudget,
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
    });
    return true;
  },
}));

/** 順位条件を判定するときの相手の想定。頭数は 9 と 12 だけを扱う。 */
function fieldSpec(state: AppState) {
  if (!state.useField) return null;
  return {
    profile: defaultFieldProfile(state.track.gateCount),
    track: state.track,
    seed: 9001,
    samples: 64,
  };
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
  const key = JSON.stringify(spec);
  if (key !== detailFieldKey) {
    detailField = buildFieldBundle(spec.profile, spec.track, system, gameData.trackData, {
      samples: spec.samples,
      seed: spec.seed,
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
] as const;

useStore.subscribe((state, previous) => {
  if (!hydrated) return;
  if (SETTING_KEYS.some((key) => state[key] !== previous[key])) {
    saveSettings(settingsOf(state));
  }
  if (state.snapshots !== previous.snapshots) saveSnapshots(state.snapshots);
});
