import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { RaceCalculator } from '../src/calculator.ts';
import type { Style } from '../src/data/constants.ts';
import { meanAndSe, median, PairedTally, runPaired, type PairedSpec, type PairedTrial } from '../src/multi/paired.ts';
import { defaultSystemSetting, type RaceSetting } from '../src/setting.ts';
import type { SkillData } from '../src/skill/types.ts';

/**
 * 全頭同時の対比較（paired.ts）の検査。
 * 集計は乱数を使わずに手で与えた値で見る。回す側は、発動しようがないスキルを足すと
 * 差が厳密に 0 になること（共通乱数）と、進捗・中断・制御の返し方を見る。
 */

describe('meanAndSe と median', () => {
  it('平均と標準誤差は、n - 1 で割った標本分散から求める', () => {
    const { mean, se } = meanAndSe([1, 2, 3, 4]);
    expect(mean).toBe(2.5);
    // 標本分散 5/3、標準誤差 sqrt(5/3 / 4)
    expect(se).toBeCloseTo(Math.sqrt(5 / 12), 12);
    expect(meanAndSe([7])).toEqual({ mean: 7, se: 0 });
    expect(meanAndSe([])).toEqual({ mean: 0, se: 0 });
  });

  it('中央値は、偶数個なら中央の 2 つの平均で、空なら NaN', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
  });
});

describe('PairedTally', () => {
  const trial = (
    baseOrder: number,
    variantOrder: number,
    baseTime: number,
    variantTime: number,
    firstPositions: number[],
  ): PairedTrial => ({ baseOrder, variantOrder, baseTime, variantTime, firstPositions });

  it('勝率・着順・タイムの差を、試行ごとの対から求める。発動しなかった試行は位置の中央値に入れない', () => {
    const tally = new PairedTally(['a', 'b']);
    tally.add(trial(2, 1, 100, 99, [500, Number.NaN]), 0);
    tally.add(trial(1, 1, 100, 99.5, [700, Number.NaN]), 0);
    tally.add(trial(3, 2, 101, 100, [Number.NaN, Number.NaN]), 1);
    tally.add(trial(2, 3, 100, 100.5, [900, Number.NaN]), 1);
    const summary = tally.summarize();

    expect(summary.trials).toBe(4);
    expect(summary.base.winRate).toBe(0.25);
    expect(summary.variant.winRate).toBe(0.5);
    expect(summary.deltaWinRate.mean).toBe(0.25);
    expect(summary.base.meanOrder).toBe(2);
    expect(summary.variant.meanOrder).toBe(1.75);
    expect(summary.deltaMeanOrder.mean).toBe(-0.25);
    expect(summary.deltaMeanTime.mean).toBeCloseTo(-0.5, 12);
    // a は 3 試行で発動、b は 1 度も発動しない。
    expect(summary.skills).toEqual([
      { skillId: 'a', triggerRate: 0.75, medianFirstPosition: 700 },
      { skillId: 'b', triggerRate: 0, medianFirstPosition: null },
    ]);
    // 組ごとの内訳
    expect(summary.groups).toEqual([
      { index: 0, trials: 2, baseWinRate: 0.5, variantWinRate: 1 },
      { index: 1, trials: 2, baseWinRate: 0, variantWinRate: 0 },
    ]);
  });
});

describe('runPaired', () => {
  const data = loadGameData();
  const calculator = new RaceCalculator(defaultSystemSetting(), data.trackData);
  const track = { location: 10006, course: 10606, condition: 1, gateCount: 5, season: 1, weather: 1, time: 1 } as const;
  const make = (style: Style, skills: readonly SkillData[] = []): RaceSetting => ({
    uma: {
      charaName: '', speed: 1200, stamina: 1000, power: 900, guts: 600, wisdom: 900,
      condition: 'BEST', style, distanceFit: 'A', surfaceFit: 'A', styleFit: 'A',
      popularity: 1, gateNumber: 0, uniqueLevel: 6,
    },
    track, skills,
    skillActivateAdjustment: 'NONE', randomPosition: 'RANDOM',
    debuffCounts: {}, positionKeepMode: 'VIRTUAL', positionKeepRate: 100,
  });
  const real = (name: string): SkillData => {
    const found = data.skillsByName.get(name)?.find((s) => s.sp > 0);
    if (found === undefined) throw new Error(`買えるスキルが見つからない: ${name}`);
    return found;
  };
  const opponents = (['NIGE', 'SASI', 'OI', 'SEN'] as const).map((style) => make(style));
  const spec = (added: readonly SkillData[], counts: readonly number[]): PairedSpec => ({
    base: make('SEN'),
    variant: make('SEN', added),
    groups: counts.map((count, index) => ({ index, seed: 100 + index, count, opponents })),
    traceSkillIds: added.map((s) => s.id),
  });
  // 先行の自分に、追込専用のスキルを足す。条件が出走前に偽になるので、確かに発動しない。
  const never = real('追込直線◎');
  const works = real('コーナー加速○');

  it('発動しないスキルを足すと、勝率も着順もタイムも差が厳密に 0 になり、発動率は 0 になる', async () => {
    const summary = await runPaired(calculator, spec([never], [3, 3]));
    expect(summary.trials).toBe(6);
    expect(summary.deltaWinRate).toEqual({ mean: 0, se: 0 });
    expect(summary.deltaMeanOrder).toEqual({ mean: 0, se: 0 });
    expect(summary.deltaMeanTime).toEqual({ mean: 0, se: 0 });
    expect(summary.variant).toEqual(summary.base);
    expect(summary.skills).toEqual([{ skillId: never.id, triggerRate: 0, medianFirstPosition: null }]);
    expect(summary.groups.map((g) => g.trials)).toEqual([3, 3]);
  });

  it('発動するスキルを足すと、発動率と最初の発動位置（コースの中）が返り、タイムが縮む（検査が空振りしていない）', async () => {
    const summary = await runPaired(calculator, spec([works], [4]));
    const trace = summary.skills[0]!;
    expect(trace.triggerRate).toBeGreaterThan(0);
    expect(trace.medianFirstPosition).toBeGreaterThan(0);
    expect(trace.medianFirstPosition).toBeLessThan(2400);
    expect(summary.deltaMeanTime.mean).toBeLessThan(0);
  });

  it('同じ入力なら同じ結果になる', async () => {
    const a = await runPaired(calculator, spec([works], [3, 2]));
    const b = await runPaired(calculator, spec([works], [3, 2]));
    expect(b).toEqual(a);
  });

  it('進捗は全組を通した試行数で通知され、既定では 5 試行ごとに制御を返す', async () => {
    const progress: [number, number][] = [];
    let yielded = 0;
    await runPaired(calculator, spec([never], [4, 3]), {
      onProgress: (done, total) => progress.push([done, total]),
      yieldControl: async () => {
        yielded++;
      },
    });
    // 7 試行で 5 試行目に 1 回返し、終わりにもう 1 度通知する。
    expect(yielded).toBe(1);
    expect(progress).toEqual([
      [5, 7],
      [7, 7],
    ]);
    // 間隔を指定できる。
    let every = 0;
    await runPaired(calculator, spec([never], [4]), {
      yieldEvery: 2,
      yieldControl: async () => {
        every++;
      },
    });
    expect(every).toBe(2);
  });

  it('中断されたら、途中までの集計を返さずに例外を投げる', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runPaired(calculator, spec([never], [3]), { signal: controller.signal })).rejects.toThrow('中断されました');
  });
});
