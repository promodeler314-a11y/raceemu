import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { canTrigger, screenContext, screenSkills } from '../../solver/src/screen.ts';
import { RaceCalculator } from '../src/calculator.ts';
import { RngSet } from '../src/rng.ts';
import {
  DerivedSetting,
  defaultSystemSetting,
  emptyPassiveBonus,
  type RaceSetting,
} from '../src/setting.ts';
import { classifySkill } from '../src/skill/classify.ts';
import { compileConditions, newSkillScratch, unsupportedConditions } from '../src/skill/condition.ts';
import { SkillCondition, SkillData, SkillEffect, type RawSkillCondition, type RawSkillEffect } from '../src/skill/types.ts';
import type { RaceState } from '../src/state.ts';

/**
 * 本家の 2026-09-28 と 2026-11-16 の計算側の変更を固定する。
 *
 * 移植先と本家の対応:
 * - `succession_skill_count`（SkillChecker.kt）→ condition.ts
 * - `ignorePopularity`（SkillData.kt の `Invoke.isIgnorePopularity`、RaceCalculator.kt の
 *   `applyPassive`、SkillChecker.kt の `popularity`）→ types.ts、calculator.ts、condition.ts
 * - `is_activate_other_skill_detail` の値を枠の番号として読む（SkillChecker.kt）→ condition.ts
 * - 出走時スキルをクールダウンの記録に入れる時機（RaceCalculator.kt の `triggerStartSkills`）→ calculator.ts
 * - special 40 / 41 / 42（SkillData.kt）→ types.ts
 *
 * 参照値（golden）の作り直しとは別に、挙動の形だけをここで見る。
 */

const data = loadGameData();
const calculator = new RaceCalculator(defaultSystemSetting(), data.trackData);

/** 東京 芝2400m（中距離）。阪神 2200m でもロンシャンでもない。 */
const TOKYO_2400 = { location: 10006, course: 10606, condition: 1, gateCount: 9 };
/** 東京 芝1600m（マイル） */
const TOKYO_1600 = { location: 10006, course: 10602, condition: 1, gateCount: 9 };

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
  track: TOKYO_2400,
  skills: [],
  skillActivateAdjustment: 'NONE',
  randomPosition: 'RANDOM',
  debuffCounts: {},
  positionKeepMode: 'APPROXIMATE',
  positionKeepRate: 100,
};

function named(name: string): SkillData {
  const found = data.skillsByName.get(name);
  if (found === undefined) throw new Error(`スキルが見つからない: ${name}`);
  return found[0]!;
}

function settingWith(patch: Partial<RaceSetting>): RaceSetting {
  return { ...baseSetting, ...patch };
}

function derivedOf(setting: RaceSetting): DerivedSetting {
  return new DerivedSetting(setting, emptyPassiveBonus(), data.trackData);
}

/** 条件 1 つだけを組み立てる。 */
function compileOne(skill: SkillData, condition: SkillCondition, setting: RaceSetting) {
  return compileConditions(skill, [[condition]], derivedOf(setting), new RngSet(1, 0), newSkillScratch());
}

/** 試験用のスキル。枠ごとに条件と効果を渡す。 */
function customSkill(
  id: string,
  invokes: { conditions?: RawSkillCondition[][]; effects: RawSkillEffect[] }[],
): SkillData {
  return SkillData.fromRaw({
    id,
    name: `検査用${id}`,
    rarity: 'normal',
    group: Number(id),
    type: 'speed',
    sp: 0,
    activateLot: 0,
    invokes: invokes.map((invoke, i) => ({
      skillId: id,
      index: i + 1,
      conditions: invoke.conditions ?? [],
      effects: invoke.effects,
    })),
  });
}

