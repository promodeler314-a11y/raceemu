import { describe, expect, it } from 'vitest';
import { formatDuration } from '../src/format.ts';
import {
  crossPaceKey,
  estimateCross,
  estimateMulti,
  estimateRun,
  estimateSensitivity,
  multiPaceKey,
  paceKey,
  recordPace,
  sensitivityCandidates,
  sensitivityPaceKey,
  sensitivityScales,
  type PaceSample,
} from '../src/store.ts';

const track = { location: 10006, course: 10606, condition: 1, gateCount: 9 };

/** 実測を 1 点だけ持つ状態。 */
const one = (key: string, sample: PaceSample) => recordPace({}, key, sample);

describe('所要時間の見積もり', () => {
  it('実測が無ければ目安として出す', () => {
    const estimate = estimateRun({ pace: {}, useField: false, count: 1000 });
    expect(estimate.measured).toBe(false);
    expect(estimate.ms).toBeGreaterThan(0);
  });

  it('実測が 1 点なら比例で伸ばす', () => {
    const pace = one(paceKey(false), { count: 2000, ms: 1000 });
    const estimate = estimateRun({ pace, useField: false, count: 20_000 });
    expect(estimate.measured).toBe(true);
    expect(estimate.ms).toBe(10_000);
  });

  it('回数の違う 2 点があれば、固定のぶんと 1 試行あたりを分ける', () => {
    // 固定 2000 ms + 1 試行 0.5 ms で作った 2 点。
    let pace = one(paceKey(true), { count: 2000, ms: 3000 });
    pace = recordPace(pace, paceKey(true), { count: 20_000, ms: 12_000 });
    // 比例で伸ばすと 30000 試行を 18000 ms と見るが、直線なら 17000 ms になる。
    expect(estimateRun({ pace, useField: true, count: 30_000 }).ms).toBeCloseTo(17_000);
    expect(estimateRun({ pace, useField: true, count: 0 }).ms).toBeCloseTo(2000);
  });

  it('同じ回数で測り直しても 2 点目を捨てない', () => {
    let pace = one(paceKey(false), { count: 2000, ms: 3000 });
    pace = recordPace(pace, paceKey(false), { count: 20_000, ms: 12_000 });
    pace = recordPace(pace, paceKey(false), { count: 20_000, ms: 12_400 });
    expect(pace[paceKey(false)]).toHaveLength(2);
    expect(pace[paceKey(false)]![0]!.ms).toBe(12_400);
    expect(pace[paceKey(false)]![1]!.count).toBe(2000);
  });

  it('傾きが負に出たら比例に落とす', () => {
    // 回数を増やしたのに速くなった、という 2 点。測り揺らぎで起こりうる。
    let pace = one(paceKey(false), { count: 20_000, ms: 1000 });
    pace = recordPace(pace, paceKey(false), { count: 2000, ms: 3000 });
    const estimate = estimateRun({ pace, useField: false, count: 2000 });
    expect(estimate.measured).toBe(true);
    expect(estimate.ms).toBe(3000);
  });

  it('順位条件の有無で別の実測を使う', () => {
    let pace = one(paceKey(false), { count: 1000, ms: 400 });
    pace = recordPace(pace, paceKey(true), { count: 1000, ms: 1400 });
    expect(estimateRun({ pace, useField: false, count: 1000 }).ms).toBe(400);
    expect(estimateRun({ pace, useField: true, count: 1000 }).ms).toBe(1400);
  });

  it('片方しか測っていなければ、もう片方は目安のままである', () => {
    const pace = one(paceKey(false), { count: 1000, ms: 400 });
    expect(estimateRun({ pace, useField: true, count: 1000 }).measured).toBe(false);
  });

  it('全頭同時は頭数ごとに実測を分ける', () => {
    const pace = one(multiPaceKey(9), { count: 500, ms: 2800 });
    expect(estimateMulti({ pace, track, multiTrials: 500 }).ms).toBeCloseTo(2800);
    expect(estimateMulti({ pace, track: { ...track, gateCount: 12 }, multiTrials: 500 }).measured).toBe(
      false,
    );
  });

  it('全頭同時の目安は、1 試行あたりが頭数に比例する', () => {
    const at = (gateCount: number, trials: number) =>
      estimateMulti({ pace: {}, track: { ...track, gateCount }, multiTrials: trials }).ms;
    // 固定のぶんは頭数で変わらないので、差を取って比べる。
    const nine = at(9, 1100) - at(9, 100);
    const twelve = at(12, 1100) - at(12, 100);
    expect(twelve / nine).toBeCloseTo(12 / 9);
  });

  it('単騎より全頭同時のほうが 1 試行は重い', () => {
    const solo = estimateRun({ pace: {}, useField: false, count: 1100 }).ms -
      estimateRun({ pace: {}, useField: false, count: 100 }).ms;
    const multi = estimateMulti({ pace: {}, track, multiTrials: 1100 }).ms -
      estimateMulti({ pace: {}, track, multiTrials: 100 }).ms;
    expect(multi).toBeGreaterThan(solo);
  });

  it('順位条件を入れるほうが重い', () => {
    const solo = estimateRun({ pace: {}, useField: false, count: 10_000 }).ms;
    const field = estimateRun({ pace: {}, useField: true, count: 10_000 }).ms;
    expect(field).toBeGreaterThan(solo);
  });
});

