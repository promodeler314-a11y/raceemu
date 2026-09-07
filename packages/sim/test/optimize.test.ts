import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { defaultFieldProfile } from '../src/field/field.ts';
import { nodeWorkerFactory } from '../src/parallel/node.ts';
import { WorkerPool } from '../src/parallel/pool.ts';
import { toSerializable } from '../src/parallel/protocol.ts';
import { defaultSystemSetting, type RaceSetting } from '../src/setting.ts';
import { createCostModel, dedupeByGroup } from '../../solver/src/cost.ts';
import {
  Evaluator,
  measurePositionCompetition,
  optimizeSkills,
  pairedDiff,
  type OptimizeContext,
} from '../../solver/src/optimize.ts';

const data = loadGameData();
const system = defaultSystemSetting();
const track = { location: 10006, course: 10606, condition: 1, gateCount: 9 } as const;

const skill = (name: string) => {
  const found = data.skillsByName.get(name)?.[0];
  if (found === undefined) throw new Error(`スキルが見つからない: ${name}`);
  return found;
};

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

function makeContext(pool: WorkerPool, field = false): OptimizeContext {
  return {
    pool,
    system,
    base: toSerializable(setting),
    cost: createCostModel(data.skillsById),
    seed: 20260904,
    field: field ? { profile: defaultFieldProfile(9), track, seed: 9001, samples: 16 } : null,
  };
}

describe('費用', () => {
  it('同じグループからは最も高いものだけを数える', () => {
    const model = createCostModel(data.skillsById);
    const low = skill('右回り○');
    const high = skill('右回りの鬼');
    expect(model.group(low.id)).toBe(model.group(high.id));
    // 表示ポイントは下位を含む総額なので、2 つ取っても総額は上位のぶんだけ
    expect(model.totalCost([low.id, high.id])).toBe(model.cost(high.id));
    expect(dedupeByGroup([low.id, high.id], model)).toEqual([high.id]);
  });

  it('ヒントレベルで割り引く', () => {
    const plain = createCostModel(data.skillsById);
    const target = skill('中距離コーナー○');
    const hinted = createCostModel(data.skillsById, { hintLevels: { [target.id]: 3 } });
    expect(hinted.cost(target.id)).toBeLessThan(plain.cost(target.id));
    // 割引はレベルごとの係数なので、レベル 0 は割引なし
    expect(createCostModel(data.skillsById, { hintLevels: {} }).cost(target.id)).toBe(
      plain.cost(target.id),
    );
  });
});

describe('組み合わせ探索', () => {
  it('効かないスキルを足しても差は厳密に 0 になる', async () => {
    // 負けん気はマイル限定なので、東京芝2400 では発動しようがない。
    // 乱数をストリームに分けてあるなら、足しても他の出目は動かない。
    const pool = new WorkerPool(nodeWorkerFactory, 2);
    try {
      const evaluator = new Evaluator(makeContext(pool));
      const before = await evaluator.evaluate([], 200);
      const after = await evaluator.evaluate([skill('負けん気').id], 200);
      const diff = pairedDiff(before, after);
      expect(diff.zeroRate).toBe(1);
      expect(diff.mean).toBe(0);
      expect(diff.spurtFlips).toBe(0);
    } finally {
      await pool.dispose();
    }
  }, 120000);

  it('効くスキルはタイムを縮め、差の標準誤差はタイムそのものより小さい', async () => {
    const pool = new WorkerPool(nodeWorkerFactory, 2);
    try {
      const evaluator = new Evaluator(makeContext(pool));
      const before = await evaluator.evaluate([], 400);
      const after = await evaluator.evaluate([skill('円弧のマエストロ').id], 400);
      const diff = pairedDiff(before, after);
      expect(diff.mean).toBeGreaterThan(0);
      expect(diff.trials).toBe(400);

      const sd = (xs: Float64Array) => {
        const m = [...xs].reduce((x, y) => x + y, 0) / xs.length;
        return Math.sqrt([...xs].reduce((s, t) => s + (t - m) ** 2, 0) / (xs.length - 1));
      };
      const unpaired = Math.sqrt((sd(before.times) ** 2 + sd(after.times) ** 2) / before.times.length);
      expect(diff.stdError).toBeLessThan(unpaired);
    } finally {
      await pool.dispose();
    }
  }, 120000);

  it('同じ入力なら同じ答えを返す', async () => {
    const pool = new WorkerPool(nodeWorkerFactory, 2);
    try {
      const candidates = ['中距離コーナー○', '中距離直線○', '一匹狼'].map((n) => skill(n).id);
      const options = { candidates, budget: 300, stages: [100, 200], maxRounds: 2 } as const;
      const first = await optimizeSkills(makeContext(pool), options);
      const second = await optimizeSkills(makeContext(pool), options);
      expect([...second.best].sort()).toEqual([...first.best].sort());
      expect(second.bestDiff.mean).toBe(first.bestDiff.mean);
    } finally {
      await pool.dispose();
    }
  }, 180000);

  it('予算を超える構成は返さない', async () => {
    const pool = new WorkerPool(nodeWorkerFactory, 2);
    try {
      const context = makeContext(pool);
      const candidates = ['中距離コーナー○', '中距離直線○', '円弧のマエストロ', '一匹狼'].map(
        (n) => skill(n).id,
      );
      const result = await optimizeSkills(context, {
        candidates,
        budget: 200,
        stages: [100, 200],
        maxRounds: 2,
      });
      expect(result.cost).toBeLessThanOrEqual(200);
      for (const entry of result.top) expect(entry.cost).toBeLessThanOrEqual(200);
    } finally {
      await pool.dispose();
    }
  }, 180000);

  it('順位条件を判定すると、脚質と噛み合わないスキルの評価が落ちる', async () => {
    // 追込に「前半分」を求める順風満帆を持たせる。
    // 順位を無視すれば効いて見えるが、判定すればほとんど発動しない。
    const pool = new WorkerPool(nodeWorkerFactory, 2);
    try {
      const oi: RaceSetting = { ...setting, uma: { ...setting.uma, style: 'OI' } };
      const target = skill('順風満帆').id;
      const measure = async (field: boolean) => {
        const context: OptimizeContext = { ...makeContext(pool, field), base: toSerializable(oi) };
        const evaluator = new Evaluator(context);
        const before = await evaluator.evaluate([], 300);
        const after = await evaluator.evaluate([target], 300);
        return pairedDiff(before, after);
      };
      const ignored = await measure(false);
      const judged = await measure(true);
      expect(ignored.mean).toBeGreaterThan(0.05);
      expect(judged.mean).toBeLessThan(ignored.mean / 4);
    } finally {
      await pool.dispose();
    }
  }, 240000);
});

