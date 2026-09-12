import { describe, expect, it } from 'vitest';
import { formatDuration } from '../src/format.ts';
import { estimateMulti, estimateRun, multiPaceKey, paceKey } from '../src/store.ts';

const track = { location: 10006, course: 10606, condition: 1, gateCount: 9 };

describe('所要時間の見積もり', () => {
  it('実測が無ければ目安として出す', () => {
    const estimate = estimateRun({ pace: {}, useField: false, count: 1000 });
    expect(estimate.measured).toBe(false);
    expect(estimate.ms).toBeGreaterThan(0);
  });

  it('実測があればそれを使い、回数に比例する', () => {
    const pace = { [paceKey(false)]: 0.4 };
    const estimate = estimateRun({ pace, useField: false, count: 200_000 });
    expect(estimate.measured).toBe(true);
    expect(estimate.ms).toBe(80_000);
  });

  it('順位条件の有無で別の実測を使う', () => {
    const pace = { [paceKey(false)]: 0.4, [paceKey(true)]: 1.4 };
    expect(estimateRun({ pace, useField: false, count: 1000 }).ms).toBe(400);
    expect(estimateRun({ pace, useField: true, count: 1000 }).ms).toBe(1400);
  });

  it('片方しか測っていなければ、もう片方は目安のままである', () => {
    const pace = { [paceKey(false)]: 0.4 };
    expect(estimateRun({ pace, useField: true, count: 1000 }).measured).toBe(false);
  });

  it('全頭同時は頭数ごとに実測を分ける', () => {
    const pace = { [multiPaceKey(9)]: 5.6 };
    expect(estimateMulti({ pace, track, multiTrials: 500 }).ms).toBeCloseTo(2800);
    expect(estimateMulti({ pace, track: { ...track, gateCount: 12 }, multiTrials: 500 }).measured).toBe(
      false,
    );
  });

  it('全頭同時の目安は頭数に比例する', () => {
    const nine = estimateMulti({ pace: {}, track, multiTrials: 100 }).ms;
    const twelve = estimateMulti({ pace: {}, track: { ...track, gateCount: 12 }, multiTrials: 100 }).ms;
    expect(twelve / nine).toBeCloseTo(12 / 9);
  });

  it('単騎より全頭同時のほうが 1 試行は重い', () => {
    const solo = estimateRun({ pace: {}, useField: false, count: 100 }).ms;
    const multi = estimateMulti({ pace: {}, track, multiTrials: 100 }).ms;
    expect(multi).toBeGreaterThan(solo);
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
