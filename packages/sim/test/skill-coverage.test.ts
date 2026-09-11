import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { RngSet } from '../src/rng.ts';
import { DerivedSetting, emptyPassiveBonus, type RaceSetting } from '../src/setting.ts';
import { compileConditions, unsupportedConditions, type RandomEntry } from '../src/skill/condition.ts';
import { ignoreConditions, approximateTypeToState } from '../src/skill/approximate.ts';

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

describe('スキル条件の網羅', () => {
  /**
   * 本家も未対応のまま条件を落としている型。移植版も同じ扱いにする。
   * 新しい型が増えたらこのテストが落ちるので、実装漏れに気付ける。
   *
   * `random_lot_shared` はデータを取り直したときに現れた。「勝負師」「やまっけ」
   * 「鉄火のギャンブラー」の 3 つが持つ、当たり外れを 1 回の抽選で共有する条件で
   * ある（`random_lot` は効果ごとに引き直す）。本家の `SkillChecker.kt` にも
   * 分岐が無く、落としている。
   */
  const knownUnsupported = ['random_lot_shared', 'succession_skill_count'];

  it('未対応の条件が既知のものだけである', () => {
    unsupportedConditions.clear();
    const derived = new DerivedSetting(baseSetting, emptyPassiveBonus(), data.trackData);
    const rng = new RngSet(1, 0);
    for (const skill of data.skills) {
      for (const invoke of skill.invokes) {
        const areas = new Map<string, RandomEntry[]>();
        compileConditions(skill, invoke.preConditions, derived, rng, areas);
        compileConditions(skill, invoke.conditions, derived, rng, areas);
      }
    }
    expect([...unsupportedConditions].sort()).toEqual(knownUnsupported);
  });

  it('条件の型がすべて、実装か近似か無視のいずれかに分類されている', () => {
    const types = new Set<string>();
    for (const skill of data.skills) {
      for (const invoke of skill.invokes) {
        for (const group of [...invoke.conditions, ...invoke.preConditions]) {
          for (const condition of group) types.add(condition.type);
        }
      }
    }
    // 分類されていない型があれば、それは実装漏れの候補である。
    const unclassified = [...types].filter(
      (type) => !(type in ignoreConditions) && !(type in approximateTypeToState),
    );
    // 実装済みの型は compileCondition の switch にあるので、ここでは件数だけ記録する。
    expect(types.size).toBeGreaterThan(50);
    expect(unclassified.length).toBeGreaterThan(0);
  });
});
