import { horseLane } from '../data/constants.ts';
import type { RaceState } from '../state.ts';

/**
 * 他のウマ娘の位置や接触にまつわる条件の確率近似。
 * 1秒ごとに状態を更新する。mee1080/umasim の approximateConditions からの移植。
 */
export interface ApproximateCondition {
  readonly displayName: string;
  readonly description: string;
  readonly valueOnStart: number;
  update(state: RaceState, value: number): number;
}

/** 開始確率と継続確率で状態を更新する */
class StartContinue implements ApproximateCondition {
  readonly description: string;
  constructor(
    readonly displayName: string,
    readonly start: number,
    readonly continuation: number,
    readonly valueOnStart: number = 0,
  ) {
    this.description = `${(start * 100).toFixed(1)}% の確率で開始、${(continuation * 100).toFixed(1)}% の確率で継続`;
  }
  update(state: RaceState, value: number): number {
    const rng = state.rng.stream('approx', this.displayName);
    if (value === 0) return rng.nextDouble() < this.start ? 1 : 0;
    return rng.nextDouble() < this.continuation ? value + 1 : 0;
  }
}

/** 値ごとの確率分布から抽選する */
class RandomRates implements ApproximateCondition {
  readonly description: string;
  constructor(
    readonly displayName: string,
    readonly rates: readonly (readonly [number, number])[],
    readonly valueOnStart: number = 0,
  ) {
    this.description =
      rates.map(([v, r]) => `${(r * 100).toFixed(1)}% の確率で ${v}`).join('、') + '、残りは 0';
  }
  update(state: RaceState): number {
    const check = state.rng.stream('approx', this.displayName).nextDouble();
    let total = 0;
    for (const [value, rate] of this.rates) {
      total += rate;
      if (check < total) return value;
    }
    return 0;
  }
}

/** 一定確率で加算する */
class CountUp implements ApproximateCondition {
  readonly description: string;
  constructor(
    readonly displayName: string,
    readonly rate: number,
    readonly valueOnStart: number = 0,
  ) {
    this.description = `${(rate * 100).toFixed(1)}% の確率で +1`;
  }
  update(state: RaceState, value: number): number {
    return value + (state.rng.stream('approx', this.displayName).nextDouble() < this.rate ? 1 : 0);
  }
}

class NoneCondition implements ApproximateCondition {
  readonly description = 'なし';
  constructor(
    readonly displayName: string,
    readonly valueOnStart: number = 0,
  ) {}
  update(_state: RaceState, value: number): number {
    return value;
  }
}

/** 条件に応じて下位の近似を切り替える */
class MultiCondition implements ApproximateCondition {
  readonly description: string;
  constructor(
    readonly displayName: string,
    readonly conditions: readonly (readonly [
      ApproximateCondition,
      ((state: RaceState) => boolean) | null,
    ])[],
    readonly valueOnStart: number = 0,
  ) {
    this.description = conditions.map(([c]) => c.description).join('\n');
  }
  update(state: RaceState, value: number): number {
    for (const [condition, predicate] of this.conditions) {
      if (predicate === null || predicate(state)) return condition.update(state, value);
    }
    throw new Error(`no matching approximate condition: ${this.displayName}`);
  }
}