describe('位置取り調整の参考行', () => {
  /** スタミナだけを差し替えた文脈を作る。 */
  function contextWithStamina(pool: WorkerPool, stamina: number): OptimizeContext {
    return {
      ...makeContext(pool),
      base: toSerializable({ ...setting, uma: { ...setting.uma, stamina } }),
    };
  }

  it('平均回数が評価そのものと一致する', async () => {
    const pool = new WorkerPool(nodeWorkerFactory, 2);
    try {
      const context = contextWithStamina(pool, 1400);
      const evaluator = new Evaluator(context);
      const baseline = await evaluator.evaluate([], 200);
      const effect = await measurePositionCompetition(context, baseline, 200);

      let sum = 0;
      for (const count of baseline.positionCompetitionCount) sum += count;
      expect(effect.averageCount).toBeCloseTo(sum / 200, 10);
      expect(effect.races).toBe(200);
      expect(effect.diff.trials).toBe(200);
    } finally {
      await pool.dispose();
    }
  }, 120000);

  it('スタミナが足りていれば調整があるほうが速い', async () => {
    const pool = new WorkerPool(nodeWorkerFactory, 2);
    try {
      const context = contextWithStamina(pool, 1400);
      const evaluator = new Evaluator(context);
      const baseline = await evaluator.evaluate([], 300);
      const effect = await measurePositionCompetition(context, baseline, 300);

      // 余裕がある側では調整が実際に起きており、その収支は正になる。
      expect(effect.averageCount).toBeGreaterThan(3);
      expect(effect.diff.mean).toBeGreaterThan(2 * effect.diff.stdError);
    } finally {
      await pool.dispose();
    }
  }, 120000);

  it('スタミナが足りなければ調整はそもそも起きない', async () => {
    const pool = new WorkerPool(nodeWorkerFactory, 2);
    try {
      const context = contextWithStamina(pool, 700);
      const evaluator = new Evaluator(context);
      const baseline = await evaluator.evaluate([], 200);
      const effect = await measurePositionCompetition(context, baseline, 200);

      // 持久力温存が先に発火するので、平均回数はほぼ 0 になる。
      // このとき参考行は「調整の側にいない」ことを示す。
      expect(effect.averageCount).toBeLessThan(0.5);
    } finally {
      await pool.dispose();
    }
  }, 120000);

  it('測らない指定なら null を返し、レース数も増えない', async () => {
    const pool = new WorkerPool(nodeWorkerFactory, 2);
    try {
      const context = makeContext(pool);
      const options = {
        candidates: [skill('中距離コーナー○').id, skill('中距離直線○').id],
        budget: 200,
        stages: [40, 80],
      };
      const off = await optimizeSkills(context, { ...options, measurePositionCompetition: false });
      const on = await optimizeSkills(context, options);
      expect(off.positionCompetition).toBeNull();
      expect(on.positionCompetition).not.toBeNull();
      expect(on.races).toBeGreaterThan(off.races);
    } finally {
      await pool.dispose();
    }
  }, 180000);
});
