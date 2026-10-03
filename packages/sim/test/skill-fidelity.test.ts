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
import { SkillCondition, type SkillData } from '../src/skill/types.ts';

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

/** 頭数だけを変えた設定 */
function derivedAt(gateCount: number): DerivedSetting {
  return new DerivedSetting(
    { ...baseSetting, track: { ...baseSetting.track, gateCount } },
    emptyPassiveBonus(),
    data.trackData,
  );
}

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
      // 他のウマ娘の位置と接触。
      //
      // このうち 12 の型（追い抜き、前後のウマ娘、近くの人数、追い抜いた回数）は、
      // フィールドを渡していれば確率を引かずに位置から計算している（issue #74、
      // field/conditions.ts）。**それでも △ のままなので、この一覧は変わらない。**
      // 相手は作り物の束であり、「近く」を 1 バ身と置いたのも読み取りだからである。
      // 確率のままなのか位置から決めているのかは理由の文で分かれる（下の 1 件で見張る）。
      // レーンが要るもの（blocked_*、is_move_lane）と相手の掛かり
      // （temptation_opponent_count_behind）は、いまも確率である。
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

  /**
   * 確率近似をやめて位置から計算するようにした型（issue #74）。
   *
   * **印は △ のままなので、型ごとの一覧（上の 2 件）は動かない。** 確率を引かなく
   * なっても相手は作り物の束であり、「近く」の距離も読み取りだからである。
   * 動くのは理由のほうで、フィールドを渡したときだけ「位置から判定している」に変わる。
   * ここを見張っていないと、確率のままなのか位置から決めているのかが印から読めなくなる。
   */
  it('位置から計算するようにした型は、フィールドを渡すと理由が変わる', () => {
    const reasonOf = (type: string, hasField: boolean): string =>
      classifyCondition(new SkillCondition(type, '>=', 1), derived, { hasField }).reason;
    for (const type of ['near_count', 'is_overtake', 'infront_near_lane_time']) {
      expect(classifyCondition(new SkillCondition(type, '>=', 1), derived, { hasField: true }).fidelity)
        .toBe('approximate');
      expect(reasonOf(type, true), type).toContain('位置から判定');
      expect(reasonOf(type, false), type).toContain('確率で近似');
    }
    // 置き換えていない型（レーンが要る、相手の掛かりが要る）は、どちらでも確率のままである。
    for (const type of ['blocked_side_continuetime', 'is_move_lane', 'temptation_opponent_count_behind']) {
      expect(reasonOf(type, true), type).toContain('確率で近似');
      expect(reasonOf(type, false), type).toContain('確率で近似');
    }
  });

  /**
   * 9 頭と 12 頭以外の順位率（docs/order-condition.md 2.2 節）。
   *
   * 以前は対応表に無い頭数を落とす側に置き、理由の文に内部の鍵（`>=:40:18` のような形）と
   * 型名を出していた。今は式で延ばした境界で判定するので近似の側に置き、
   * 注記から引いた境界と同じ信頼度に見えないよう理由を分ける。
   */
  it('9 頭と 12 頭以外の順位率は近似に置き、式で延ばしたことを理由で分ける', () => {
    const conditions = [
      new SkillCondition('order_rate', '<=', 50),
      new SkillCondition('order_rate', '>', 50),
      new SkillCondition('order_rate_in40_continue', '==', 1),
      new SkillCondition('order_rate_out70_continue', '==', 1),
    ];
    const internal = /[<>]=?:|order_rate|_continue/;
    for (const condition of conditions) {
      const listed = classifyCondition(condition, derivedAt(9), { hasField: true });
      expect(listed.fidelity, condition.type).toBe('approximate');
      // 9 頭と 12 頭は注記から引いた境界の理由で、式で延ばした理由ではない。
      expect(listed.reason).toContain('注記からの読み取り');
      expect(listed.reason).not.toContain('式で延ばした');
      expect(classifyCondition(condition, derivedAt(12), { hasField: true }).reason).toBe(listed.reason);
      for (const gateCount of [2, 3, 10, 11, 13, 18]) {
        const extended = classifyCondition(condition, derivedAt(gateCount), { hasField: true });
        expect(extended.fidelity, `${condition.type} ${gateCount}`).toBe('approximate');
        expect(extended.reason, `${condition.type} ${gateCount}`).not.toBe(listed.reason);
        expect(extended.reason).toContain('9 頭立てと 12 頭立て以外では式で延ばした');
        expect(extended.reason).not.toMatch(internal);
        // フィールドが無ければ、頭数によらず落とす側のまま。
        expect(classifyCondition(condition, derivedAt(gateCount), { hasField: false }).fidelity).toBe(
          'dropped',
        );
      }
      // 頭数が 1〜18 の整数でなければ境界を決められないので落とす。理由に内部の値を出さない。
      const broken = classifyCondition(condition, derivedAt(19), { hasField: true });
      expect(broken.fidelity).toBe('dropped');
      expect(broken.reason).not.toMatch(internal);
      expect(broken.reason).not.toContain('19');
    }
  });

  /**
   * 9 頭と 12 頭で注記の表に無い値（docs/order-condition.md 2.2 節）。
   *
   * 式で埋めず、以前と同じく落とす側に置き、コンパイルは未対応として記録する。
   * データの取り直しで注記に無い値が増えたとき、skill-coverage.test.ts がこの記録で落ちる。
   * 理由の文は、以前と違って内部の鍵（`<=:35:9` の形）を出さない。
   */
  it('9 頭と 12 頭で表に無い順位率は、式で延ばさずに落とし、未対応として記録する', () => {
    const internal = /[<>]=?:|order_rate|_continue/;
    const cases = [
      new SkillCondition('order_rate', '<=', 35),
      new SkillCondition('order_rate', '>=', 35),
      new SkillCondition('order_rate', '<', 50),
    ];
    for (const gateCount of [9, 12]) {
      const setting = derivedAt(gateCount);
      for (const condition of cases) {
        const label = `${condition.operator} ${condition.value} ${gateCount}`;
        const note = classifyCondition(condition, setting, { hasField: true });
        expect(note.fidelity, label).toBe('dropped');
        expect(note.reason, label).not.toMatch(internal);
        expect(note.reason, label).not.toContain('式で延ばした');

        unsupportedConditions.clear();
        const predicate = compileConditions(
          named('末脚'),
          [[condition]],
          setting,
          new RngSet(1, 0),
          newSkillScratch(),
        );
        expect([...unsupportedConditions], label).toEqual([
          `order_rate ${condition.operator} ${condition.value} (${gateCount}頭)`,
        ]);
        // 満たしている前提のまま。順位によらず真になる。
        for (let order = 1; order <= gateCount; order++) {
          const state = { order, beforeStart: false } as unknown as Parameters<typeof predicate>[0];
          expect(predicate(state), `${label} ${order}`).toBe(true);
        }
      }
      // ほかの頭数では式で延ばすので、同じ条件でも落とさない。
      const extended = classifyCondition(cases[0]!, derivedAt(gateCount + 1), { hasField: true });
      expect(extended.fidelity).toBe('approximate');
    }
    unsupportedConditions.clear();
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

  it('9 頭と 12 頭以外でも、順位率は未対応として記録されない', () => {
    // 2〜18 頭は式で延ばした境界で判定する。分類が近似に置いているのと揃っていること。
    for (const gateCount of [2, 18]) {
      unsupportedConditions.clear();
      const setting = derivedAt(gateCount);
      const rng = new RngSet(1, 0);
      for (const skill of data.skills) {
        for (const invoke of skill.invokes) {
          const scratch = newSkillScratch();
          compileConditions(skill, invoke.preConditions, setting, rng, scratch);
          compileConditions(skill, invoke.conditions, setting, rng, scratch);
        }
      }
      const orderRate = [...unsupportedConditions].filter((entry) => entry.startsWith('order_rate'));
      expect(orderRate, String(gateCount)).toEqual([]);
    }
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
