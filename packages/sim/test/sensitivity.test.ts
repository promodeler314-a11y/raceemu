import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { RaceCalculator } from '../src/calculator.ts';
import { nodeWorkerFactory } from '../src/parallel/node.ts';
import { WorkerPool } from '../src/parallel/pool.ts';
import { toSerializable } from '../src/parallel/protocol.ts';
import { defaultSystemSetting, type RaceSetting } from '../src/setting.ts';
import type { SkillData } from '../src/skill/types.ts';
import { createCostModel } from '../../solver/src/cost.ts';
import type { OptimizeContext } from '../../solver/src/optimize.ts';
import { dependsOnApproximate, measureSensitivity } from '../../solver/src/sensitivity.ts';

/**
 * 近似確率の感度分析。
 *
 * 見張るのは 2 つである。
 * 1. **既定（倍率を渡さない）の挙動が 1 ビットも変わらないこと。** 倍率 1.0 を明示しても同じ。
 * 2. **倍率を掛けても乱数の消費順が変わらないこと。** 変わると共通乱数によるペア比較が
 *    崩れ、`optimize.test.ts` の「効かないスキルを足しても差は厳密に 0 になる」が落ちる。
 *
 * docs/roadmap.md 3.7 節と docs/solver-design.md 4 節を参照。
 */

const data = loadGameData();
const system = defaultSystemSetting();
const track = { location: 10006, course: 10606, condition: 1, gateCount: 9 } as const;
const calculator = new RaceCalculator(system, data.trackData);

const skill = (name: string): SkillData => {
  const found = data.skillsByName.get(name)?.[0];
  if (found === undefined) throw new Error(`スキルが見つからない: ${name}`);
  return found;
};

function setting(options: {
  scale?: number;
  skills?: readonly SkillData[];
}): RaceSetting {
  const base: RaceSetting = {
    uma: {
      charaName: '', speed: 1200, stamina: 1000, power: 900, guts: 600, wisdom: 900,
      condition: 'BEST', style: 'SEN', distanceFit: 'A', surfaceFit: 'A', styleFit: 'A',
      popularity: 1, gateNumber: 5, uniqueLevel: 6,
    },
    track, skills: options.skills ?? [],
    skillActivateAdjustment: 'NONE', randomPosition: 'RANDOM',
    debuffCounts: {}, positionKeepMode: 'APPROXIMATE', positionKeepRate: 100,
  };
  // 倍率を渡さない設定そのものを作りたいので、省略時はキーを足さない。
  return options.scale === undefined ? base : { ...base, approximateRateScale: options.scale };
}

/** 試行ごとのタイム */
function times(target: RaceSetting, trials: number): number[] {
  const result: number[] = [];
  for (let trial = 0; trial < trials; trial++) {
    result.push(calculator.simulate(target, { seed: 20260913, trial }).result.raceTime);
  }
  return result;
}

/** 指定したスキルが 1 回でも発動した試行の割合 */
function triggerRate(target: RaceSetting, skillId: string, trials: number): number {
  let count = 0;
  for (let trial = 0; trial < trials; trial++) {
    const { state } = calculator.simulate(target, { seed: 20260913, trial });
    if ((state.simulation.skillTrace.get(skillId)?.count ?? 0) > 0) count++;
  }
  return count / trials;
}