describe('継承スキルの数（succession_skill_count、「連綿」）', () => {
  const inherits = data.skills.filter((skill) => skill.rarity === 'inherit').slice(0, 3);
  const special = data.skills.find((skill) => skill.rarity === 'special')!;
  const condition = new SkillCondition('succession_skill_count', '>=', 3);
  const renmen = named('連綿');
  const NO_STATE = undefined as unknown as RaceState;

  it('持っているスキルのうち rarity inherit の数で判定する', () => {
    expect(compileOne(renmen, condition, settingWith({ skills: inherits.slice(0, 2) }))(NO_STATE)).toBe(false);
    expect(compileOne(renmen, condition, settingWith({ skills: inherits }))(NO_STATE)).toBe(true);
  });

  it('継承進化（rarity special）と白は数えない（本家と同じ数え方）', () => {
    const skills = [...inherits.slice(0, 2), special, named('末脚')];
    expect(compileOne(renmen, condition, settingWith({ skills }))(NO_STATE)).toBe(false);
  });

  it('未対応として記録されず、分類も条件どおりになる', () => {
    unsupportedConditions.clear();
    compileOne(renmen, condition, baseSetting);
    expect([...unsupportedConditions]).toEqual([]);
    expect(classifySkill(renmen, derivedOf(baseSetting), { hasField: true }).fidelity).toBe('exact');
  });
});

describe('人気条件を無視する効果（ignorePopularity、「All-in!!」）', () => {
  const allIn = named('All-in!!');
  const gambler = named('勝負師');

  it('効果を持つのは 1 番の枠だけである', () => {
    expect(allIn.invokes.map((invoke) => invoke.isIgnorePopularity)).toEqual([true, false]);
    expect(gambler.invokes.some((invoke) => invoke.isIgnorePopularity)).toBe(false);
  });

  /**
   * 旗が立つと両方の枝が成り立つスキル。docs/race-emulator-analysis.md の列挙と揃える。
   * データの取り直しで増えたらここが落ちるので、文書の列挙も直す。
   */
  it('人気で二分された枝を持つスキルは、パッシブ 3 つとレース中の 2 種（固有と継承版）である', () => {
    const split = data.skills.filter(
      (skill) =>
        skill.invokes.filter((invoke) =>
          [...invoke.preConditions, ...invoke.conditions].flat().some((c) => c.type === 'popularity'),
        ).length >= 2,
    );
    const passive = split.filter((skill) => skill.invokes.every((invoke) => invoke.isPassive));
    const inRace = split.filter((skill) => !passive.includes(skill));
    expect(passive.map((s) => s.name).sort()).toEqual(['やまっけ', '勝負師', '鉄火のギャンブラー'].sort());
    expect(inRace.map((s) => `${s.name}|${s.rarity}`).sort()).toEqual(
      ['Go☆Go☆for it!|inherit', 'Go☆Go☆for it!|unique', '剣ヶ峰より、狂気に嗤え|inherit', '剣ヶ峰より、狂気に嗤え|unique'].sort(),
    );
    // レース中のほうは 2 つの枠が同じクールダウンの ID を持つので、先の枠だけが発動する。
    for (const skill of inRace) expect(new Set(skill.invokes.map((invoke) => invoke.coolDownId)).size).toBe(1);
  });

  it('人気の条件は、合っていれば常に真、合っていなければ旗を見る', () => {
    const condition = new SkillCondition('popularity', '>=', 4);
    const stateWith = (flag: boolean) => ({ simulation: { ignorePopularity: flag } }) as unknown as RaceState;
    const match = compileOne(gambler, condition, settingWith({ uma: { ...baseSetting.uma, popularity: 6 } }));
    expect(match(stateWith(false))).toBe(true);
    const mismatch = compileOne(gambler, condition, baseSetting);
    expect(mismatch(stateWith(false))).toBe(false);
    expect(mismatch(stateWith(true))).toBe(true);
  });

  /** 発動率を固定すると、勝負師の共有の抽選は必ず当たる。人気の枝だけが効く。 */
  function passiveOf(skills: SkillData[], track = TOKYO_2400) {
    const state = calculator.createState(
      settingWith({ skills, track, skillActivateAdjustment: 'ALL' }),
      { seed: 1, trial: 0 },
    );
    return {
      ignorePopularity: state.simulation.ignorePopularity,
      gamblerInvokes: state.setting.passiveBonus.skills
        .filter((skill) => skill.skill.id === gambler.id)
        .map((skill) => skill.invoke.index),
    };
  }

  it('持っていなければ旗は立たず、1 番人気では「人気<=3」の枠だけが乗る', () => {
    expect(passiveOf([gambler])).toEqual({ ignorePopularity: false, gamblerInvokes: [2] });
  });

  it('中距離で持っていれば旗が立ち、人気で排他だった 2 つの枠が両方乗る', () => {
    expect(passiveOf([allIn, gambler])).toEqual({ ignorePopularity: true, gamblerInvokes: [1, 2] });
  });

  it('本家と同じく conditions だけを見るので、阪神 2200m でもロンシャンでもない中距離で立つ', () => {
    // 説明文の「阪神 2200m かロンシャン」は preConditions にあり、本家の applyPassive は見ない。
    expect(passiveOf([allIn, gambler], TOKYO_2400).ignorePopularity).toBe(true);
  });

  it('中距離でなければ旗は立たない', () => {
    expect(passiveOf([allIn, gambler], TOKYO_1600)).toEqual({ ignorePopularity: false, gamblerInvokes: [2] });
  });

  /**
   * マイルでは「All-in!!」の 2 つの枠はどちらも条件（中距離）を満たさず、能力も旗も乗らない。
   * 持たせると旗の判定（applyPassive の冒頭の `check`）だけが走るので、出目が一致すれば
   * 旗の判定が他の乱数を動かしていないと言える。
   */
  it('旗の判定は乱数を引かない（旗の立たない「All-in!!」を足しても出目が変わらない）', () => {
    const mile = (skills: SkillData[]) => settingWith({ skills, track: TOKYO_1600 });
    for (const trial of [0, 7, 19]) {
      const option = { seed: 3, trial };
      const a = calculator.simulate(mile([named('末脚')]), option);
      const b = calculator.simulate(mile([allIn, named('末脚')]), option);
      expect(b.state.simulation.ignorePopularity).toBe(false);
      expect(b.result.raceTime).toBe(a.result.raceTime);
    }
  });

  it('旗が立たなければ、効かない人気条件のスキルを足しても差が 0 になる', () => {
    const mile = (skills: SkillData[]) => settingWith({ skills, track: TOKYO_1600 });
    const option = { seed: 3, trial: 7 };
    const a = calculator.simulate(mile([allIn, named('末脚')]), option);
    const b = calculator.simulate(mile([allIn, named('末脚'), named('伏兵○')]), option);
    expect(b.result.raceTime).toBe(a.result.raceTime);
  });
});

