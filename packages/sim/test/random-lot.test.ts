import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { RngSet } from '../src/rng.ts';
import { DerivedSetting, emptyPassiveBonus, type RaceSetting } from '../src/setting.ts';
import { compileConditions, newSkillScratch } from '../src/skill/condition.ts';
import { SkillData } from '../src/skill/types.ts';
import type { RaceState } from '../src/state.ts';

/**
 * `random_lot_shared`（当たり外れを 1 回だけ引いて使い回す条件）の検査。
 *
 * この条件を持つスキルは「勝負師」「やまっけ」「鉄火のギャンブラー」の 3 つで、
 * どれも発動すると passive でステータスが上がる。落としていたころは条件を
 * 満たした扱いになり、必ず発動していた。
 *
 * 条件そのものはレースの状態を見ないので（引いた結果を返すだけ）、組み立てた
 * 述語は状態なしで呼べる。種を変えて数えれば割合が測れる。
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

/** 状態を見ない述語なので、渡す状態は使われない。 */
const NO_STATE = undefined as unknown as RaceState;

const TRIALS = 2000;

function settingWith(popularity: number, fixRandom = false): RaceSetting {
  return {
    ...baseSetting,
    uma: { ...baseSetting.uma, popularity },
    skillActivateAdjustment: fixRandom ? 'ALL' : 'NONE',
  };
}

/** スキルの 1 つ目の枠（人気 4 番以下の枝）が、種を変えて何回成り立つか。 */
function hitRate(skillId: string, invokeIndex: number, setting: RaceSetting): number {
  const skill = data.skillsById.get(skillId)!;
  const invoke = skill.invokes[invokeIndex]!;
  let hit = 0;
  for (let trial = 0; trial < TRIALS; trial++) {
    const derived = new DerivedSetting(setting, emptyPassiveBonus(), data.trackData);
    const rng = new RngSet(1, trial);
    const predicate = compileConditions(
      skill,
      invoke.conditions,
      derived,
      rng,
      newSkillScratch(),
    );
    if (predicate(NO_STATE)) hit++;
  }
  return hit / TRIALS;
}

describe('当たり外れを共有する抽選', () => {
  it('勝負師は 4 番人気以下で 60%、3 番人気以内で 30% 当たる', () => {
    // 枠 0 が「人気>=4、確率 60」、枠 1 が「人気<=3、確率 30」。
    expect(hitRate('202441', 0, settingWith(6))).toBeCloseTo(0.6, 1);
    expect(hitRate('202441', 1, settingWith(1))).toBeCloseTo(0.3, 1);
  });

  it('やまっけは 30% と 15%', () => {
    expect(hitRate('202442', 0, settingWith(6))).toBeCloseTo(0.3, 1);
    expect(hitRate('202442', 1, settingWith(1))).toBeCloseTo(0.15, 1);
  });

  it('人気の枝が合わなければ、当たっても成り立たない', () => {
    // 6 番人気で「人気<=3」の枠を見る。抽選に当たっても人気で落ちる。
    expect(hitRate('202441', 1, settingWith(6))).toBe(0);
    expect(hitRate('202441', 0, settingWith(1))).toBe(0);
  });

  it('発動率を固定すると必ず当たる', () => {
    // 「スキル発動率を固定」は、この抽選も必ず当たる側に倒す（random_lot と同じ）。
    expect(hitRate('202441', 0, settingWith(6, true))).toBe(1);
  });

  it('同じスキルの中では 1 回しか引かない', () => {
    // 人気で排他になっていない形を組んで、共有されていることを直に見る。
    // 引き直していれば、2 つの枠の答えは種ごとにばらけて半分ほど食い違う。
    const raw = {
      id: '999999',
      name: '検査用',
      rarity: 'normal',
      group: 999999,
      type: 'speed',
      sp: 0,
      invokes: [0, 1].map((index) => ({
        skillId: '999999',
        index,
        conditions: [[{ type: 'random_lot_shared', operator: '==', value: 50 }]],
        effects: [{ type: 'passiveSpeed', value: 100000 }],
      })),
    };
    const skill = SkillData.fromRaw(raw as never);
    const setting = settingWith(1);
    let both = 0;
    let disagree = 0;
    for (let trial = 0; trial < TRIALS; trial++) {
      const derived = new DerivedSetting(setting, emptyPassiveBonus(), data.trackData);
      const rng = new RngSet(1, trial);
      const scratch = newSkillScratch();
      const first = compileConditions(skill, skill.invokes[0]!.conditions, derived, rng, scratch);
      const second = compileConditions(skill, skill.invokes[1]!.conditions, derived, rng, scratch);
      const a = first(NO_STATE);
      const b = second(NO_STATE);
      if (a !== b) disagree++;
      if (a) both++;
    }
    expect(disagree).toBe(0);
    // 50% の抽選なので、当たりはおよそ半分になる。
    expect(both / TRIALS).toBeCloseTo(0.5, 1);
  });
});
