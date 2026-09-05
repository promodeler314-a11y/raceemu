import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { RaceCalculator } from '../src/calculator.ts';
import { nodeWorkerFactory } from '../src/parallel/node.ts';
import { SimulationCancelled, WorkerPool } from '../src/parallel/pool.ts';
import {
  SKILL_STAT,
  SKILL_STAT_FIELDS,
  toSerializable,
  toSkillSummaries,
} from '../src/parallel/protocol.ts';
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
      const { results } = await pool.run(serializable, system, { count, seed, chunkSize: 64 });
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
      const a = (await pool.run(serializable, system, { count, seed, chunkSize: 16 })).results;
      const b = (await pool.run(serializable, system, { count, seed, chunkSize: 256 })).results;
      expect(a.map((r) => r.raceTime)).toEqual(b.map((r) => r.raceTime));
    } finally {
      await pool.dispose();
    }
  });

  it('プールを使い回しても結果が変わらない', async () => {
    const pool = new WorkerPool(nodeWorkerFactory, 2);
    try {
      const a = (await pool.run(serializable, system, { count: 120, seed: 5, chunkSize: 32 })).results;
      await pool.run(serializable, system, { count: 50, seed: 99 });
      const b = (await pool.run(serializable, system, { count: 120, seed: 5, chunkSize: 32 })).results;
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

  it('スキルごとの集計が試行数と整合する', async () => {
    const count = 500;
    const pool = new WorkerPool(nodeWorkerFactory, 2);
    try {
      const { skillStats } = await pool.run(serializable, system, { count, seed: 3, chunkSize: 64 });
      const summaries = toSkillSummaries(serializable.skillIds, skillStats, count);
      expect(summaries).toHaveLength(2);
      for (const summary of summaries) {
        expect(summary.triggerRate).toBeGreaterThan(0);
        expect(summary.triggerRate).toBeLessThanOrEqual(1);
        expect(summary.doubleTriggerRate).toBeLessThanOrEqual(summary.triggerRate);
        const phaseSum = summary.phaseRates.reduce((a, b) => a + b, 0);
        expect(phaseSum).toBeCloseTo(1, 6);
      }
    } finally {
      await pool.dispose();
    }
  });

  it('塊の分け方でスキル集計が変わらない', async () => {
    const pool = new WorkerPool(nodeWorkerFactory, 3);
    try {
      const a = await pool.run(serializable, system, { count: 300, seed: 8, chunkSize: 16 });
      const b = await pool.run(serializable, system, { count: 300, seed: 8, chunkSize: 300 });
      // 発動回数は整数なので完全に一致する。
      // 位置の合計は加算の順序が変わるぶん最下位の桁がずれるため、相対誤差で見る。
      for (let i = 0; i < a.skillStats.length; i++) {
        const field = i % SKILL_STAT_FIELDS;
        const isCount =
          field === SKILL_STAT.triggered ||
          field === SKILL_STAT.doubleTriggered ||
          field >= SKILL_STAT.phase0;
        if (isCount) expect(a.skillStats[i]).toBe(b.skillStats[i]);
        else expect(a.skillStats[i]!).toBeCloseTo(b.skillStats[i]!, 6);
      }
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
