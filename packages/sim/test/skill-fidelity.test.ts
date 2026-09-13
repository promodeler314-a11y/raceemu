import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { RngSet } from '../src/rng.ts';
import { DerivedSetting, emptyPassiveBonus, type RaceSetting } from '../src/setting.ts';
import { ignoreConditions } from '../src/skill/approximate.ts';
import {
  classifyCondition,
  classifySkill,
  knownUnsupportedTypes,
  type Fidelity,
} from '../src/skill/classify.ts';
import { compileConditions, newSkillScratch, unsupportedConditions } from '../src/skill/condition.ts';
import type { SkillData } from '../src/skill/types.ts';

/**
 * スキルの分類（近似の印）を固定する。
 *
 * 分類はレースを回さずに条件式から決まる。ここで固定しているのは
 * 「どの型をどの段に置いたか」であって、発動率そのものではない。
 * データを取り直して新しい型が増えれば落ちる。そのときは、増えた型が
 * 実装されているのか落ちているのかを確かめてから表を直す。
 */

const data = loadGameData();

const baseSetting: RaceSetting = {
  uma: {
    charaName: 'T',
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

const derived = new DerivedSetting(baseSetting, emptyPassiveBonus(), data.trackData);

/** データに現れる条件の型を、分類ごとに集める。 */
function typesByFidelity(hasField: boolean): Record<Fidelity, string[]> {
  const result: Record<Fidelity, Set<string>> = {
    exact: new Set(),
    approximate: new Set(),
    dropped: new Set(),
  };
  for (const skill of data.skills) {
    for (const invoke of skill.invokes) {
      for (const group of [...invoke.conditions, ...invoke.preConditions]) {
        for (const condition of group) {
          result[classifyCondition(condition, derived, { hasField }).fidelity].add(condition.type);
        }
      }
    }
  }
  return {
    exact: [...result.exact].sort(),
    approximate: [...result.approximate].sort(),
    dropped: [...result.dropped].sort(),
  };
}

function named(name: string): SkillData {
  const found = data.skillsByName.get(name);
  if (found === undefined) throw new Error(`スキルが見つからない: ${name}`);
  return found[0]!;
}

/** 順位条件を判定するとき、落としている扱いから近似扱いに移る族。 */
const FIELD_DEPENDENT = [
  'bashin_diff_behind',
  'bashin_diff_infront',
  'distance_diff_rate',
  'distance_diff_top',
  'distance_diff_top_float',
  'order',
  'order_rate',
  'order_rate_in20_continue',
  'order_rate_in40_continue',
  'order_rate_in50_continue',
  'order_rate_in80_continue',
  'order_rate_out20_continue',
  'order_rate_out40_continue',
  'order_rate_out50_continue',
  'order_rate_out70_continue',
];

describe('スキルの再現度の分類', () => {
  it('条件を落としている型が既知のものだけである（順位条件を判定するとき）', () => {
    expect(typesByFidelity(true).dropped).toEqual([
      'activate_count_all_team',
      'fan_count',
      'grade',
      'is_behind_in',
      'is_exist_skill_id',
      'lane_type',
      'running_style_count_same',
      'running_style_count_same_rate',
      'running_style_equal_popularity_one',
      'same_skill_horse_count',
      // 季節・天候・時刻は指定が無ければ落ちる。baseSetting は指定していない。
      'season',
      'succession_skill_count',
      'time',
      'visiblehorse',
      'weather',
    ]);
  });

  it('確率近似で判定している型が既知のものだけである（順位条件を判定するとき）', () => {
    expect(typesByFidelity(true).approximate).toEqual([
      // 他のウマ娘の位置と接触。approximate.ts が確率で置き換えている。
      'behind_near_lane_time',
      'behind_near_lane_time_set1',
      'blocked_front',
      'blocked_front_continuetime',
      'blocked_side_continuetime',
      'change_order_onetime',
      'change_order_up_end_after',
      'change_order_up_finalcorner_after',
      'change_order_up_middle',
      'infront_near_lane_time',
      'is_move_lane',
      'is_other_character_activate_advantage_skill',
      'is_overtake',
      'is_popularity_top_character_activate_advantage_skill',
      'is_surrounded',
      'near_count',
      'near_infront_count',
      'overtake_target_no_order_up_time',
      'overtake_target_time',
      'temptation_opponent_count_behind',
      // 交流重賞はレース場だけで判定している。
      'is_dirtgrade',
      // 前提スキルは同じグループの強い方が発動したかで見ている。
      'is_used_skill_id_with_detail_one',
      // 順位と距離差。判定はするが相手は作り物の束である。
      ...FIELD_DEPENDENT,
    ].sort());
  });

  it('フィールドを渡さないと、順位と距離差の族だけが落ちる側に移る', () => {
    const withField = typesByFidelity(true);
    const withoutField = typesByFidelity(false);
    const moved = withoutField.dropped.filter((type) => !withField.dropped.includes(type));
    expect(moved.sort()).toEqual([...FIELD_DEPENDENT].sort());
    // 完全に判定できている型は、相手の有無で動かない。
    expect(withoutField.exact).toEqual(withField.exact);
  });

  it('スキルの分類は、最も悪い条件で決まる', () => {
    const withField = { hasField: true };
    // 発動区間の抽選だけなので、条件どおりに判定できている。
    expect(classifySkill(named('弧線のプロフェッサー'), derived, withField).fidelity).toBe('exact');
    // 前方ブロックは確率近似である。
    expect(classifySkill(named('来ます来てます来させます！'), derived, withField).fidelity).toBe(
      'approximate',
    );
    // 同じ作戦の頭数は、そもそも持っていない情報なので落としている。
    expect(classifySkill(named('おひとり様◎'), derived, withField).fidelity).toBe('dropped');
    // 本家も未対応の型を持つスキル。
    expect(classifySkill(named('連綿'), derived, withField).fidelity).toBe('dropped');
  });

  it('順位条件を判定するかどうかで、順位条件つきスキルの分類が動く', () => {
    const skill = named('アクセルX');
    expect(classifySkill(skill, derived, { hasField: true }).fidelity).toBe('approximate');
    expect(classifySkill(skill, derived, { hasField: false }).fidelity).toBe('dropped');
  });

  it('理由は条件の型ごとに 1 つだけ並ぶ', () => {
    const notes = classifySkill(named('アクセルX'), derived, { hasField: false }).notes;
    expect(notes.length).toBeGreaterThan(0);
    expect(new Set(notes.map((n) => n.type)).size).toBe(notes.length);
    // 落としているものを先に読ませる。
    expect(notes[0]!.fidelity).toBe('dropped');
    expect(notes.every((n) => n.reason.length > 0)).toBe(true);
  });
});

/**
 * 分類の表と、実際にコンパイルしたときの振る舞いがずれていないかを見る。
 *
 * 分類は `compileCondition` の枝を写した表であって、同じコードではない。
 * 写し間違えると、印だけが本当と食い違う。そこを両側から挟む。
 */
describe('分類とコンパイルの突き合わせ', () => {
  it('実行時に未対応と記録される型は、必ず落としていると分類される', () => {
    unsupportedConditions.clear();
    const rng = new RngSet(1, 0);
    for (const skill of data.skills) {
      for (const invoke of skill.invokes) {
        const scratch = newSkillScratch();
        compileConditions(skill, invoke.preConditions, derived, rng, scratch);
        compileConditions(skill, invoke.conditions, derived, rng, scratch);
      }
    }
    // 記録は「型 演算子 値」か「型 (頭数)」の形で入るので、先頭の語だけを見る。
    const recorded = new Set([...unsupportedConditions].map((entry) => entry.split(' ')[0]!));
    const dropped = new Set(typesByFidelity(true).dropped);
    for (const type of recorded) expect([type, dropped.has(type)]).toEqual([type, true]);
  });

  it('落としていると分類した型は、無視の表か本家も未対応の型に載っている', () => {
    for (const type of typesByFidelity(false).dropped) {
      const known = type in ignoreConditions || knownUnsupportedTypes.includes(type);
      expect([type, known]).toEqual([type, true]);
    }
  });

  it('無視の表に載っている型は、完全に判定できているとは分類されない', () => {
    const exact = new Set(typesByFidelity(false).exact);
    for (const type of Object.keys(ignoreConditions)) {
      expect([type, exact.has(type)]).toEqual([type, false]);
    }
  });
});