export const approximateConditions: Readonly<Record<string, ApproximateCondition>> = {
  move_lane: new StartContinue('横移動(軽やかステップなど)', 0.1, 0.1),
  change_order_onetime: new RandomRates('追い抜き/追い抜かれ(アガッてきたなど多数)', [
    [-1, 0.2],
    [1, 0.2],
  ]),
  overtake: new MultiCondition('追い抜きモード(電光石火など多数、レーン移動にも影響)', [
    [new StartContinue('追い抜きモード 逃げ', 0.05, 0.5), (s) => s.setting.basicRunningStyle === 'NIGE'],
    [new StartContinue('追い抜きモード 先行', 0.15, 0.55), (s) => s.setting.basicRunningStyle === 'SEN'],
    [new StartContinue('追い抜きモード その他', 0.2, 0.6), null],
  ]),
  overtaken: new MultiCondition('詰め寄られ(勝利への執念など)', [
    [
      new StartContinue('詰め寄られ 逃げ先行', 0.3, 0.7),
      (s) => s.setting.basicRunningStyle === 'NIGE' || s.setting.basicRunningStyle === 'SEN',
    ],
    [new StartContinue('詰め寄られ 差し追込', 0.15, 0.5), null],
  ]),
  blocked_front: new StartContinue('前方ブロック(鋼の意志など)', 0.07, 0.5),
  blocked_side: new MultiCondition(
    '横ブロック(つぼみなど)',
    [
      [
        new StartContinue('横ブロック 序盤外側', 0.0, 0.0),
        (s) => s.currentSection >= 1 && s.currentSection <= 3 && s.simulation.currentLane > 3.0 * horseLane,
      ],
      [new StartContinue('横ブロック 序盤', 0.1, 0.85), (s) => s.currentPhase <= 0],
      [new StartContinue('横ブロック 中盤', 0.08, 0.75), (s) => s.currentPhase === 1],
      [new StartContinue('横ブロック 終盤', 0.07, 0.5), null],
    ],
    1,
  ),
  infront_near_lane: new MultiCondition('前にウマ娘(ノンストなど)', [
    [new StartContinue('前にウマ娘 序盤', 0.05, 0.5), (s) => s.currentPhase <= 0],
    [new StartContinue('前にウマ娘 中盤', 0.1, 0.5), (s) => s.currentPhase === 1],
    [new StartContinue('前にウマ娘 終盤最終コーナー前', 0.2, 0.3), (s) => !s.isAfterFinalCorner],
    [new StartContinue('前にウマ娘 最終コーナー後', 0.07, 0.4), null],
  ]),
  behind_near_lane: new StartContinue('後にウマ娘(お先など)', 0.15, 0.5),
  behind_near_lane_time_set1: new StartContinue('少し抜け出ていると(ヴォードヴィル)', 0.2, 0.6),
  near_count: new MultiCondition('近くのウマ娘人数(ウマ好みなど)', [
    [
      new RandomRates('近くのウマ娘 序盤', [
        [1, 0.1],
        [2, 0.2],
        [3, 0.3],
        [4, 0.2],
        [5, 0.1],
      ]),
      (s) => s.currentPhase <= 0,
    ],
    [
      new RandomRates('近くのウマ娘 中盤', [
        [1, 0.3],
        [2, 0.2],
        [3, 0.1],
      ]),
      (s) => s.currentPhase === 1,
    ],
    [
      new RandomRates('近くのウマ娘 終盤', [
        [1, 0.3],
        [2, 0.3],
        [3, 0.2],
      ]),
      null,
    ],
  ]),
  near_infront_count: new RandomRates('前方近くのウマ娘人数(無二/無三)', [[1, 0.05]]),
  is_surrounded: new StartContinue('周囲にウマ娘(どこ吹く風など)', 0.05, 0.4),
  temptation_opponent_count_behind: new StartContinue(
    '後ろのウマ娘掛かり(トリック&トリートなど)',
    0.07,
    0.2,
  ),
  'is_other_character_activate_advantage_skill-1': new RandomRates(
    '他のウマ娘がスキル発動(想い束ね、前へ)',
    [[1, 0.9]],
  ),
  is_other_character_activate_advantage_skill22: new MultiCondition(
    '他のウマ娘が速度スキル発動(後の先など)',
    [
      [new RandomRates('他速度スキル 序盤', [[1, 0.1]]), (s) => s.currentPhase <= 0],
      [new RandomRates('他速度スキル 中盤', [[1, 0.15]]), (s) => s.currentPhase === 1],
      [new RandomRates('他速度スキル 終盤', [[1, 0.2]]), null],
    ],
  ),
  is_other_character_activate_advantage_skill31: new MultiCondition(
    '他のウマ娘が加速スキル発動(トランセンド固有)',
    [
      [new RandomRates('他加速スキル 序盤', [[1, 0.9]]), (s) => s.currentPhase <= 0],
      [
        new RandomRates('他加速スキル 中盤前半', [[1, 0.01]]),
        (s) =>
          s.simulation.position >= s.setting.phase1Start && s.simulation.position <= s.setting.phase1Half,
      ],
      [new RandomRates('他加速スキル 中盤後半', [[1, 0.05]]), (s) => s.currentPhase === 1],
      [new RandomRates('他加速スキル 終盤', [[1, 0.9]]), null],
    ],
  ),
  change_order_up_middle: new MultiCondition('中盤追い抜き(クラウン固有など)', [
    [new CountUp('中盤追い抜き', 0.05), (s) => s.currentPhase === 1],
    [new NoneCondition('中盤追い抜き その他'), null],
  ]),
  change_order_up_end_after: new MultiCondition('終盤追い抜き(ルドルフ固有など)', [
    [new CountUp('終盤追い抜き', 0.15), (s) => s.currentPhase >= 2],
    [new NoneCondition('終盤追い抜き その他'), null],
  ]),
  change_order_up_finalcorner_after: new MultiCondition('最終コーナー以降追い抜き', [
    [new CountUp('最終コーナー以降追い抜き', 0.15), (s) => s.isAfterFinalCorner],
    [new NoneCondition('最終コーナー以降追い抜き その他'), null],
  ]),
  overtake_target_no_order_up_time: new StartContinue('追い抜き対象順位変動なし(絶ボク)', 0.8, 0.6),
};