describe('走らせずに落とす判定と人気', () => {
  const ambush = named('伏兵○');
  const allIn = named('All-in!!');
  const derived = derivedOf(baseSetting);

  it('前提: 伏兵○は人気の条件を持ち、1 番人気では合わない', () => {
    const popularity = ambush.invokes.flatMap((invoke) =>
      [...invoke.preConditions, ...invoke.conditions].flat().filter((c) => c.type === 'popularity'),
    );
    expect(popularity.length).toBeGreaterThan(0);
    expect(popularity.some((c) => !c.check(1))).toBe(true);
  });

  it('人気を無視させる効果が無ければ、従来どおり人気で落とす', () => {
    expect(canTrigger(ambush, derived)).toBe(false);
    expect(screenSkills([ambush, named('末脚')], derived).map((s) => s.name)).toEqual(['末脚']);
  });

  it('候補に「All-in!!」があれば、中距離では人気で落とさない（落としたものは確かに発動しない、を守る）', () => {
    expect(screenSkills([ambush, allIn], derived).map((s) => s.name)).toContain('伏兵○');
    expect(canTrigger(ambush, derived, screenContext(derived, [allIn]))).toBe(true);
  });

  it('持っているスキルに「All-in!!」があれば、1 つだけ足す判定でも落とさない', () => {
    const owning = derivedOf(settingWith({ skills: [allIn] }));
    expect(canTrigger(ambush, owning)).toBe(true);
  });

  it('マイルでは「All-in!!」の旗が立たないので、一緒でも人気で落とす', () => {
    const mile = derivedOf(settingWith({ track: TOKYO_1600 }));
    expect(canTrigger(ambush, mile, screenContext(mile, [allIn]))).toBe(false);
  });
});

