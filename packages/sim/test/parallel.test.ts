import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { RaceCalculator } from '../src/calculator.ts';
import { nodeWorkerFactory } from '../src/parallel/node.ts';
import { SimulationCancelled, WorkerPool } from '../src/parallel/pool.ts';
import { toSerializable } from '../src/parallel/protocol.ts';
import { defaultSystemSetting, type RaceSetting } from '../src/setting.ts';

const data = loadGameData();
const system = defaultSystemSetting();

const setting: RaceSetting = {
  uma: {
    charaName: 'T',
    speed: 1400,
    stamina: 800,
    power: 1100,
    guts: 700,
    wisdom: 1000,
    condition: 'BEST',
    style: 'NIGE',
    distanceFit: 'A',
    surfaceFit: 'A',
    styleFit: 'A',
    popularity: 1,
    gateNumber: 3,
    uniqueLevel: 6,
  },
  track: { location: 10001, course: 10101, condition: 1, gateCount: 9 },
  skills: [
    data.skillsByName.get('弧線のプロフェッサー')![0]!,
    data.skillsByName.get('円弧のマエストロ')![0]!,
  ],
  skillActivateAdjustment: 'NONE',
  randomPosition: 'RANDOM',
  debuffCounts: {},
  positionKeepMode: 'APPROXIMATE',
  positionKeepRate: 100,
};

const serializable = toSerializable(setting);

function runSingle(count: number, seed: number): number[] {
  const calculator = new RaceCalculator(system, data.trackData);
  const times: number[] = [];
  for (let trial = 0; trial < count; trial++) {
    times.push(calculator.simulate(setting, { seed, trial }).result.raceTime);
  }
  return times;
}

describe('並列実行', () => {
  it('並列で走らせても単一スレッドと1件ずつ完全に一致する', async () => {
    const count = 400;
    const seed = 12345;
    const expected = runSingle(count, seed);
    const pool = new WorkerPool(nodeWorkerFactory, 3);
    try {
      const results = await pool.run(serializable, system, { count, seed, chunkSize: 64 });
      expect(results.map((r) => r.raceTime)).toEqual(expected);
    } finally {
      await pool.dispose();
    }
  });

  it('塊の大きさを変えても結果が変わらない', async () => {
    const count = 300;
    const seed = 777;
    const pool = new WorkerPool(nodeWorkerFactory, 2);
    try {
      const a = await pool.run(serializable, system, { count, seed, chunkSize: 16 });
      const b = await pool.run(serializable, system, { count, seed, chunkSize: 256 });
      expect(a.map((r) => r.raceTime)).toEqual(b.map((r) => r.raceTime));
    } finally {
      await pool.dispose();
    }
  });

  it('プールを使い回しても結果が変わらない', async () => {
    const pool = new WorkerPool(nodeWorkerFactory, 2);
    try {
      const a = await pool.run(serializable, system, { count: 120, seed: 5, chunkSize: 32 });
      await pool.run(serializable, system, { count: 50, seed: 99 });
      const b = await pool.run(serializable, system, { count: 120, seed: 5, chunkSize: 32 });
      expect(a.map((r) => r.goalSp)).toEqual(b.map((r) => r.goalSp));
    } finally {
      await pool.dispose();
    }
  });

  it('進捗が合計と一致する', async () => {
    const count = 200;
    const seen: number[] = [];
    const pool = new WorkerPool(nodeWorkerFactory, 2);
    try {
      await pool.run(serializable, system, {
        count,
        seed: 1,
        chunkSize: 50,
        onProgress: (done, total) => {
          expect(total).toBe(count);
          seen.push(done);
        },
      });
      expect(seen[seen.length - 1]).toBe(count);
      expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    } finally {
      await pool.dispose();
    }
  });

  it('中断できる', async () => {
    const controller = new AbortController();
    const pool = new WorkerPool(nodeWorkerFactory, 2);
    try {
      const promise = pool.run(serializable, system, {
        count: 100000,
        seed: 1,
        chunkSize: 32,
        onProgress: () => controller.abort(),
        signal: controller.signal,
      });
      await expect(promise).rejects.toBeInstanceOf(SimulationCancelled);
    } finally {
      await pool.dispose();
    }
  });
});
