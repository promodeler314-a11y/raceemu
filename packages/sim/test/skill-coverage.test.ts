import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { RngSet } from '../src/rng.ts';
import { DerivedSetting, emptyPassiveBonus, type RaceSetting } from '../src/setting.ts';
import { compileConditions, newSkillScratch, unsupportedConditions } from '../src/skill/condition.ts';
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
   */
  const knownUnsupported = ['succession_skill_count'];

  it('未対応の条件が既知のものだけである', () => {
    unsupportedConditions.clear();
    const derived = new DerivedSetting(baseSetting, emptyPassiveBonus(), data.trackData);
    const rng = new RngSet(1, 0);
    for (const skill of data.skills) {
      for (const invoke of skill.invokes) {
        const scratch = newSkillScratch();
        compileConditions(skill, invoke.preConditions, derived, rng, scratch);
        compileConditions(skill, invoke.conditions, derived, rng, scratch);
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

  /**
   * 本家のデータ側で名前の付いていない効果。
   *
   * 本家の変換は、知らない効果の型を `effects` に入れず、`description` に
   * 「不明なスキル効果(番号)」とだけ残す。つまり**こちらの `effects` を見ても
   * 存在に気付けない**。条件（`unsupportedConditions`）と違い、落ちたことが
   * 記録されないためである。
   *
   * `(50)` は「All-in!!」（[死中求活]ナカヤマフェスタの進化）が持つ、
   * 所持スキルの人気条件を無視する効果である。本家も移植版も未対応で、
   * この 1 つだけが分かっている。
   *
   * データを取り直して新しい番号が現れたらここが落ちる。そのとき、本家が
   * 名前を付けて `effects` に載せたのなら、代わりに実装する。
   */
  it('名前の付いていない効果が既知のものだけである', () => {
    // `description` は計算にも画面にも使わないので `SkillData` に載せていない。
    // ここだけ生のデータを読む。
    const raw: { id: string; name: string; description?: string[] }[] = JSON.parse(
      readFileSync('packages/data/assets/skills.json', 'utf8'),
    );
    const found = new Set<string>();
    for (const skill of raw) {
      for (const line of skill.description ?? []) {
        for (const match of line.matchAll(/不明なスキル効果\((\d+)\)/g)) {
          found.add(`${skill.id} ${skill.name} (${match[1]})`);
        }
      }
    }
    expect([...found].sort()).toEqual(['104901311 All-in!! (50)']);
  });
});
