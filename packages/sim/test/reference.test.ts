import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/index.ts';
import { RaceCalculator } from '../src/calculator.ts';
import { getWisdomSkillBuff } from '../src/data/constants.ts';
import {
  DerivedSetting,
  defaultSystemSetting,
  emptyPassiveBonus,
  type RaceSetting,
} from '../src/setting.ts';
import { runSimulations } from '../src/summary.ts';

/**
 * 本家 mee1080/umasim を JVM で実行して得た参照値との突き合わせ。
 * 参照値の生成方法は test/golden/README.md にある。
 */

interface Reference {
  readonly derived: Record<string, number | number[]>;
  readonly times: Record<string, number>;
}

const goldenPath = join(dirname(fileURLToPath(import.meta.url)), 'golden', 'umasim-reference.json');
const reference = JSON.parse(readFileSync(goldenPath, 'utf8')) as Record<string, Reference>;

const data = loadGameData();

/** 参照値と同じ順序で選ぶ。名前が重複する場合は先頭を使う。 */
const referenceSkillNames = [
  '弧線のプロフェッサー',
  '円弧のマエストロ',
  '府中の申し子',
  '根幹距離◎',
  'ノンストップガール',
  '火事場のバ鹿力',
];
const referenceSkills = referenceSkillNames.map((name) => {
  const found = data.skillsByName.get(name);
  if (found === undefined || found.length === 0) throw new Error(`スキルが見つからない: ${name}`);
  return found[0]!;
});

const settings: Record<string, RaceSetting> = {
  A_tokyo2400_sen: {
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
  },
  B_sapporo1200_nige: {
    uma: {
      charaName: 'T',
      speed: 1400,
      stamina: 800,
      power: 1100,
      guts: 700,
      wisdom: 1000,
      condition: 'BEST',
      style: 'NIGE',
      distanceFit: 'A',
      surfaceFit: 'A',
      styleFit: 'A',
      popularity: 1,
      gateNumber: 3,
      uniqueLevel: 6,
    },
    track: { location: 10001, course: 10101, condition: 1, gateCount: 9 },
    skills: [],
    skillActivateAdjustment: 'NONE',
    randomPosition: 'RANDOM',
    debuffCounts: {},
    positionKeepMode: 'APPROXIMATE',
    positionKeepRate: 100,
  },
};

settings['C_tokyo2400_sen_skills'] = {
  ...settings['A_tokyo2400_sen']!,
  skills: referenceSkills,
};

