import { describe, expect, it } from 'vitest';
import { loadDeckData } from '../../data/src/deck-node.ts';
import { charaSkills, supportHint } from '../../data/src/deck.ts';
import { loadGameData } from '../../data/src/node.ts';
import { RaceCalculator } from '../src/calculator.ts';
import { nodeWorkerFactory } from '../src/parallel/node.ts';
import { WorkerPool } from '../src/parallel/pool.ts';
import { toSerializable } from '../src/parallel/protocol.ts';
import {
  DerivedSetting,
  defaultSystemSetting,
  emptyPassiveBonus,
  type RaceSetting,
} from '../src/setting.ts';
import { buildPlanCandidates } from '../../solver/src/candidates.ts';
import { createCostModel } from '../../solver/src/cost.ts';
import { canTrigger, dependsOnlyOnIgnored, screenSkills } from '../../solver/src/screen.ts';
import { optimizeSkills, type OptimizeContext } from '../../solver/src/optimize.ts';

const data = loadGameData();
const deck = loadDeckData();
const system = defaultSystemSetting();
const track = { location: 10006, course: 10606, condition: 1, gateCount: 9 } as const;

const skill = (name: string) => {
  const found = data.skillsByName.get(name)?.[0];
  if (found === undefined) throw new Error(`スキルが見つからない: ${name}`);
  return found;
};

/** 東京 芝2400m（左回り、中距離）を先行で走る。 */
const setting: RaceSetting = {
  uma: {
    charaName: '', speed: 1200, stamina: 1000, power: 900, guts: 600, wisdom: 900,
    condition: 'BEST', style: 'SEN', distanceFit: 'A', surfaceFit: 'A', styleFit: 'A',
    popularity: 1, gateNumber: 5, uniqueLevel: 6,
  },
  track, skills: [],
  skillActivateAdjustment: 'NONE', randomPosition: 'RANDOM',
  debuffCounts: {}, positionKeepMode: 'APPROXIMATE', positionKeepRate: 100,
};

const derived = new DerivedSetting(setting, emptyPassiveBonus(), data.trackData);

describe('静的な絞り込み', () => {
  it('コースと脚質が噛み合わないスキルを落とす', () => {
    expect(canTrigger(skill('左回り○'), derived)).toBe(true);
    expect(canTrigger(skill('右回り○'), derived)).toBe(false);
    expect(canTrigger(skill('中距離直線○'), derived)).toBe(true);
    expect(canTrigger(skill('短距離直線○'), derived)).toBe(false);
    expect(canTrigger(skill('先行のコツ○'), derived)).toBe(true);
    expect(canTrigger(skill('逃げのコツ○'), derived)).toBe(false);
  });

  it('買えるスキルの半分ほどが落ちる', () => {
    const purchasable = data.skills.filter((s) => s.sp > 0);
    const alive = screenSkills(purchasable, derived);
    // 数そのものはデータ次第で動くので、桁が変わったときだけ落ちればよい。
    expect(alive.length).toBeGreaterThan(purchasable.length * 0.3);
    expect(alive.length).toBeLessThan(purchasable.length * 0.8);
  });

  /**
   * 落としたものが本当に発動しないことを、実際に走らせて確かめる。
   *
   * 判定は片側だけ確かである。残したものが発動するとは限らないので、
   * 逆向き（残したものが発動する）は確かめられない。
   */
  it('落としたスキルは実際に 1 度も発動しない', () => {
    const rejected = data.skills
      .filter((s) => s.sp > 0 && !canTrigger(s, derived))
      .slice(0, 60);
    expect(rejected.length).toBe(60);
    const calculator = new RaceCalculator(system, data.trackData);
    for (let trial = 0; trial < 3; trial++) {
      const { state } = calculator.simulate(
        { ...setting, skills: rejected },
        { seed: 1234, trial },
      );
      const fired = [...state.simulation.skillTrace.keys()];
      expect(fired).toEqual([]);
    }
  });
});

