import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { RaceCalculator } from '../src/calculator.ts';
import { updateFieldConditions } from '../src/field/conditions.ts';
import {
  buildFieldBundle,
  defaultFieldProfile,
  RecordedField,
  type FieldBundle,
} from '../src/field/field.ts';
import { defaultSystemSetting, type RaceSetting } from '../src/setting.ts';
import type { RaceState } from '../src/state.ts';

/**
 * 位置関係で決まる条件を、確率ではなくフィールドから計算する（issue #74）。
 *
 * 見張るのは 3 つである。
 * 1. **フィールドが無ければ近似のまま。** 本家と同じ単騎モデルの挙動を変えない。
 * 2. **フィールドがあれば確率を引かない。** 近似確率の倍率を 0 にしても状態が立つ。
 * 3. 位置から決まる値が、位置のとおりに出る。
 *
 * docs/order-condition.md 5.3 節と docs/order-field.md 8 節を参照。
 */

const data = loadGameData();
const system = defaultSystemSetting();
const track = { location: 10006, course: 10606, condition: 1, gateCount: 9 } as const;
const calculator = new RaceCalculator(system, data.trackData);

function setting(patch: Partial<RaceSetting> = {}): RaceSetting {
  return {
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
    track,
    skills: [],
    skillActivateAdjustment: 'NONE',
    randomPosition: 'RANDOM',
    debuffCounts: {},
    positionKeepMode: 'APPROXIMATE',
    positionKeepRate: 100,
    ...patch,
  };
}

/** 相手の位置をこちらで決めた束。1 フレーム 1 行で、行の中は相手ごとの位置。 */
function stubBundle(rows: readonly (readonly number[])[]): FieldBundle {
  const opponents = rows[0]!.length;
  const positions = new Float64Array(rows.length * opponents);
  rows.forEach((row, f) => row.forEach((x, i) => (positions[f * opponents + i] = x)));
  return {
    samples: [
      {
        opponents,
        frames: rows.length,
        positions,
        styles: Array.from({ length: opponents }, () => 'SEN' as const),
      },
    ],
    opponents,
    courseLength: 2400,
  };
}

/**
 * 相手を並べた状態を作り、自分の位置を置いて 1 秒ぶんの更新を回す。
 *
 * `updateFieldConditions` は 1 秒に 1 回呼ばれる。ここではレースを進めずに
 * フレームと位置だけを置いて呼ぶので、位置と状態の対応だけを見られる。
 */
function driver(rows: readonly (readonly number[])[]): {
  state: RaceState;
  step: (frame: number, position: number) => Record<string, number>;
} {
  const bundle = stubBundle(rows);
  const state = calculator.createState(setting(), {
    seed: 1,
    trial: 0,
    field: new RecordedField(bundle, 0),
  });
  // 出走前は判定しない決まりなので、出走済みにしておく。
  state.simulation.delayTime = 0;
  const step = (frame: number, position: number): Record<string, number> => {
    state.simulation.frameElapsed = frame;
    state.simulation.startPosition = position;
    state.simulation.position = position;
    updateFieldConditions(state);
    return state.simulation.specialState;
  };
  return { state, step };
}