describe('コース横断の見積もり', () => {
  it('コースの本数に比例する', () => {
    const single = estimateCross({ pace: {}, useField: false, count: 500, courses: 1 });
    const twelve = estimateCross({ pace: {}, useField: false, count: 500, courses: 12 });
    expect(twelve.ms).toBeCloseTo(single.ms * 12);
  });

  it('コースが 0 本なら 0 になる', () => {
    expect(estimateCross({ pace: {}, useField: false, count: 500, courses: 0 }).ms).toBe(0);
  });

  it('実測はコース 1 本あたりで覚える', () => {
    // 1 本 2 秒で 12 本走らせた、という実測を 1 点だけ持つ状態。
    const pace = one(crossPaceKey(false), { count: 500, ms: 2000 });
    const estimate = estimateCross({ pace, useField: false, count: 500, courses: 26 });
    expect(estimate.measured).toBe(true);
    expect(estimate.ms).toBeCloseTo(2000 * 26);
  });

  it('順位条件ありのほうが重い。束をコースごとに作り直すため', () => {
    const solo = estimateCross({ pace: {}, useField: false, count: 500, courses: 12 }).ms;
    const field = estimateCross({ pace: {}, useField: true, count: 500, courses: 12 }).ms;
    expect(field).toBeGreaterThan(solo);
  });

  it('単騎 1 本ぶんの実測とコース横断の実測は混ざらない', () => {
    const pace = one(paceKey(false), { count: 500, ms: 99_000 });
    expect(estimateCross({ pace, useField: false, count: 500, courses: 1 }).measured).toBe(false);
  });
});

describe('所要時間の表示', () => {
  it('秒、分、時間で言い分ける', () => {
    expect(formatDuration(400)).toBe('1 秒未満');
    expect(formatDuration(12_000)).toBe('12 秒');
    expect(formatDuration(90_000)).toBe('1 分 30 秒');
    expect(formatDuration(120_000)).toBe('2 分');
    expect(formatDuration(3_600_000)).toBe('1 時間');
    expect(formatDuration(6_420_000)).toBe('1 時間 47 分');
  });

  it('数でないものは線で返す', () => {
    expect(formatDuration(Number.NaN)).toBe('–');
    expect(formatDuration(-1)).toBe('–');
  });
});

