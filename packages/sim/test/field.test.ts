import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { RaceCalculator } from '../src/calculator.ts';
import {
  ORDER_RATE_CONTINUE_TYPES,
  orderRateBoundaries,
  resolveOrderRateContinue,
} from '../src/data/orderRate.ts';
import { buildFieldBundle, defaultFieldProfile, FieldView } from '../src/field/field.ts';
import { nodeWorkerFactory } from '../src/parallel/node.ts';
import { WorkerPool } from '../src/parallel/pool.ts';
import { toSerializable, toSkillSummaries } from '../src/parallel/protocol.ts';
import { defaultSystemSetting, type RaceSetting } from '../src/setting.ts';

const data = loadGameData();
const system = defaultSystemSetting();
const track = { location: 10006, course: 10606, condition: 1, gateCount: 9 } as const;

function setting(style: 'NIGE' | 'SEN' | 'SASI' | 'OI', skillNames: string[] = []): RaceSetting {
  return {
    uma: {
      charaName: '',
      speed: 1200,
      stamina: 1000,
      power: 900,
      guts: 600,
      wisdom: 900,
      condition: 'BEST',
      style,
      distanceFit: 'A',
      surfaceFit: 'A',
      styleFit: 'A',
      popularity: 1,
      gateNumber: 5,
      uniqueLevel: 6,
    },
    track,
    skills: skillNames.map((name) => data.skillsByName.get(name)![0]!),
    skillActivateAdjustment: 'NONE',
    randomPosition: 'RANDOM',
    debuffCounts: {},
    positionKeepMode: 'APPROXIMATE',
    positionKeepRate: 100,
  };
}

describe('順位率の対応表', () => {
  it('よく使われる条件が注記どおりに入っている', () => {
    // docs/order-condition.md 2 節の表と同じ値
    expect(orderRateBoundaries['<=:50:9']).toEqual({ atMost: 5 });
    expect(orderRateBoundaries['<=:50:12']).toEqual({ atMost: 6 });
    expect(orderRateBoundaries['>=:40:9']).toEqual({ atLeast: 4 });
    expect(orderRateBoundaries['>=:40:12']).toEqual({ atLeast: 5 });
    expect(orderRateBoundaries['>:50:9']).toEqual({ atLeast: 6 });
  });
});

describe('フィールド軌跡モデル', () => {
  const bundle = buildFieldBundle(defaultFieldProfile(9), track, system, data.trackData, {
    samples: 8,
    seed: 99,
  });

  it('相手の数が出走頭数から 1 引いた数になる', () => {
    expect(bundle.opponents).toBe(8);
    expect(bundle.samples).toHaveLength(8);
  });

  it('順位が 1 から出走頭数の範囲に収まる', () => {
    const view = new FieldView(bundle, 0);
    for (const frame of [0, 100, 500, 1000]) {
      for (const position of [0, 500, 1200, 2400]) {
        const order = view.order(frame, position);
        expect(order).toBeGreaterThanOrEqual(1);
        expect(order).toBeLessThanOrEqual(9);
      }
    }
  });

  it('前に出るほど順位が上がる', () => {
    const view = new FieldView(bundle, 3);
    const behind = view.order(600, 100);
    const ahead = view.order(600, 3000);
    expect(ahead).toBeLessThanOrEqual(behind);
    expect(ahead).toBe(1);
  });

  it('同じ試行番号なら同じフィールドを引く', () => {
    const calculator = new RaceCalculator(system, data.trackData);
    const a = calculator.simulate(setting('SEN'), { seed: 1, trial: 42, field: bundle }).result;
    const b = calculator.simulate(setting('SEN'), { seed: 1, trial: 42, field: bundle }).result;
    expect(a.raceTime).toBe(b.raceTime);
  });

  it('フィールドを渡さなければ順位条件は満たしている前提のまま', async () => {
    // 逃げに「後方寄り」条件のスキルを持たせる。
    // 順位を見なければほぼ抽選どおりに発動し、見ればほとんど発動しない。
    const withSkill = setting('NIGE', ['真骨頂']);
    const serializable = toSerializable(withSkill);
    const pool = new WorkerPool(nodeWorkerFactory, 2);
    try {
      const count = 400;
      const ignored = await pool.run(serializable, system, { count, seed: 7 });
      const judged = await pool.run(serializable, system, {
        count,
        seed: 7,
        field: { profile: defaultFieldProfile(9), track, seed: 99, samples: 8 },
      });
      const a = toSkillSummaries(serializable.skillIds, ignored.skillStats, count)[0]!;
      const b = toSkillSummaries(serializable.skillIds, judged.skillStats, count)[0]!;
      expect(a.triggerRate).toBeGreaterThan(0.8);
      expect(b.triggerRate).toBeLessThan(0.1);
    } finally {
      await pool.dispose();
    }
  });
});

describe('順位率の帯の維持', () => {
  const bundle = buildFieldBundle(defaultFieldProfile(9), track, system, data.trackData, {
    samples: 16,
    seed: 99,
  });
  const calculator = new RaceCalculator(system, data.trackData);

  const run = (style: 'NIGE' | 'OI', trial: number, withField: boolean) =>
    calculator.simulate(setting(style), {
      seed: 7,
      trial,
      field: withField ? bundle : null,
    }).state.simulation.specialState;

  it('9 頭立てと 12 頭立てのすべての帯が対応表にある', () => {
    for (const type of ORDER_RATE_CONTINUE_TYPES) {
      expect(resolveOrderRateContinue(type, 9), type).toBeDefined();
      expect(resolveOrderRateContinue(type, 12), type).toBeDefined();
    }
    // 対応表に無い頭数では引けない。その場合は満たしている前提に戻す。
    expect(resolveOrderRateContinue('order_rate_in20_continue', 18)).toBeUndefined();
  });

  it('フィールドが無ければ、本家と同じく満たしている前提のまま', () => {
    const state = run('OI', 0, false);
    for (const type of ORDER_RATE_CONTINUE_TYPES) expect(state[type], type).toBe(1);
  });

  it('後方から進む脚質は、上位の帯を維持できない', () => {
    // 追込は序盤を最後方で進むので、順位率 20 以前を維持しているはずがない。
    const oi = run('OI', 0, true);
    expect(oi['order_rate_in20_continue']).toBe(0);
    expect(oi['order_rate_in40_continue']).toBe(0);
  });

  it('前方から進む脚質は、後方の帯を維持できない', () => {
    const nige = run('NIGE', 0, true);
    expect(nige['order_rate_out50_continue']).toBe(0);
    expect(nige['order_rate_out70_continue']).toBe(0);
  });

  it('同じ試行番号なら同じ結果になる', () => {
    const a = run('OI', 3, true);
    const b = run('OI', 3, true);
    for (const type of ORDER_RATE_CONTINUE_TYPES) expect(a[type], type).toBe(b[type]);
  });
});
