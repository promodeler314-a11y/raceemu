import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { RaceCalculator, updateFrame } from '../src/calculator.ts';
import { bashinMeters } from '../src/data/constants.ts';
import { ORDER_RATE_CONTINUE_TYPES, orderRateBoundaries } from '../src/data/orderRate.ts';
import { orderRateContinueOf } from '../src/data/orderRateResolve.ts';
import {
  buildFieldBundle,
  defaultFieldProfile,
  fixedFieldProfile,
  RecordedField,
  type FieldProfile,
} from '../src/field/field.ts';
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

describe('既定の相手の想定', () => {
  const totalOf = (profile: FieldProfile) =>
    Object.values(profile.counts).reduce((sum, n) => sum + n, 0);

  it('相手の合計が 1〜18 頭のどれでも出走頭数から 1 引いた数になる', () => {
    for (let gateCount = 1; gateCount <= 18; gateCount++) {
      expect(totalOf(defaultFieldProfile(gateCount)), String(gateCount)).toBe(gateCount - 1);
      expect(totalOf(fixedFieldProfile(gateCount)), String(gateCount)).toBe(gateCount - 1);
    }
  });

  it('相手が 2 頭以下なら、同じ比の最大剰余で配る', () => {
    // 以前は逃げ・先行・差しに最低 1 頭ずつ置いていたので、2〜3 頭立てで相手が 3 頭になった。
    const zero = { NIGE: 0, SEN: 0, SASI: 0, OI: 0, OONIGE: 0 };
    expect(defaultFieldProfile(1).counts).toEqual(zero);
    expect(defaultFieldProfile(2).counts).toEqual({ ...zero, SEN: 1 });
    expect(defaultFieldProfile(3).counts).toEqual({ ...zero, SEN: 1, SASI: 1 });
    expect(fixedFieldProfile(3).counts).toEqual({ ...zero, SEN: 1, SASI: 1 });
  });

  /**
   * 9 頭の戻り値はスキル一覧の版の指紋に入る（packages/solver/src/skill-list-version.ts）。
   * 1 ビットでも変わると、事前計算したスキル一覧を 20 時間かけて作り直すことになる。
   * 値を直に書いて固定する。
   */
  const uma = {
    speed: 1100,
    stamina: 900,
    power: 900,
    guts: 600,
    wisdom: 900,
    condition: 'BEST',
    distanceFit: 'A',
    surfaceFit: 'A',
    styleFit: 'A',
    popularity: 5,
    gateNumber: 0,
    uniqueLevel: 6,
  };
  const drawn = {
    matchSelf: true,
    offset: 0,
    sigma: 100,
    drawCondition: true,
    redrawComposition: true,
    withSkills: true,
  };
  const fixed = {
    matchSelf: false,
    offset: 0,
    sigma: 0,
    drawCondition: false,
    redrawComposition: false,
    withSkills: false,
  };

  it('9 頭と 12 頭の戻り値が変わらない', () => {
    const counts9 = { NIGE: 2, SEN: 2, SASI: 2, OI: 2, OONIGE: 0 };
    const counts12 = { NIGE: 2, SEN: 3, SASI: 3, OI: 3, OONIGE: 0 };
    expect(defaultFieldProfile(9)).toStrictEqual({ counts: counts9, uma, ...drawn });
    expect(defaultFieldProfile(12)).toStrictEqual({ counts: counts12, uma, ...drawn });
    expect(fixedFieldProfile(9)).toStrictEqual({ counts: counts9, uma, ...fixed });
    expect(fixedFieldProfile(12)).toStrictEqual({ counts: counts12, uma, ...fixed });
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

  it('9 頭立てと 12 頭立てのすべての帯が対応表にあり、それ以外の頭数は式で延ばす', () => {
    for (const type of ORDER_RATE_CONTINUE_TYPES) {
      expect(orderRateContinueOf(type, 9)?.extrapolated, type).toBe(false);
      expect(orderRateContinueOf(type, 12)?.extrapolated, type).toBe(false);
    }
    // 対応表に無い頭数は、以前は引けずに満たしている前提へ戻していた。
    // 今は表の全項目を再現する式 H で延ばす（docs/order-condition.md 2.2 節）。
    // 18 頭の順位率 20 以前は T = floor(20 × 17 / 100) + 1 = 4 で、4 位以内。
    expect(orderRateContinueOf('order_rate_in20_continue', 18)).toEqual({
      boundary: { atMost: 4 },
      extrapolated: true,
    });
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
    // 追込はちょうど 0 だったが、追い抜きモードを確率ではなく位置から決めるように
    // してから（issue #74、docs/order-field.md 8 節）60 試行に 1 本だけ入るようになった。
    // 追い抜きモードはレーン移動に効くので、走る線が変われば先頭との距離も変わる。
    // 見たいのは脚質で発動が分かれることなので、ちょうど 0 ではなく上限で見る。
    expect(oi).toBeLessThan(0.1);
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

/**
 * 9 頭と 12 頭以外の頭数（docs/order-condition.md 2.2 節）。
 *
 * 以前は対応表に無い頭数だと、順位率の条件は常に真で、出走前も真だった。
 * 今は式 H で延ばした境界を、表にある頭数と同じ分岐で判定する。
 */
describe('9 頭と 12 頭以外の順位率（フィールド）', () => {
  const track18 = { ...track, gateCount: 18 };
  const bundle = buildFieldBundle(defaultFieldProfile(18), track18, system, data.trackData, {
    samples: 6,
    seed: 99,
  });
  const calculator = new RaceCalculator(system, data.trackData);
  const setting18 = (style: 'NIGE' | 'SEN' | 'SASI' | 'OI'): RaceSetting => ({ ...setting(style), track: track18 });
  const anySkill = data.skillsByName.get('末脚')![0]!;
  const compile = (state: ReturnType<RaceCalculator['createState']>, operator: string, value: number) =>
    compileConditions(
      anySkill,
      [[new SkillCondition('order_rate', operator, value)]],
      state.setting,
      new RngSet(7, 0),
      newSkillScratch(),
    );

  it('相手が 17 頭になる', () => {
    expect(bundle.opponents).toBe(17);
  });

  it('順位率の条件を順位で判定し、出走前は満たさない', () => {
    const state = calculator.createState(setting18('OI'), {
      seed: 7,
      trial: 0,
      field: new RecordedField(bundle, 0),
    });
    // 18 頭では、順位率 50 以下は 9 位以内、40 以上は 7 位以降になる。
    const front = compile(state, '<=', 50);
    const back = compile(state, '>=', 40);
    expect(state.beforeStart).toBe(true);
    expect(front(state)).toBe(false);
    expect(back(state)).toBe(false);
    const seen = new Set<boolean>();
    for (let guard = 0; guard < 5000; guard++) {
      if (updateFrame(state)) break;
      if (state.beforeStart) continue;
      const order = state.order!;
      expect(front(state)).toBe(order <= 9);
      expect(back(state)).toBe(order >= 7);
      seen.add(order <= 9);
    }
    // 追込は序盤を後ろで進むので、9 位より後ろにいる時間がある。常に真ではない。
    expect(seen.has(false)).toBe(true);
  });

  it('帯の維持も順位で落ちる', () => {
    const oi = calculator.simulate(setting18('OI'), { seed: 7, trial: 0, field: bundle }).state;
    expect(oi.simulation.specialState['order_rate_in20_continue']).toBe(0);
    const nige = calculator.simulate(setting18('NIGE'), { seed: 7, trial: 0, field: bundle }).state;
    expect(nige.simulation.specialState['order_rate_out70_continue']).toBe(0);
  });
});