describe('近似の感度分析の見積もり', () => {
  it('振る値の数 × (1 + 候補の数) × 試行数ぶんを走らせると見る', () => {
    const estimate = estimateSensitivity({
      pace: {},
      useField: true,
      sensitivityTrials: 300,
      candidateCount: 8,
    });
    // 既定の倍率は 0.5 / 1 / 2 の 3 通り。
    expect(estimate.totalTrials).toBe(3 * 9 * 300);
    expect(estimate.measured).toBe(false);
  });

  it('軸ごとに実測を分ける。倍率と距離では 1 レースの重さが違う', () => {
    const pace = recordPace({}, sensitivityPaceKey(true, 'rate'), { count: 900, ms: 3000 });
    expect(
      estimateSensitivity({
        pace,
        useField: true,
        sensitivityAxis: 'rate',
        sensitivityTrials: 100,
        candidateCount: 2,
      }).measured,
    ).toBe(true);
    // 距離の軸はまだ測っていないので、目安のままである。
    expect(
      estimateSensitivity({
        pace,
        useField: true,
        sensitivityAxis: 'near',
        sensitivityTrials: 100,
        candidateCount: 2,
      }).measured,
    ).toBe(false);
  });

  it('どちらの軸も 3 通りで、基準値を真ん中に挟む', () => {
    expect(sensitivityScales('rate')).toEqual([0.5, 1.0, 2.0]);
    // 距離の基準は 1 バ身 = 2.5 m。
    expect(sensitivityScales('near')).toEqual([1.25, 2.5, 5]);
  });

  it('実測が付くと、単騎の実測ではなく感度分析の実測から出す', () => {
    // 単騎の実測だけを持たせても、鍵が違うので目安のままである。
    const solo = one(paceKey(true), { count: 10_000, ms: 1000 });
    expect(
      estimateSensitivity({
        pace: solo,
        useField: true,
        sensitivityTrials: 100,
        candidateCount: 3,
      }).measured,
    ).toBe(false);
    const pace = recordPace(solo, sensitivityPaceKey(true), { count: 1200, ms: 6000 });
    const estimate = estimateSensitivity({
      pace,
      useField: true,
      sensitivityTrials: 100,
      candidateCount: 3,
    });
    expect(estimate.measured).toBe(true);
    expect(estimate.totalTrials).toBe(1200);
    expect(estimate.ms).toBeCloseTo(6000);
  });

  it('重くなるので、候補を増やすと見込みも伸びる', () => {
    const few = estimateSensitivity({
      pace: {},
      useField: true,
      sensitivityTrials: 300,
      candidateCount: 4,
    }).ms;
    const many = estimateSensitivity({
      pace: {},
      useField: true,
      sensitivityTrials: 300,
      candidateCount: 16,
    }).ms;
    expect(many).toBeGreaterThan(few);
  });
});

describe('近似の感度分析で幅を測るスキルの選び方', () => {
  const singles = (ids: readonly string[]) =>
    ids.map((skillId) => ({ skillId })) as never as ReturnType<
      () => NonNullable<Parameters<typeof sensitivityCandidates>[0]['optimizeResult']>
    >['singles'];

  it('探索を走らせていなければ、選んでいるスキルの先頭から取る', () => {
    expect(
      sensitivityCandidates({
        skillIds: ['a', 'b', 'c', 'd'],
        optimizeResult: null,
        sensitivityLimit: 3,
      }),
    ).toEqual(['a', 'b', 'c']);
  });

  it('探索を走らせてあれば、最良の構成を先に取る', () => {
    const chosen = sensitivityCandidates({
      skillIds: ['a', 'b', 'c', 'd'],
      optimizeResult: {
        best: ['c', 'd'],
        singles: singles(['a', 'b', 'c', 'd']),
      } as never,
      sensitivityLimit: 3,
    });
    expect(chosen).toEqual(['c', 'd', 'a']);
  });

  it('同じスキルを二度測らない', () => {
    const chosen = sensitivityCandidates({
      skillIds: [],
      optimizeResult: { best: ['a'], singles: singles(['a', 'a', 'b']) } as never,
      sensitivityLimit: 10,
    });
    expect(chosen).toEqual(['a', 'b']);
  });

  it('上限は 30 で止める。走らせる構成が候補の数だけ増えるためである', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `s${i}`);
    expect(
      sensitivityCandidates({ skillIds: ids, optimizeResult: null, sensitivityLimit: 999 }),
    ).toHaveLength(30);
  });
});