describe('近似確率の倍率', () => {
  it('倍率を渡さないのと 1.0 を渡すのは、タイムまで完全に一致する', () => {
    const skills = [skill('鋼の意志'), skill('ノンストップガール')];
    expect(times(setting({ skills }), 40)).toEqual(times(setting({ scale: 1.0, skills }), 40));
  });

  it('倍率を変えても乱数の消費順は変わらない（効かないスキルの差は厳密に 0）', () => {
    // 負けん気はマイル限定なので、東京芝2400 では発動しようがない。
    // 倍率を掛けても引く回数と順番が変わらなければ、足しても他の出目は動かない。
    for (const scale of [0.5, 2.0]) {
      const before = times(setting({ scale }), 40);
      const after = times(setting({ scale, skills: [skill('負けん気')] }), 40);
      expect(after, `倍率 ${scale}`).toEqual(before);
    }
  });

  it('倍率を上げると近似条件つきスキルの発動率が上がり、0 にすると発動しなくなる', () => {
    const target = skill('鋼の意志'); // 前方ブロックの継続を見る
    const rate = (scale: number) => triggerRate(setting({ scale, skills: [target] }), target.id, 60);
    const none = rate(0);
    const half = rate(0.5);
    const base = rate(1.0);
    const double = rate(2.0);
    expect(none).toBe(0);
    expect(half).toBeLessThan(base);
    expect(base).toBeLessThan(double);
  });

  it('負の倍率は 0 に丸める', () => {
    expect(times(setting({ scale: -3 }), 20)).toEqual(times(setting({ scale: 0 }), 20));
  });

  it('確率は 1.0 で頭打ちになる', () => {
    // 倍率を極端に上げると、開始確率は 1.0 に飽和して毎秒必ず立つ。
    const state = calculator.simulate(setting({ scale: 1000 }), { seed: 1, trial: 0 }).state;
    expect(state.simulation.specialState['blocked_front']).toBeGreaterThan(0);
    // RandomRates は累積も 1.0 で切るので、最初の値より後ろは選ばれなくなる。
    expect(state.simulation.specialState['near_count']).toBe(1);
  });

  it('近似条件を見るスキルかどうかを、本番と同じ表から引く', () => {
    expect(dependsOnApproximate(skill('鋼の意志'))).toBe(true);
    expect(dependsOnApproximate(skill('末脚'))).toBe(false);
  });
});

describe('感度分析', () => {
  it('倍率が Worker 境界を越え、スキルごとの幅が出る', async () => {
    const pool = new WorkerPool(nodeWorkerFactory, 2);
    try {
      const context: OptimizeContext = {
        pool,
        system,
        cost: createCostModel(data.skillsById),
        seed: 20260913,
        base: toSerializable(setting({})),
        field: null,
      };
      const approximate = skill('鋼の意志');
      const plain = skill('末脚');
      const result = await measureSensitivity(context, {
        candidates: [approximate.id, plain.id],
        trials: 40,
        skillsById: data.skillsById,
      });

      // 倍率が Worker まで届いていれば、基準のタイムが倍率ごとに変わる。
      // 届いていなければ 3 つとも同じ値になる。
      const meanTimes = result.scales.map((s) => s.meanTime);
      expect(new Set(meanTimes).size).toBe(3);
      // 既定倍率どうしの差は自分自身なので厳密に 0
      const base = result.scales.find((s) => s.scale === 1.0)!;
      expect(base.shift.mean).toBe(0);

      const width = (id: string) => result.skills.find((s) => s.skillId === id)!;
      expect(width(approximate.id).approximate).toBe(true);
      expect(width(plain.id).approximate).toBe(false);
      // 近似を見るスキルは倍率で短縮量が動く。見ないスキルはほとんど動かない。
      expect(width(approximate.id).width).toBeGreaterThan(width(plain.id).width);
    } finally {
      await pool.dispose();
    }
  }, 120000);

  it('倍率の一覧に既定の 1.0 が無ければ断る', async () => {
    const pool = new WorkerPool(nodeWorkerFactory, 1);
    try {
      const context: OptimizeContext = {
        pool,
        system,
        cost: createCostModel(data.skillsById),
        seed: 20260913,
        base: toSerializable(setting({})),
        field: null,
      };
      await expect(
        measureSensitivity(context, { candidates: [], trials: 10, scales: [0.5, 2.0] }),
      ).rejects.toThrow('1.0');
    } finally {
      await pool.dispose();
    }
  });
});
