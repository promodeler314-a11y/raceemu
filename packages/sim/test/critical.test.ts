import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { nodeWorkerFactory } from '../src/parallel/node.ts';
import { WorkerPool } from '../src/parallel/pool.ts';
import { toSerializable } from '../src/parallel/protocol.ts';
import { defaultSystemSetting, type RaceSetting } from '../src/setting.ts';
import {
  achievementCurve,
  criticalDistribution,
  requiredValue,
  resolveMethod,
} from '../../solver/src/critical.ts';

const data = loadGameData();
const system = defaultSystemSetting();

const setting: RaceSetting = {
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
    gateNumber: 5,
    uniqueLevel: 6,
  },
  track: { location: 10006, course: 10606, condition: 1, gateCount: 9 },
  skills: [],
  skillActivateAdjustment: 'NONE',
  randomPosition: 'RANDOM',
  debuffCounts: {},
  positionKeepMode: 'APPROXIMATE',
  positionKeepRate: 100,
};

const range = { from: 200, to: 1600, step: 10 } as const;

describe('逆算', () => {
  it('目標に応じて探し方が決まる', () => {
    expect(resolveMethod({ status: 'stamina', goal: { kind: 'maxSpurt' }, ...range })).toBe('bisect');
    expect(resolveMethod({ status: 'stamina', goal: { kind: 'finish' }, ...range })).toBe('scan');
    expect(
      resolveMethod({ status: 'stamina', goal: { kind: 'maxSpurt' }, method: 'scan', ...range }),
    ).toBe('scan');
  });

  it('最大スパートでは二分探索と全走査が一致する', () => {
    const options = { status: 'stamina', goal: { kind: 'maxSpurt' }, ...range } as const;
    const bisect = criticalDistribution(setting, system, data.trackData, options, 7, 0, 60);
    const scan = criticalDistribution(
      setting,
      system,
      data.trackData,
      { ...options, method: 'scan' },
      7,
      0,
      60,
    );
    expect([...bisect.values]).toEqual([...scan.values]);
    // 二分探索のほうが走らせるレースが少ない。
    // 全走査は達成した時点で止まるので、探索範囲の全点を走るわけではない。
    // この設定では 1 試行あたり 12 本と 60 本ほどになる。
    expect(bisect.races).toBeLessThan(scan.races / 3);
  });

  it('達成率が上がるほど必要な値も上がる', () => {
    const dist = criticalDistribution(
      setting,
      system,
      data.trackData,
      { status: 'stamina', goal: { kind: 'maxSpurt' }, ...range },
      11,
      0,
      200,
    );
    const curve = achievementCurve(dist.values);
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!.value).toBeGreaterThanOrEqual(curve[i - 1]!.value);
    }
    expect(requiredValue(dist.values, 0.5)).toBeGreaterThan(range.from);
    expect(requiredValue(dist.values, 0.99)).toBeLessThan(range.to);
  });

  it('Worker で求めても単一スレッドと一致する', async () => {
    const options = { status: 'stamina', goal: { kind: 'maxSpurt' }, ...range } as const;
    const expected = criticalDistribution(setting, system, data.trackData, options, 5, 0, 96);
    const pool = new WorkerPool(nodeWorkerFactory, 3);
    try {
      const actual = await pool.runCritical(
        toSerializable(setting),
        system,
        {
          status: 'stamina',
          goalKind: 'maxSpurt',
          from: range.from,
          to: range.to,
          step: range.step,
          method: 'bisect',
        },
        { count: 96, seed: 5, chunkSize: 16 },
      );
      expect([...actual.values]).toEqual([...expected.values]);
    } finally {
      await pool.dispose();
    }
  });
});
