import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { RaceCalculator, updateFrame } from '../src/calculator.ts';
import { bashinMeters } from '../src/data/constants.ts';
import {
  ORDER_RATE_CONTINUE_TYPES,
  orderRateBoundaries,
  resolveOrderRateContinue,
} from '../src/data/orderRate.ts';
import { buildFieldBundle, defaultFieldProfile, RecordedField } from '../src/field/field.ts';
import { nodeWorkerFactory } from '../src/parallel/node.ts';
import { WorkerPool } from '../src/parallel/pool.ts';
import { toSerializable, toSkillSummaries } from '../src/parallel/protocol.ts';
import { RngSet } from '../src/rng.ts';
import { defaultSystemSetting, type RaceSetting } from '../src/setting.ts';
import { compileConditions, newSkillScratch } from '../src/skill/condition.ts';
import { SkillCondition } from '../src/skill/types.ts';

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
    const view = new RecordedField(bundle, 0);
    for (const frame of [0, 100, 500, 1000]) {
      for (const position of [0, 500, 1200, 2400]) {
        const order = view.order(frame, position);
        expect(order).toBeGreaterThanOrEqual(1);
        expect(order).toBeLessThanOrEqual(9);
      }
    }
  });

  it('前に出るほど順位が上がる', () => {
    const view = new RecordedField(bundle, 3);
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
      // 相手を自分と同格にし、束ごとに引き直すようになってから、逃げでも
      // 後ろに沈む試行が出る。判定すればはっきり下がる、というところまでを見る。
      // docs/order-field.md 4.3 節。
      expect(b.triggerRate).toBeLessThan(a.triggerRate / 2);
      expect(b.triggerRate).toBeLessThan(0.4);
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

describe('距離差の条件', () => {
  const bundle = buildFieldBundle(defaultFieldProfile(9), track, system, data.trackData, {
    samples: 16,
    seed: 99,
  });
  const calculator = new RaceCalculator(system, data.trackData);

  it('バ身の換算がスキルデータの注記と合う', () => {
    // 「先頭とのバ身差<=5」と「先頭との距離×10m<=25」が同じ族にある。
    // 後者は 0.1 m 単位なので 25 は 2.5 m を指し、それが 1 バ身に当たる。
    // docs/order-condition.md 7 節。
    expect(25 / 10 / bashinMeters).toBe(1);
  });

  it('相対位置は 0 から 100 に収まり、先頭ほど小さい', () => {
    const view = new RecordedField(bundle, 0);
    for (const frame of [0, 200, 600, 1200]) {
      for (const position of [0, 300, 1200, 2000]) {
        const spread = view.spread(frame, position);
        const fromTop = view.distanceFromTop(frame, position);
        expect(spread).toBeGreaterThanOrEqual(fromTop);
        const rate = spread <= 0 ? 0 : (fromTop / spread) * 100;
        expect(rate).toBeGreaterThanOrEqual(0);
        expect(rate).toBeLessThanOrEqual(100);
      }
    }
  });

  /** 指定したスキルが発動した試行の割合。 */
  function triggerRate(
    style: 'NIGE' | 'SEN' | 'SASI' | 'OI',
    skillName: string,
    withField: boolean,
  ): number {
    const base = { ...setting(style, [skillName]), skillActivateAdjustment: 'ALL' as const };
    const skillId = data.skillsByName.get(skillName)![0]!.id;
    const trials = 60;
    let fired = 0;
    for (let trial = 0; trial < trials; trial++) {
      const { state } = calculator.simulate(base, {
        seed: 11,
        trial,
        field: withField ? bundle : null,
      });
      if (state.simulation.coolDownMap.has(skillId)) fired++;
    }
    return fired / trials;
  }

  it('相対位置を見る条件が、脚質で発動を分ける', () => {
    // 「貴顕の使命を果たすべく」は 最終コーナー以降・コーナー・相対位置<=30 で発動する。
    // 判定を入れなければ距離差の条件は素通りするので、脚質によらず発動する。
    for (const style of ['NIGE', 'OI'] as const) {
      expect(triggerRate(style, '貴顕の使命を果たすべく', false), style).toBe(1);
    }
    // 判定を入れると、先頭寄りで進む脚質だけが満たす。
    //
    // 逃げが 10 割にならないのは、相手を一緒に走らせるようにしたためである
    // （docs/order-field.md 4.1 節）。相手が隊列を組むので、逃げでも先頭から
    // 離れる試行が出る。1 頭ずつ独立に走らせていたころは塊の前に出るだけで
    // 済んでいた。
    const nige = triggerRate('NIGE', '貴顕の使命を果たすべく', true);
    const oi = triggerRate('OI', '貴顕の使命を果たすべく', true);
    expect(nige).toBeGreaterThan(0.5);
    expect(oi).toBe(0);
  });

  it('先頭との距離が脚質の順に開く', () => {
    const view = new RecordedField(bundle, 0);
    const midRace = (style: 'NIGE' | 'SEN' | 'SASI' | 'OI') => {
      const { state } = calculator.simulate(setting(style), {
        seed: 11,
        trial: 0,
        recordFrames: true,
        field: bundle,
      });
      const frames = state.simulation.frames;
      const index = frames.findIndex((f) => f.startPosition >= 1200);
      return view.distanceFromTop(index, frames[index]!.startPosition);
    };
    const nige = midRace('NIGE');
    const sen = midRace('SEN');
    const sasi = midRace('SASI');
    const oi = midRace('OI');
    expect(nige).toBeLessThan(sen);
    expect(sen).toBeLessThan(sasi);
    expect(sasi).toBeLessThan(oi);
  });
});

describe('出走前の順位', () => {
  /**
   * スタート直後、全頭が同じ位置にいる間は「自分より前にいる相手」が 0 になり、
   * 誰から見ても順位が 1 になる。出走の遅れは 0 から 0.1 秒で数フレームだが、
   * 「序盤に 1 位」のような条件はその数フレームで満たされてしまう。
   * docs/order-field.md 2.4 節と 4.4 節を参照。
   */
  const bundle = buildFieldBundle(defaultFieldProfile(9), track, system, data.trackData, {
    samples: 4,
    seed: 9001,
  });
  const calculator = new RaceCalculator(system, data.trackData);
  const anySkill = data.skillsByName.get('末脚')![0]!;

  const orderIsOne = (state: ReturnType<RaceCalculator['createState']>) => {
    const groups = [[new SkillCondition('order', '==', 1)]];
    return compileConditions(anySkill, groups, state.setting, new RngSet(7, 0), newSkillScratch())(
      state,
    );
  };

  it('出走前は、同着で 1 位に見えても条件を満たさない', () => {
    const state = calculator.createState(setting('NIGE'), { seed: 7, trial: 0, field: new RecordedField(bundle, 0) });
    expect(state.beforeStart).toBe(true);
    // 位置の上では全頭が同じところにいるので、順位そのものは 1 になる。
    expect(state.order).toBe(1);
    // それでも条件は満たさない。
    expect(orderIsOne(state)).toBe(false);
  });

  it('出走したあとは順位のとおりに判定する', () => {
    const state = calculator.createState(setting('NIGE'), { seed: 7, trial: 0, field: new RecordedField(bundle, 0) });
    for (let guard = 0; guard < 600 && state.beforeStart; guard++) updateFrame(state);
    expect(state.beforeStart).toBe(false);
    expect(orderIsOne(state)).toBe(state.order === 1);
  });

  it('フィールドが無ければ、出走前でも本家と同じく満たしている前提になる', () => {
    const state = calculator.createState(setting('NIGE'), { seed: 7, trial: 0 });
    expect(state.beforeStart).toBe(true);
    expect(state.order).toBeNull();
    expect(orderIsOne(state)).toBe(true);
  });
});