describe('季節と天候と時刻', () => {
  /**
   * 本家はこの 3 つを「満たしている前提」で落としている。
   * 候補が 20 個のうちは表に出なかったが、育成計画から数百個に広げると、
   * 春夏秋冬のスキルが全部同時に発動して並ぶ。
   * 指定があるときだけ判定し、省いたときは本家と同じ扱いを残す。
   */
  const withTrack = (extra: Partial<RaceSetting['track']>): DerivedSetting =>
    new DerivedSetting(
      { ...setting, track: { ...setting.track, ...extra } },
      emptyPassiveBonus(),
      data.trackData,
    );
  const buyable = (name: string) => {
    const found = data.skillsByName.get(name)?.find((s) => s.sp > 0);
    if (found === undefined) throw new Error(`買えるスキルが見つからない: ${name}`);
    return found;
  };
  const seasons = ['春ウマ娘○', '夏ウマ娘○', '秋ウマ娘○', '冬ウマ娘○'].map(buyable);

  it('指定が無ければ本家と同じく、春夏秋冬が同時に発動しうる', () => {
    const derived = withTrack({});
    for (const skill of seasons) expect(canTrigger(skill, derived)).toBe(true);
  });

  it('季節を指定すると、その季節のものだけが残る', () => {
    const derived = withTrack({ season: 2 });
    expect(seasons.filter((s) => canTrigger(s, derived)).map((s) => s.name)).toEqual(['夏ウマ娘○']);
  });

  it('天候と時刻も同じように効く', () => {
    const derived = withTrack({ weather: 3, time: 1 });
    expect(canTrigger(buyable('雨の日○'), derived)).toBe(true);
    expect(canTrigger(buyable('晴れの日○'), derived)).toBe(false);
    expect(canTrigger(buyable('ナイター○'), derived)).toBe(false);
    expect(canTrigger(buyable('ナイター○'), withTrack({ time: 4 }))).toBe(true);
  });

  it('指定すると候補が減る', () => {
    const pool = data.skills.filter((s) => s.sp > 0);
    const loose = screenSkills(pool, withTrack({})).length;
    const tight = screenSkills(pool, withTrack({ season: 1, weather: 1, time: 1 })).length;
    expect(tight).toBeLessThan(loose);
  });
});

describe('入手経路からの候補', () => {
  const chara = deck.charas.find((c) => c.name.includes('スペシャルウィーク'))!;

  it('デッキもウマ娘も無ければ、白と固有の継承版だけが開く', () => {
    const plan = buildPlanCandidates(data.skills, data.skillsByName, deck, derived, {});
    expect(plan.countByRoute.chara).toBe(0);
    expect(plan.countByRoute.hint).toBe(0);
    expect(plan.countByRoute.inherit).toBeGreaterThan(100);
    expect(plan.countByRoute.inheritedUnique).toBeGreaterThan(100);
    expect(plan.alwaysSkillIds).toEqual([]);
    // 金は育成ウマ娘が覚えるものだけなので、ここには出てこない。
    expect(plan.entries.some((e) => e.rarity === 'rare')).toBe(false);
  });

  it('育成ウマ娘の固有は候補ではなく、最初から持っているものになる', () => {
    const plan = buildPlanCandidates(data.skills, data.skillsByName, deck, derived, {
      charaId: chara.id,
    });
    expect(plan.alwaysSkillIds.length).toBe(1);
    const unique = data.skillsById.get(plan.alwaysSkillIds[0]!)!;
    expect(unique.rarity).toBe('unique');
    expect(unique.holder).toBe(chara.name);
    expect(plan.skillIds).not.toContain(unique.id);
  });

  it('覚醒ランクを下げると、ウマ娘から来る候補が減る', () => {
    const top = buildPlanCandidates(data.skills, data.skillsByName, deck, derived, {
      charaId: chara.id,
    });
    const low = buildPlanCandidates(data.skills, data.skillsByName, deck, derived, {
      charaId: chara.id,
      charaRank: 1,
    });
    expect(low.countByRoute.chara).toBeLessThan(top.countByRoute.chara);
  });

  it('ヒントを持つカードを入れると、そのスキルだけ安くなる', () => {
    const card = deck.supports.find((c) => c.skills.includes('末脚'))!;
    const target = skill('末脚');
    const plain = buildPlanCandidates(data.skills, data.skillsByName, deck, derived, {});
    const withCard = buildPlanCandidates(data.skills, data.skillsByName, deck, derived, {
      cards: [{ id: card.id }],
    });
    const before = plain.entries.find((e) => e.skillId === target.id)!;
    const after = withCard.entries.find((e) => e.skillId === target.id)!;
    expect(before.route).toBe('inherit');
    expect(after.route).toBe('hint');
    expect(after.cost).toBeLessThan(before.cost);
    expect(withCard.hintLevels[target.id]).toBeGreaterThan(0);

    // 割引は費用モデルにそのまま渡せる。
    const model = createCostModel(data.skillsById, { hintLevels: withCard.hintLevels });
    expect(model.cost(target.id)).toBe(after.cost);
  });
});

