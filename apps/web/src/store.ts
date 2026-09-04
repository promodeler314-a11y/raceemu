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
import { decodeShareState, encodeShareState } from './share.ts';
import type { RaceFrame, RaceSimulationResult, RaceState } from '../../../packages/sim/src/state.ts';

export const gameData = loadGameData();
const system = defaultSystemSetting();

/** 名前ごとに 1 つだけ持つスキル一覧。UI の選択肢に使う。 */
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

  setUma: (patch: Partial<UmaStatus>) => void;
  setTrack: (patch: Partial<TrackRef>) => void;
  toggleSkill: (id: string) => void;
  clearSkills: () => void;
  setCount: (count: number) => void;
  setSeed: (seed: number) => void;
  run: () => Promise<void>;
  cancel: () => void;
  showTrial: (trial: number) => void;
  saveSnapshot: () => void;
  removeSnapshot: (id: number) => void;
  restoreSnapshot: (id: number) => void;
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

  setUma: (patch) => set((s) => ({ uma: { ...s.uma, ...patch } })),
  setTrack: (patch) => set((s) => ({ track: { ...s.track, ...patch } })),
  toggleSkill: (id) =>
    set((s) => ({
      skillIds: s.skillIds.includes(id) ? s.skillIds.filter((x) => x !== id) : [...s.skillIds, id],
    })),
  clearSkills: () => set({ skillIds: [] }),
  setCount: (count) => set({ count }),
  setSeed: (seed) => set({ seed }),

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
    });
    set({ detail: { trial, frames: raceState.simulation.frames, state: raceState } });
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

export function currentTrackDetail(track: TrackRef) {
  return gameData.trackData[track.location]?.courses[track.course];
}