export const approximateTypeToState: Readonly<Record<string, string>> = {
  is_move_lane: 'move_lane',
  change_order_onetime: 'change_order_onetime',
  is_overtake: 'overtake',
  overtake_target_time: 'overtaken',
  blocked_front: 'blocked_front',
  blocked_front_continuetime: 'blocked_front',
  blocked_side_continuetime: 'blocked_side',
  infront_near_lane_time: 'infront_near_lane',
  behind_near_lane_time: 'behind_near_lane',
  behind_near_lane_time_set1: 'behind_near_lane_time_set1',
  near_count: 'near_count',
  near_infront_count: 'near_infront_count',
  is_surrounded: 'is_surrounded',
  temptation_opponent_count_behind: 'temptation_opponent_count_behind',
  change_order_up_middle: 'change_order_up_middle',
  change_order_up_end_after: 'change_order_up_end_after',
  change_order_up_finalcorner_after: 'change_order_up_finalcorner_after',
  overtake_target_no_order_up_time: 'overtake_target_no_order_up_time',
};

/** 判定から外す条件と、その理由 */
export const ignoreConditions: Readonly<Record<string, string>> = {
  grade: 'GI条件は無視',
  time: 'ナイター条件は無視',
  season: '季節条件は無視',
  weather: '天候条件は無視',
  is_dirtgrade: '交流重賞条件はレース場のみ判定',
  fan_count: 'ファン数条件は無視',
  order: '順位条件は無視',
  order_rate: '順位条件は無視',
  order_rate_in10_continue: '順位条件は無視',
  order_rate_in20_continue: '順位条件は無視',
  order_rate_in30_continue: '順位条件は無視',
  order_rate_in40_continue: '順位条件は無視',
  order_rate_in50_continue: '順位条件は無視',
  order_rate_in60_continue: '順位条件は無視',
  order_rate_in70_continue: '順位条件は無視',
  order_rate_in80_continue: '順位条件は無視',
  order_rate_in90_continue: '順位条件は無視',
  order_rate_out10_continue: '順位条件は無視',
  order_rate_out20_continue: '順位条件は無視',
  order_rate_out30_continue: '順位条件は無視',
  order_rate_out40_continue: '順位条件は無視',
  order_rate_out50_continue: '順位条件は無視',
  order_rate_out60_continue: '順位条件は無視',
  order_rate_out70_continue: '順位条件は無視',
  order_rate_out80_continue: '順位条件は無視',
  order_rate_out90_continue: '順位条件は無視',
  distance_diff_rate: '相対位置条件は無視',
  bashin_diff_infront: '他のウマ娘との距離条件は無視',
  bashin_diff_behind: '他のウマ娘との距離条件は無視',
  distance_diff_top: '他のウマ娘との距離条件は無視',
  distance_diff_top_float: '他のウマ娘との距離条件は無視',
  same_skill_horse_count: '他のウマ娘のスキル条件は無視',
  is_exist_skill_id: '他のウマ娘のスキル条件は無視',
  is_behind_in: '内外条件は無視',
  lane_type: '内外条件は無視',
  running_style_equal_popularity_one: '他のウマ娘の作戦条件は無視',
  running_style_count_same: '他のウマ娘の作戦条件は無視',
  running_style_count_same_rate: '他のウマ娘の作戦条件は無視',
  visiblehorse: '視界内のウマ娘条件は満たしている前提',
  activate_count_all_team: 'チームのスキル発動数条件は無視',
  is_used_skill_id_with_detail_one: '前提スキルは強い方の発動が前提',
};
