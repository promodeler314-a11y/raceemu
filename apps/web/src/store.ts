import { create } from 'zustand';
import { loadGameData } from '../../../packages/data/src/browser.ts';
import { browserWorkerFactory } from '../../../packages/sim/src/parallel/browser.ts';
import { SimulationCancelled, WorkerPool } from '../../../packages/sim/src/parallel/pool.ts';
import { toSerializable, toSkillSummaries, type SkillSummary } from '../../../packages/sim/src/parallel/protocol.ts';
import { RaceCalculator } from '../../../packages/sim/src/calculator.ts';
import {
  defaultSystemSetting,
  type RaceSetting,
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
import type { RaceFrame, RaceSimulationResult, RaceState } from '../../../packages/sim/src/state.ts';

export const gameData = loadGameData();
const system = defaultSystemSetting();

/** 名前ごとに 1 つだけ持つスキル一覧。UI の選択肢に使う。 */
/** スキルポイントの費用。ヒントによる割引は今のところ扱わない。 */
export const costModel = createCostModel(gameData.skillsById);

export const skillChoices = [...gameData.skillsByName.entries()]
  .map(([name, list]) => ({ name, skill: list[0]! }))
  .sort((a, b) => a.name.localeCompare(b.name, 'ja'));

let pool: WorkerPool | null = null;
function getPool(): WorkerPool {
  if (pool === null) pool = new WorkerPool(browserWorkerFactory);
  return pool;
}

export interface Snapshot {
  readonly id: number;
  readonly label: string;
  readonly uma: UmaStatus;
  readonly track: TrackRef;
  readonly skillIds: readonly string[];
  readonly summary: SimulationSummary;
  readonly skillSummaries: readonly SkillSummary[];
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

  optimizeBudget: number;
  optimizeResult: OptimizeResult | null;
  optimizeLog: string[];
  optimizeRunning: boolean;

  setUma: (patch: Partial<UmaStatus>) => void;
  setTrack: (patch: Partial<TrackRef>) => void;
  toggleSkill: (id: string) => void;
  clearSkills: () => void;
  setCount: (count: number) => void;
  setUseField: (useField: boolean) => void;
  setSeed: (seed: number) => void;
  run: () => Promise<void>;
  cancel: () => void;
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
}

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
  summary: null,
  results: [],
  skillSummaries: [],
  detail: null,
  snapshots: [],
  inverseStatus: 'stamina',
  inverseGoal: { kind: 'maxSpurt' },
  inverseCount: 500,
  inverseResult: null,
  useField: false,

  optimizeBudget: 600,
  optimizeResult: null,
  optimizeLog: [],
  optimizeRunning: false,

  setUma: (patch) => set((s) => ({ uma: { ...s.uma, ...patch } })),
  setTrack: (patch) => set((s) => ({ track: { ...s.track, ...patch } })),
  toggleSkill: (id) =>
    set((s) => ({
      skillIds: s.skillIds.includes(id) ? s.skillIds.filter((x) => x !== id) : [...s.skillIds, id],
    })),
  clearSkills: () => set({ skillIds: [] }),
  setCount: (count) => set({ count }),
  setUseField: (useField) => set({ useField }),
  setSeed: (seed) => set({ seed }),
  setOptimizeBudget: (optimizeBudget) => set({ optimizeBudget }),

  run: async () => {
    const state = get();
    if (state.running) return;
    controller = new AbortController();
    set({ running: true, progress: 0, error: null, detail: null, skillSummaries: [] });
    const started = performance.now();
    try {
      const setting = buildSetting(state);
      const serializable = toSerializable(setting);
      const { results, skillStats } = await getPool().run(serializable, system, {
        count: state.count,
        seed: state.seed,
        onProgress: (done) => set({ progress: done }),
        signal: controller.signal,
        field: fieldSpec(state),
      });
      const elapsedMs = performance.now() - started;
      set({
        summary: summarize(results, elapsedMs),
        results,
        elapsedMs,
        skillSummaries: toSkillSummaries(serializable.skillIds, skillStats, results.length),
      });
      get().showTrial(0);
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
    const label = `#${id} ${track?.name ?? ''} ${state.uma.speed}/${state.uma.stamina}/${state.uma.power}/${state.uma.guts}/${state.uma.wisdom}`;
    set({
      snapshots: [
        {
          id,
          label,
          uma: state.uma,
          track: state.track,
          skillIds: [...state.skillIds],
          summary: state.summary,
          skillSummaries: state.skillSummaries,
        },
        ...state.snapshots,
      ],
    });
  },

  removeSnapshot: (id) => set((s) => ({ snapshots: s.snapshots.filter((x) => x.id !== id) })),

  restoreSnapshot: (id) => {
    const snapshot = get().snapshots.find((x) => x.id === id);
    if (snapshot === undefined) return;
    set({ uma: snapshot.uma, track: snapshot.track, skillIds: [...snapshot.skillIds] });
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
          cost: costModel,
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
    });
    return `${location.origin}${location.pathname}#s=${encoded}`;
  },

  applyShared: () => {
    const match = /[#&]s=([^&]+)/.exec(location.hash);
    if (match === null) return false;
    const shared = decodeShareState(match[1]!);
    if (shared === null) return false;
    set({
      uma: shared.uma,
      track: shared.track,
      skillIds: [...shared.skillIds],
      count: shared.count,
      seed: shared.seed,
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
    skillActivateAdjustment: 'NONE',
    randomPosition: 'RANDOM',
    debuffCounts: {},
    positionKeepMode: 'APPROXIMATE',
    positionKeepRate: 100,
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

export function currentTrackDetail(track: TrackRef) {
  return gameData.trackData[track.location]?.courses[track.course];
}