describe('判定できない条件しか持たないスキル', () => {
  /**
   * 順位や他のウマ娘の顔ぶれに依る条件は「満たしている前提」で落とされるので、
   * それしか条件を持たないスキルは必ず発動する扱いになる。
   * おひとり様（同じ作戦がいない）と対抗意識（同じ作戦が多い）が同時に積まれる。
   */
  const buyable = (name: string) => {
    const found = data.skillsByName.get(name)?.find((s) => s.sp > 0);
    if (found === undefined) throw new Error(`買えるスキルが見つからない: ${name}`);
    return found;
  };

  it('同時には成り立たない組を見分ける', () => {
    expect(dependsOnlyOnIgnored(buyable('おひとり様○'), derived)).toBe(true);
    expect(dependsOnlyOnIgnored(buyable('対抗意識○'), derived)).toBe(true);
    expect(dependsOnlyOnIgnored(buyable('一匹狼'), derived)).toBe(true);
    // 位置や区間の条件を持つものは外さない
    expect(dependsOnlyOnIgnored(buyable('中距離直線○'), derived)).toBe(false);
    expect(dependsOnlyOnIgnored(buyable('末脚'), derived)).toBe(false);
  });

  it('季節を指定すれば、季節のスキルは外れない', () => {
    const withSeason = new DerivedSetting(
      { ...setting, track: { ...setting.track, season: 1 } },
      emptyPassiveBonus(),
      data.trackData,
    );
    expect(dependsOnlyOnIgnored(buyable('春ウマ娘○'), derived)).toBe(true);
    expect(dependsOnlyOnIgnored(buyable('春ウマ娘○'), withSeason)).toBe(false);
  });

  it('既定では候補から外れ、指定すれば入る', () => {
    const off = buildPlanCandidates(data.skills, data.skillsByName, deck, derived, {});
    const on = buildPlanCandidates(data.skills, data.skillsByName, deck, derived, {}, {
      includeIgnoredOnly: true,
    });
    const solo = buyable('おひとり様○').id;
    expect(off.skillIds).not.toContain(solo);
    expect(on.skillIds).toContain(solo);
    expect(off.droppedByIgnored).toContain(solo);
    expect(on.droppedByIgnored).toEqual([]);
    expect(off.skillIds.length).toBeLessThan(on.skillIds.length);
  });
});

describe('サポートカードと育成ウマ娘のデータ', () => {
  it('すべての育成ウマ娘の固有スキルを名前で引ける', () => {
    const holders = new Set(
      data.skills.filter((s) => s.rarity === 'unique' && s.holder !== null).map((s) => s.holder),
    );
    const missing = deck.charas.filter((chara) => !holders.has(chara.name));
    expect(missing.map((c) => c.name)).toEqual([]);
  });

  it('覚醒ランクごとのスキルは前方一致で増える', () => {
    for (const chara of deck.charas) {
      expect(charaSkills(chara, 1).length).toBeLessThanOrEqual(charaSkills(chara, 5).length);
      expect(charaSkills(chara, 5)).toEqual(chara.skills);
      expect(charaSkills(chara)).toEqual(chara.skills);
    }
  });

  it('凸を省くと完凸のヒントレベルになる', () => {
    const card = deck.supports.find((c) => c.hints.length === 5)!;
    expect(supportHint(card, 4)).toEqual(card.hints[4]);
    expect(supportHint(card, 99)).toEqual(card.hints[4]);
    expect(supportHint(card, 0)).toEqual(card.hints[0]);
  });

  /**
   * サポートカードのヒントに金スキルが 1 つも無い。
   *
   * 実機がそうなのか、本家のデータが白に限られているのかは分かっていない
   * （docs/solver-design.md 8 節）。金が現れたらここが落ちるので、そのとき
   * 候補の組み立てに金の経路を足す。
   */
  it('カードのヒントは白だけである', () => {
    const rare = new Set(
      data.skills.filter((s) => s.rarity === 'rare' && s.sp > 0).map((s) => s.name),
    );
    const found = deck.supports.flatMap((card) => card.skills.filter((name) => rare.has(name)));
    expect([...new Set(found)]).toEqual([]);
  });
});

describe('固有の継承版の上限', () => {
  it('予算が足りていても 6 つまでしか積まない', async () => {
    const inherited = screenSkills(
      data.skills.filter((s) => s.rarity === 'inherit'),
      derived,
    ).slice(0, 9);
    expect(inherited.length).toBe(9);

    const pool = new WorkerPool(nodeWorkerFactory);
    try {
      const context: OptimizeContext = {
        pool,
        system,
        base: toSerializable(setting),
        cost: createCostModel(data.skillsById),
        seed: 20260911,
        field: null,
      };
      const result = await optimizeSkills(context, {
        // 9 つ全部でも 1800 pt なので、予算では縛られない。
        candidates: inherited.map((s) => s.id),
        budget: 5000,
        stages: [100, 200],
        maxRounds: 2,
        measurePositionCompetition: false,
      });
      expect(result.best.length).toBeLessThanOrEqual(6);
      for (const entry of result.top) {
        expect(entry.skillIds.length).toBeLessThanOrEqual(6);
      }
    } finally {
      await pool.dispose();
    }
  });
});
