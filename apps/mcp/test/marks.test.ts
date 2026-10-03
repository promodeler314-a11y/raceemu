import { describe, expect, it } from 'vitest';
import { assignMarks, LONGSHOT_MIN_WIN_RATE, winRateStandardError } from '../src/marks.ts';

/** 勝率の並びと試行数から、入力を作る。 */
const rows = (rates: number[], trials = 2400) => rates.map((winRate) => ({ winRate, trials }));

describe('予想印の規則', () => {
  it('勝率の順に ◎ ○ ▲ △ △ を付ける', () => {
    const { marks } = assignMarks(rows([0.01, 0.46, 0.245, 0.103, 0.085, 0.059, 0.029, 0.012, 0, 0, 0]));
    expect(marks).toEqual(['', '◎', '○', '▲', '△', '△', '', '', '', '', '']);
  });

  it('6 位以下で勝率が最も高い 1 頭は、3 % 以上なら ☆', () => {
    const { marks } = assignMarks(rows([0.4, 0.2, 0.1, 0.08, 0.06, 0.05, 0.04, 0.01]));
    // 6 位の勝率 5 % が ☆。7 位は印が付かない。
    expect(marks).toEqual(['◎', '○', '▲', '△', '△', '☆', '', '']);
  });

  it('☆ の下限は 3 % で、境目を含む', () => {
    expect(LONGSHOT_MIN_WIN_RATE).toBe(0.03);
    expect(assignMarks(rows([0.4, 0.2, 0.1, 0.08, 0.06, 0.03])).marks[5]).toBe('☆');
    expect(assignMarks(rows([0.4, 0.2, 0.1, 0.08, 0.06, 0.0299])).marks[5]).toBe('');
  });

  it('勝率が 3 % に届かなければ ☆ は付かない', () => {
    const { marks } = assignMarks(rows([0.5, 0.2, 0.1, 0.08, 0.06, 0.02, 0.01]));
    expect(marks).toEqual(['◎', '○', '▲', '△', '△', '', '']);
  });

  it('頭数が少なければ、あるぶんだけ付く', () => {
    expect(assignMarks(rows([0.7, 0.3])).marks).toEqual(['◎', '○']);
    expect(assignMarks(rows([0.5, 0.3, 0.2])).marks).toEqual(['◎', '○', '▲']);
  });

  it('同率は入力の順を保つ', () => {
    const { marks, order } = assignMarks(rows([0.3, 0.3, 0.4]));
    expect(order).toEqual([2, 0, 1]);
    expect(marks).toEqual(['○', '▲', '◎']);
  });

  it('入力と同じ並びで返す（順位の並びではない）', () => {
    const { marks } = assignMarks(rows([0.1, 0.6, 0.3]));
    expect(marks).toEqual(['▲', '◎', '○']);
  });
});

describe('接戦の注記', () => {
  it('差が差の標準誤差の 2 倍以内なら接戦', () => {
    // 3 位 10.3 % と 4 位 9.3 %。2400 試行では標準誤差は約 0.6 ポイントずつで、差の標準誤差は約 0.85 ポイント。
    // 差 1.0 ポイントは 2 倍（1.7 ポイント）以内に入る。
    const { closeCalls } = assignMarks(rows([0.458, 0.245, 0.103, 0.093, 0.059, 0.029, 0.012]));
    const pairs = closeCalls.map((c) => [c.rankA, c.rankB]);
    expect(pairs).toContainEqual([3, 4]);
    // 1 位と 2 位は離れている。
    expect(pairs).not.toContainEqual([1, 2]);
  });

  it('差が 2 倍を超えれば接戦にしない（10.3 % と 8.5 % は、2400 試行なら区別できる）', () => {
    const { closeCalls } = assignMarks(rows([0.458, 0.245, 0.103, 0.085, 0.059, 0.029, 0.012]));
    expect(closeCalls.map((c) => [c.rankA, c.rankB])).not.toContainEqual([3, 4]);
  });

  it('差の標準誤差は、2 頭の標準誤差の二乗和の平方根である', () => {
    const a = 0.3;
    const b = 0.2;
    const n = 1000;
    const se = Math.sqrt(winRateStandardError(a, n) ** 2 + winRateStandardError(b, n) ** 2);
    // 差 0.1 がちょうど 2 se のところで境目になる。n を調整して両側を作る。
    const edge = (trials: number) => assignMarks([{ winRate: a, trials }, { winRate: b, trials }]).closeCalls.length;
    expect(0.1 / se).toBeGreaterThan(2); // n = 1000 では離れている
    expect(edge(1000)).toBe(0);
    expect(edge(100)).toBe(1); // 試行が少なければ、同じ差でも接戦になる
  });

  it('試行が少ないほど、接戦になりやすい', () => {
    const few = assignMarks(rows([0.3, 0.25, 0.1], 50)).closeCalls.length;
    const many = assignMarks(rows([0.3, 0.25, 0.1], 20000)).closeCalls.length;
    expect(few).toBeGreaterThan(many);
  });

  it('両方とも勝率 0 の組は見ない', () => {
    const { closeCalls } = assignMarks(rows([0.6, 0.4, 0, 0, 0, 0, 0]));
    expect(closeCalls.filter((c) => c.gap === 0)).toEqual([]);
  });

  it('見るのは 6 位までの隣り合う組だけ', () => {
    // 7 位と 8 位の差はごく小さいが、印に関係しないので注記しない。
    const { closeCalls } = assignMarks(rows([0.5, 0.2, 0.1, 0.08, 0.05, 0.03, 0.0101, 0.01]));
    expect(closeCalls.every((c) => c.rankB <= 6)).toBe(true);
  });
});

describe('標準誤差', () => {
  it('二項分布の標準誤差', () => {
    expect(winRateStandardError(0.5, 100)).toBeCloseTo(0.05, 10);
    expect(winRateStandardError(0, 100)).toBe(0);
    expect(winRateStandardError(1, 100)).toBe(0);
    expect(winRateStandardError(0.5, 0)).toBe(0);
  });
});