function derivedValues(setting: RaceSetting): Record<string, number | number[]> {
  // 参照値は PassiveBonus() 無しで出力しているため、こちらも passive 無しで比較する。
  const s = new DerivedSetting(setting, emptyPassiveBonus(), data.trackData);
  const uma = setting.uma;
  const a1 =
    0.0006 *
    Math.sqrt(500.0 * s.modifiedPower) *
    s.styleAccelerateCoefFor(0) *
    ({ S: 1.05, A: 1.0, B: 0.9, C: 0.8, D: 0.7, E: 0.5, F: 0.3, G: 0.1 } as const)[uma.surfaceFit] *
    ({ S: 1.0, A: 1.0, B: 1.0, C: 1.0, D: 1.0, E: 0.6, F: 0.5, G: 0.4 } as const)[uma.distanceFit];
  const buff = getWisdomSkillBuff(
    Math.trunc(uma.wisdom * ({ BEST: 1.04, GOOD: 1.02, NORMAL: 1.0, BAD: 0.98, WORST: 0.96 } as const)[uma.condition]),
    s.basicRunningStyle,
  );
  return {
    courseLength: s.courseLength,
    baseSpeed: s.baseSpeed,
    modifiedSpeed: s.modifiedSpeed,
    modifiedStamina: s.modifiedStamina,
    modifiedPower: s.modifiedPower,
    modifiedGuts: s.modifiedGuts,
    modifiedWisdom: s.modifiedWisdom,
    spMax: s.spMax,
    spurtSpCoef: s.spurtSpCoef,
    temptationRate: s.temptationRate,
    maxSpurtSpeed: s.maxSpurtSpeed,
    v0: s.v0,
    v1: s.v1,
    v2: s.v2,
    v3: s.v3,
    vMinBase: s.vMinBase,
    a0: 24.0 + a1,
    a1,
    a2: s.v2 < s.v1 ? -0.8 : (a1 / s.styleAccelerateCoefFor(0)) * s.styleAccelerateCoefFor(1),
    a3: (a1 / s.styleAccelerateCoefFor(0)) * s.styleAccelerateCoefFor(2),
    leadCompetitionSpeed: s.leadCompetitionSpeed,
    leadCompetitionFrame: s.leadCompetitionFrame,
    competeFightSpeed: s.competeFightSpeed,
    competeFightAcceleration: s.competeFightAcceleration,
    conservePowerAccelerationBase: s.conservePowerAccelerationBase,
    conservePowerFrame: s.conservePowerFrame,
    positionCompetitionSpeed: s.positionCompetitionSpeed,
    positionCompetitionStamina: s.positionCompetitionStamina,
    secureLeadSpeed: s.secureLeadSpeed,
    secureLeadStamina: s.secureLeadStamina,
    staminaLimitBreakSpeed: s.staminaLimitBreakSpeed,
    baseLaneChangeTargetSpeed: s.baseLaneChangeTargetSpeed,
    positionKeepMinDistance: s.positionKeepMinDistance,
    positionKeepMaxDistance: s.positionKeepMaxDistance,
    coolDownBaseFrames: s.coolDownBaseFrames,
    skillActivateRate: s.skillActivateRate,
    wisdomSkillBuff: [buff[0]!, buff[1]!, buff[2]!, buff[3]!],
  };
}

describe('本家との突き合わせ', () => {
  for (const [label, setting] of Object.entries(settings)) {
    const ref = reference[label]!;

    it(`${label}: 導出値が一致する`, () => {
      const actual = derivedValues(setting);
      for (const [key, expected] of Object.entries(ref.derived)) {
        const got = actual[key];
        expect(got, `${key} が参照値に無い`).toBeDefined();
        if (Array.isArray(expected)) {
          expect(got as number[], key).toEqual(expected);
        } else {
          expect(got as number, key).toBeCloseTo(expected, 9);
        }
      }
    });

    it(`${label}: タイムの分布が一致する`, () => {
      // 既定は 5000 回。REFERENCE_TRIALS で増やせる。
      const count = Number(process.env['REFERENCE_TRIALS'] ?? 5000);
      const { summary } = runSimulations(setting, defaultSystemSetting(), data.trackData, {
        count,
        seed: 20260904,
      });
      // 両者は乱数列が異なるため、平均の差が標準誤差の範囲に収まることを見る。
      const refStdErr = ref.times['stderr']!;
      const ownStdErr = ref.times['sd']! / Math.sqrt(count);
      const tolerance = 4 * Math.sqrt(refStdErr ** 2 + ownStdErr ** 2);
      expect(Math.abs(summary.all.averageTime - ref.times['mean']!)).toBeLessThan(tolerance);
      expect(Math.abs(summary.spurtRate - ref.times['maxSpurtRate']!)).toBeLessThan(0.02);
      expect(Math.abs(summary.finishRate - ref.times['finishRate']!)).toBeLessThan(0.02);
    });
  }
});

describe('シードによる再現性', () => {
  it('同じシードなら同じ結果になる', () => {
    const calculator = new RaceCalculator(defaultSystemSetting(), data.trackData);
    const setting = settings['A_tokyo2400_sen']!;
    const a = calculator.simulate(setting, { seed: 42, trial: 7 }).result;
    const b = calculator.simulate(setting, { seed: 42, trial: 7 }).result;
    expect(a.raceTime).toBe(b.raceTime);
    const c = calculator.simulate(setting, { seed: 42, trial: 8 }).result;
    expect(c.raceTime).not.toBe(a.raceTime);
  });
});