describe('位置から決まる条件', () => {
  it('追い抜けば負、追い抜かれれば正になる', () => {
    // 相手 2 頭は動かない。自分だけが前に出たり下がったりする。
    const rows = [
      [100, 200],
      [100, 200],
      [100, 200],
    ];
    const { step } = driver(rows);
    // 2 頭の後ろ。3 位。
    expect(step(0, 50)['change_order_onetime']).toBe(0);
    // 1 頭抜いて 2 位。スキルデータの `change_order_onetime < 0` が「追い抜いて」である。
    expect(step(1, 150)['change_order_onetime']).toBe(-1);
    // 抜き返されて 3 位に戻る。
    expect(step(2, 50)['change_order_onetime']).toBe(1);
  });

  it('追い抜いた回数を、中盤・終盤以降・最終コーナー以降で別々に積む', () => {
    const rows = Array.from({ length: 6 }, () => [500, 1000, 1800, 2100, 2300]);
    const { step } = driver(rows);
    // 中盤（400 以上 1600 未満）で 1 頭抜く
    step(0, 450);
    const middle = step(1, 600);
    expect(middle['change_order_up_middle']).toBe(1);
    expect(middle['change_order_up_end_after']).toBe(0);
    // 終盤（1600 以上）で 1 頭、そのあと 2 頭抜く。中盤の回数は残る。
    step(2, 1700);
    const end = step(3, 2200);
    expect(end['change_order_up_middle']).toBe(1);
    // 1 秒で 2 人抜けば 2 回と数える。条件が数えているのは追い抜いた回数である。
    expect(end['change_order_up_end_after']).toBe(3);
    // 最終コーナー以降のぶんは別に数える（東京 芝2400m の最終コーナーは 2000 手前）。
    expect(end['change_order_up_finalcorner_after']).toBeGreaterThan(0);
  });

  it('近くの人数を数える。前だけの人数も分けて数える', () => {
    // 既定の「近く」は 1 バ身（2.5 m）。前に 2 頭、後ろに 1 頭を置く。
    const rows = [[101, 102, 99, 120]];
    const { step } = driver(rows);
    const special = step(0, 100);
    expect(special['near_count']).toBe(3);
    expect(special['near_infront_count']).toBe(2);
  });

  it('「近く」の距離を広げると人数が増える', () => {
    const rows = [[105, 110, 95]];
    const near = (meters: number): number => {
      const bundle = stubBundle(rows);
      const state = calculator.createState(setting({ nearLaneMeters: meters }), {
        seed: 1,
        trial: 0,
        field: new RecordedField(bundle, 0),
      });
      state.simulation.delayTime = 0;
      state.simulation.startPosition = 100;
      state.simulation.position = 100;
      updateFieldConditions(state);
      return state.simulation.specialState['near_count']!;
    };
    expect(near(2.5)).toBe(0);
    expect(near(5)).toBe(2);
    expect(near(12)).toBe(3);
  });

  it('前後にウマ娘がいる秒数を数え、離れたら 0 に戻る', () => {
    const rows = [
      [101, 98],
      [101, 98],
      [200, 10],
    ];
    const { step } = driver(rows);
    const first = step(0, 100);
    expect(first['infront_near_lane']).toBe(1);
    expect(first['behind_near_lane']).toBe(1);
    // 囲まれている（前にも後ろにも近くにいる）
    expect(first['is_surrounded']).toBe(1);
    const second = step(1, 100);
    expect(second['infront_near_lane']).toBe(2);
    expect(second['behind_near_lane']).toBe(2);
    const third = step(2, 100);
    expect(third['infront_near_lane']).toBe(0);
    expect(third['behind_near_lane']).toBe(0);
    expect(third['is_surrounded']).toBe(0);
  });

  it('後ろが詰めてくると詰め寄られになり、抜かれると順位変動なしが切れる', () => {
    const rows = [
      [98],
      [99],
      [101],
    ];
    const { step } = driver(rows);
    // 1 秒目は比べる相手が無いので立たない。
    expect(step(0, 100)['overtaken']).toBe(0);
    // 差が 2 m から 1 m に縮まった。
    const pressed = step(1, 100);
    expect(pressed['overtaken']).toBe(1);
    expect(pressed['overtake_target_no_order_up_time']).toBe(1);
    // 抜かれた。詰め寄られは続くが、順位が動いたので「順位変動なし」は切れる。
    const passed = step(2, 100);
    expect(passed['change_order_onetime']).toBe(1);
    expect(passed['overtake_target_no_order_up_time']).toBe(0);
  });

  it('近くの前の相手に差を詰めていると追い抜きモードになる', () => {
    const rows = [
      [102],
      [101],
      [110],
    ];
    const { step } = driver(rows);
    expect(step(0, 100)['overtake']).toBe(0);
    // 前との差が 2 m から 1 m に縮まった。
    expect(step(1, 100)['overtake']).toBe(1);
    // 離されたら切れる。
    expect(step(2, 100)['overtake']).toBe(0);
  });

  it('出走前は判定しない', () => {
    const rows = [[100, 100]];
    const bundle = stubBundle(rows);
    const state = calculator.createState(setting(), {
      seed: 1,
      trial: 0,
      field: new RecordedField(bundle, 0),
    });
    state.simulation.delayTime = 0.05;
    state.simulation.startPosition = 100;
    updateFieldConditions(state);
    expect(state.beforeStart).toBe(true);
    expect(state.simulation.specialState['near_count']).toBe(0);
    expect(state.simulation.specialState['infront_near_lane']).toBe(0);
  });
});

describe('近似と位置計算の切り替え', () => {
  const bundle = buildFieldBundle(defaultFieldProfile(9), track, system, data.trackData, {
    samples: 8,
    seed: 99,
  });

  /** 1 レース走らせて、最後に残った状態を返す */
  const run = (scale: number, withField: boolean): Record<string, number> =>
    calculator.simulate(setting({ approximateRateScale: scale }), {
      seed: 7,
      trial: 3,
      field: withField ? bundle : null,
    }).state.simulation.specialState;

  it('フィールドが無ければ、倍率 0 で位置の条件も立たなくなる（確率を引いている）', () => {
    const state = run(0, false);
    expect(state['near_count']).toBe(0);
    expect(state['infront_near_lane']).toBe(0);
    expect(state['overtake']).toBe(0);
  });

  it('フィールドがあれば、倍率 0 でも位置の条件は立つ（確率を引いていない）', () => {
    const state = run(0, true);
    // ゴール直前に近くに誰もいない試行はありうるので、レース中に一度でも
    // 数えていれば足りる指標として、追い抜いた回数の合計を見る。
    const counted =
      (state['near_count'] ?? 0) +
      (state['infront_near_lane'] ?? 0) +
      (state['behind_near_lane'] ?? 0) +
      (state['change_order_up_middle'] ?? 0) +
      (state['change_order_up_end_after'] ?? 0);
    expect(counted).toBeGreaterThan(0);
  });

  it('置き換えていない型は、フィールドがあっても倍率で消える', () => {
    // 前方ブロックはレーンを持たないので確率のままである。
    // 倍率 0 で消え、極端に上げれば毎秒立つ（確率を引いている証拠）。
    expect(run(0, true)['blocked_front']).toBe(0);
    expect(run(1000, true)['blocked_front']).toBeGreaterThan(0);
  });
});
