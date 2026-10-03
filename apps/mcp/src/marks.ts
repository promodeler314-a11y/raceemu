/**
 * 予想印。勝率の順位から機械的に付ける。シミュレーションが返すものではない。
 * docs/mcp-design.md 3.4 節を参照。
 *
 * | 印 | 規則 |
 * | --- | --- |
 * | ◎ | 勝率 1 位 |
 * | ○ | 勝率 2 位 |
 * | ▲ | 勝率 3 位 |
 * | △ | 勝率 4 位と 5 位 |
 * | ☆ | 6 位以下で、勝率が最も高く、かつ 3 % 以上の 1 頭 |
 * | 無印 | それ以外 |
 */

export type Mark = '◎' | '○' | '▲' | '△' | '☆' | '';

export interface MarkInput {
  /** 0 から 1 */
  readonly winRate: number;
  readonly trials: number;
}

export interface CloseCall {
  /** 入力の添字。順位の高いほうが先 */
  readonly a: number;
  readonly b: number;
  /** 順位（1 始まり）。a が上、b がその次 */
  readonly rankA: number;
  readonly rankB: number;
  /** 勝率の差。0 から 1 */
  readonly gap: number;
}

export interface MarkResult {
  /** 入力と同じ並び */
  readonly marks: readonly Mark[];
  /** 勝率の高い順の添字 */
  readonly order: readonly number[];
  /** 隣り合う順位で、差が誤差の範囲にあるもの。印の順位を断言できない箇所 */
  readonly closeCalls: readonly CloseCall[];
}

/** ☆ に要る勝率の下限 */
export const LONGSHOT_MIN_WIN_RATE = 0.03;

/** 勝率の標準誤差。二項分布のもの。 */
export function winRateStandardError(winRate: number, trials: number): number {
  if (trials <= 0) return 0;
  return Math.sqrt((winRate * (1 - winRate)) / trials);
}

/**
 * 印を付ける。
 *
 * 隣り合う順位の差が、差の標準誤差の 2 倍以内なら「接戦」とする。差の標準誤差は
 * 2 頭それぞれの標準誤差の二乗和の平方根である。**印の付け方は勝率の順位だけを見るので、
 * この注記が、順位が乱数の種で入れ替わりうることを補う。**
 * 6 位までの隣り合う組（1-2 位から 5-6 位）だけを見る。両方とも勝率 0 の組は、順位に意味が無いので見ない。
 */
export function assignMarks(rows: readonly MarkInput[]): MarkResult {
  // 勝率の高い順。同率は入力の順を保つ。
  const order = rows.map((_, index) => index).sort((a, b) => rows[b]!.winRate - rows[a]!.winRate || a - b);
  const marks: Mark[] = new Array<Mark>(rows.length).fill('');
  const top: Mark[] = ['◎', '○', '▲', '△', '△'];
  order.forEach((index, rank) => {
    if (rank < top.length) marks[index] = top[rank]!;
  });
  // ☆ は 6 位以下で最も勝率が高い 1 頭。同率なら入力の順で先の 1 頭。
  const longshot = order[top.length];
  if (longshot !== undefined && rows[longshot]!.winRate >= LONGSHOT_MIN_WIN_RATE) marks[longshot] = '☆';

  const closeCalls: CloseCall[] = [];
  // 5 位と 6 位の組まで。6 位は ☆ の候補で、△ との境目が印に関わる。6 位と 7 位の差は印に関係しない。
  const limit = Math.min(order.length - 1, top.length);
  for (let rank = 0; rank < limit; rank++) {
    const a = order[rank]!;
    const b = order[rank + 1]!;
    const pa = rows[a]!.winRate;
    const pb = rows[b]!.winRate;
    if (pa === 0 && pb === 0) continue;
    const se = Math.sqrt(
      winRateStandardError(pa, rows[a]!.trials) ** 2 + winRateStandardError(pb, rows[b]!.trials) ** 2,
    );
    const gap = pa - pb;
    if (gap <= 2 * se) closeCalls.push({ a, b, rankA: rank + 1, rankB: rank + 2, gap });
  }
  return { marks, order, closeCalls };
}