describe('同じスキルの別の枠の発動（is_activate_other_skill_detail）', () => {
  // 1 番の枠は無条件、2 番は「1 番が発動した」、3 番は「2 番が発動した」。
  const skill = customSkill('990001', [
    { effects: [{ type: 'targetSpeed', value: 1000 }] },
    {
      conditions: [[{ type: 'is_activate_other_skill_detail', operator: '==', value: 1 }]],
      effects: [{ type: 'targetSpeed', value: 2000 }],
    },
    {
      conditions: [[{ type: 'is_activate_other_skill_detail', operator: '==', value: 2 }]],
      effects: [{ type: 'targetSpeed', value: 3000 }],
    },
  ]);
  const stateWith = (ids: string[]) =>
    ({ simulation: { coolDownMap: new Map(ids.map((id) => [id, 0])) } }) as unknown as RaceState;

  it('この条件を持つ枠のクールダウンの ID は「スキル ID-枠の番号」になる', () => {
    expect(skill.invokes.map((invoke) => invoke.coolDownId)).toEqual(['990001', '990001-2', '990001-3']);
  });

  it('値を枠の番号として読み、その枠のクールダウンの ID を見る', () => {
    unsupportedConditions.clear();
    const second = compileConditions(skill, skill.invokes[2]!.conditions, derivedOf(baseSetting), new RngSet(1, 0), newSkillScratch());
    expect([...unsupportedConditions]).toEqual([]);
    expect(second(stateWith(['990001']))).toBe(false);
    expect(second(stateWith(['990001-2']))).toBe(true);
    const first = compileConditions(skill, skill.invokes[1]!.conditions, derivedOf(baseSetting), new RngSet(1, 0), newSkillScratch());
    expect(first(stateWith(['990001']))).toBe(true);
  });

  it('枠が見つからなければスキル ID を見る', () => {
    const missing = compileOne(skill, new SkillCondition('is_activate_other_skill_detail', '==', 9), baseSetting);
    expect(missing(stateWith(['990001']))).toBe(true);
    expect(missing(stateWith(['990001-3']))).toBe(false);
  });
});

describe('出走時に発動するスキルのクールダウン', () => {
  it('同じスキルのパッシブの枠が 2 つ乗っても、出走時の発動は 1 回である', () => {
    const skill = customSkill('990002', [
      { effects: [{ type: 'passiveSpeed', value: 100000 }] },
      { effects: [{ type: 'passiveSpeed', value: 100000 }] },
    ]);
    const state = calculator.createState(settingWith({ skills: [skill] }), { seed: 1, trial: 0 });
    // 能力加算は枠ごとのまま（本家も同じ）。
    expect(state.setting.passiveBonus.skills.length).toBe(2);
    expect(state.setting.passiveBonus.speed).toBe(20);
    expect(state.simulation.passiveTriggered).toBe(2);
    // 発動として数えるのは 1 回だけ。
    expect(state.simulation.lastFrame!.triggeredSkills.map((t) => t.invoke.invoke.index)).toEqual([1]);
    expect(state.simulation.skillTriggerCount.total).toBe(1);
    expect(state.simulation.coolDownMap.get('990002')).toBe(0);
  });

  it('出遅れ系の枠が 2 つあっても、倍率は 1 回しか掛からない', () => {
    const effect = { type: 'startMultiply', value: 5000 };
    const once = customSkill('990003', [{ effects: [effect] }]);
    const twice = customSkill('990003', [{ effects: [effect] }, { effects: [effect] }]);
    const delayOf = (skill: SkillData) =>
      calculator.createState(settingWith({ skills: [skill] }), { seed: 5, trial: 11 }).simulation.startDelay;
    expect(delayOf(twice)).toBe(delayOf(once));
    const none = calculator.createState(baseSetting, { seed: 5, trial: 11 }).simulation.startDelay;
    expect(delayOf(once)).toBeCloseTo(none * 0.5, 12);
  });
});

