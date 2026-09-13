import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { nodeWorkerFactory } from '../src/parallel/node.ts';
import { WorkerPool } from '../src/parallel/pool.ts';
import { toSerializable } from '../src/parallel/protocol.ts';
import { buildFieldBundle, defaultFieldProfile } from '../src/field/field.ts';
import { opponentSkillPool } from '../src/field/opponent-skills.ts';
import { defaultSystemSetting, type RaceSetting } from '../src/setting.ts';
import {
  achievementCurve,
  criticalDistribution,
  criticalDistributionByAdjustmentCount,
  pickAdjustmentCount,
  requiredValue,
  resolveMethod,
} from '../../solver/src/critical.ts';
import { ADJUSTMENT_COUNT_BUCKETS } from '../src/state.ts';

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

  it('位置取り調整の回数ごとの最小値は、全体の最小値以上になる', () => {
    const dist = criticalDistributionByAdjustmentCount(
      setting,
      system,
      data.trackData,
      { status: 'stamina', goal: { kind: 'finish' }, ...range },
      13,
      0,
      100,
    );
    const overall = criticalDistribution(
      setting,
      system,
      data.trackData,
      { status: 'stamina', goal: { kind: 'finish' }, method: 'scan', ...range },
      13,
      0,
      100,
    );
    for (let bucket = 0; bucket < ADJUSTMENT_COUNT_BUCKETS; bucket++) {
      const values = pickAdjustmentCount(dist.values, bucket);
      for (let i = 0; i < values.length; i++) {
        if (Number.isNaN(values[i])) continue;
        expect(values[i]!).toBeGreaterThanOrEqual(overall.values[i]!);
      }
    }
  });

  it('Worker で求めた回数ごとの最小値も単一スレッドと一致する', async () => {
    const options = { status: 'stamina', goal: { kind: 'finish' }, ...range } as const;
    const expected = criticalDistributionByAdjustmentCount(setting, system, data.trackData, options, 9, 0, 48);
    const pool = new WorkerPool(nodeWorkerFactory, 3);
    try {
      const actual = await pool.runCritical(
        toSerializable(setting),
        system,
        {
          status: 'stamina',
          goalKind: 'finish',
          from: range.from,
          to: range.to,
          step: range.step,
          method: 'scan',
          byAdjustmentCount: true,
        },
        { count: 48, seed: 9, chunkSize: 16 },
      );
      expect([...actual.byCount!]).toEqual([...expected.values]);
    } finally {
      await pool.dispose();
    }
  });
});

/**
 * 順位条件を判定する逆算。
 *
 * 判定しないと順位条件は満たしている前提になり、スキルが余分に発動して速くなる。
 * そのぶん必要量が小さく出る。足りない側に外れるので、結果や探索と同じ相手で測る。
 */
describe('逆算とフィールド', () => {
  const track = { location: 10009, course: 10909, condition: 1, gateCount: 9 } as const;
  /** 順位条件を持つ回復スキルだけを積む。判定の有無で差が出る構成である。 */
  const names = ['天衣無縫', '昂る鼓動', '十全十美', '烈火の如く', '英姿颯爽', '曙光'];
  const withOrderSkills: RaceSetting = {
    ...setting,
    uma: { ...setting.uma, speed: 1150, power: 900, guts: 700, wisdom: 900, style: 'SASI' },
    track,
    skills: names.map((name) => data.skillsByName.get(name)![0]!),
  };
  const field = buildFieldBundle(defaultFieldProfile(9), track, system, data.trackData, {
    samples: 16,
    seed: 9001,
    self: withOrderSkills.uma,
    skillPool: opponentSkillPool(data.skillsById),
    skillsById: data.skillsById,
  });
  const options = {
    status: 'stamina',
    goal: { kind: 'maxSpurt' },
    from: 600,
    to: 1400,
    step: 50,
    method: 'scan',
  } as const;

  it('判定すると必要量が上がる', () => {
    const off = criticalDistribution(withOrderSkills, system, data.trackData, options, 7, 0, 40);
    const on = criticalDistribution(
      withOrderSkills,
      system,
      data.trackData,
      { ...options, field },
      7,
      0,
      40,
    );
    const required = (dist: ReturnType<typeof criticalDistribution>) => requiredValue(dist.values, 0.5);
    // 素通りさせると必要量が小さく出る。向きが逆になったらこの検査が落ちる。
    expect(required(on)).toBeGreaterThan(required(off));
  });

  it('同じ束なら同じ答えを返す', () => {
    const once = criticalDistribution(withOrderSkills, system, data.trackData, { ...options, field }, 7, 0, 24);
    const twice = criticalDistribution(withOrderSkills, system, data.trackData, { ...options, field }, 7, 0, 24);
    expect([...twice.values]).toEqual([...once.values]);
  });

  it('Worker で求めても単一スレッドと一致する', async () => {
    // Worker 側は指定から束を組み直す。単一スレッド側と同じ束になっていないと合わない。
    const spec = { profile: defaultFieldProfile(9), track, seed: 9001, samples: 16 } as const;
    const expected = criticalDistribution(
      withOrderSkills,
      system,
      data.trackData,
      { ...options, field },
      5,
      0,
      24,
    );
    const pool = new WorkerPool(nodeWorkerFactory, 3);
    try {
      const actual = await pool.runCritical(
        toSerializable(withOrderSkills),
        system,
        {
          status: 'stamina',
          goalKind: 'maxSpurt',
          from: options.from,
          to: options.to,
          step: options.step,
          method: 'scan',
        },
        { count: 24, seed: 5, chunkSize: 8, field: spec },
      );
      expect([...actual.values]).toEqual([...expected.values]);
    } finally {
      await pool.dispose();
    }
  });
});