describe('効果値の special 40 / 41 / 42', () => {
  const stateAt = (distanceType: number) =>
    ({ setting: { trackDetail: { distanceType } } }) as unknown as RaceState;

  it('40 と 41 は 1.2 倍で固定する', () => {
    expect(new SkillEffect('targetSpeed', 3500, 40).calcValue(stateAt(1))).toBeCloseTo(4200, 9);
    expect(new SkillEffect('targetSpeed', 3500, 41).calcValue(stateAt(4))).toBeCloseTo(4200, 9);
  });

  it('42 はマイルか中距離なら 500 足す（灰雪の冠）', () => {
    const effect = new SkillEffect('targetSpeed', 3500, 42);
    expect([1, 2, 3, 4].map((type) => effect.calcValue(stateAt(type)))).toEqual([3500, 4000, 4000, 3500]);
  });
});

describe('灰雪の冠の連鎖（is_activate_other_skill_detail を実データで）', () => {
  /** 発動した枠の番号を、試行ごとに集める。 */
  function firedInvokes(skill: SkillData, trial: number): number[] {
    const { state } = calculator.simulate(settingWith({ skills: [skill] }), { seed: 11, trial, recordFrames: true });
    const seen = new Set<number>();
    for (const frame of state.simulation.frames) {
      for (const triggered of frame.triggeredSkills) {
        if (triggered.invoke.skill.id === skill.id) seen.add(triggered.invoke.invoke.index);
      }
    }
    return [...seen].sort((a, b) => a - b);
  }

  const phaseLaterHalfTurf: RawSkillCondition[][] = [
    [
      { type: 'phase_laterhalf', operator: '==', value: 1 },
      { type: 'ground_type', operator: '==', value: 1 },
    ],
  ];
  const effects: RawSkillEffect[] = [{ type: 'targetSpeed', value: 2500, special: 42 }];

  /** 本家 2026-11-16（e9bb2939）のデータの固有「灰雪の冠」の形。3 番の枠が 2 番の発動を見る。 */
  function haiyuki(secondRate: [number, number]): SkillData {
    return SkillData.fromRaw({
      id: '100751',
      name: '灰雪の冠',
      rarity: 'unique',
      group: 10075,
      type: 'speed',
      activateLot: 0,
      invokes: [
        { skillId: '100751', index: 1, conditions: phaseLaterHalfTurf, effects, duration: 3.0 },
        {
          skillId: '100751',
          index: 2,
          conditions: [
            [
              { type: 'is_activate_other_skill_detail', operator: '==', value: 1 },
              { type: 'distance_rate', operator: '>=', value: secondRate[0] },
              { type: 'distance_rate', operator: '<=', value: secondRate[1] },
            ],
          ],
          effects,
          duration: 3.0,
        },
        {
          skillId: '100751',
          index: 3,
          conditions: [
            [
              { type: 'is_activate_other_skill_detail', operator: '==', value: 2 },
              { type: 'phase', operator: '==', value: 3 },
            ],
          ],
          effects,
          duration: 3.0,
        },
      ],
    });
  }

  it('手元のデータの灰雪の冠は、どの枠も毎回発動する', () => {
    const skill = data.skills.find((s) => s.id === '100751')!;
    const all = skill.invokes.map((invoke) => invoke.index);
    for (const trial of [0, 1, 2, 3, 4]) expect(firedInvokes(skill, trial)).toEqual(all);
  });

  it('本家の 3 段の形では、3 つの枠が順に発動する', () => {
    for (const trial of [0, 1, 2, 3, 4]) expect(firedInvokes(haiyuki([50, 51]), trial)).toEqual([1, 2, 3]);
  });

  it('2 番の枠が発動しなければ、3 番の枠も発動しない（値をスキル ID ではなく枠の番号として読む）', () => {
    // 2 番の枠の区間を、来ない距離割合にする。値をスキル ID として読むと 3 番は 1 番の発動で通ってしまう。
    for (const trial of [0, 1, 2]) expect(firedInvokes(haiyuki([200, 201]), trial)).toEqual([1]);
  });
});
