// このファイルは packages/data/scripts/build-order-rate-table.py が生成する。手で編集しない。

/**
 * 順位率の条件から、その条件を満たす順位の境界への対応表。
 *
 * 順位率の定義そのものは確定していないが、対応する頭数を 9 と 12 に限れば
 * 表で足りる。表は本家のスキルデータの注記から組み立てており、
 * 実際に使われている条件はすべて埋まっている。
 * docs/order-condition.md 2 節を参照。
 */
export interface OrderRateBoundary {
  /** この順位以降が条件を満たす（>= と > の場合） */
  readonly atLeast?: number;
  /** この順位以内が条件を満たす（<= と < の場合） */
  readonly atMost?: number;
}

/** キーは `${operator}:${value}:${頭数}` */
export const orderRateBoundaries: Readonly<Record<string, OrderRateBoundary>> = {
  '>=:20:9': { atLeast: 2 },
  '>=:20:12': { atLeast: 3 },
  '>=:25:9': { atLeast: 3 },
  '>=:25:12': { atLeast: 3 },
  '>=:30:9': { atLeast: 3 },
  '>=:30:12': { atLeast: 4 },
  '>=:40:9': { atLeast: 4 },
  '>=:40:12': { atLeast: 5 },
  '>=:45:9': { atLeast: 4 },
  '>=:45:12': { atLeast: 5 },
  '>=:50:9': { atLeast: 5 },
  '>=:50:12': { atLeast: 6 },
  '>=:60:9': { atLeast: 5 },
  '>=:60:12': { atLeast: 7 },
  '>=:65:9': { atLeast: 6 },
  '>=:65:12': { atLeast: 8 },
  '>=:70:9': { atLeast: 6 },
  '>=:70:12': { atLeast: 8 },
  '>=:80:9': { atLeast: 7 },
  '>=:80:12': { atLeast: 9 },
  '>:40:9': { atLeast: 5 },
  '>:40:12': { atLeast: 6 },
  '>:50:9': { atLeast: 6 },
  '>:50:12': { atLeast: 7 },
  '<=:20:9': { atMost: 2 },
  '<=:20:12': { atMost: 3 },
  '<=:30:9': { atMost: 3 },
  '<=:30:12': { atMost: 4 },
  '<=:40:9': { atMost: 4 },
  '<=:40:12': { atMost: 5 },
  '<=:50:9': { atMost: 5 },
  '<=:50:12': { atMost: 6 },
  '<=:60:9': { atMost: 5 },
  '<=:60:12': { atMost: 7 },
  '<=:65:9': { atMost: 6 },
  '<=:65:12': { atMost: 8 },
  '<=:70:9': { atMost: 6 },
  '<=:70:12': { atMost: 8 },
  '<=:75:9': { atMost: 7 },
  '<=:75:12': { atMost: 9 },
  '<=:80:9': { atMost: 7 },
  '<=:80:12': { atMost: 9 },
  '<=:90:9': { atMost: 8 },
  '<=:90:12': { atMost: 10 },
  '<:80:9': { atMost: 8 },
  '<:80:12': { atMost: 10 },
};

/**
 * 順位率の帯を「ずっと維持しているか」で見る条件。
 *
 * `order_rate_in20_continue` は順位率 20 以前を、`order_rate_out40_continue` は
 * 順位率 40 以降を、レースの開始からその時点まで一度も外れていないことを指す。
 * 値は常に 1 で、真偽として使われる。
 *
 * 実際にスキルデータに現れるのは次の 8 種類である。
 */
export const ORDER_RATE_CONTINUE_TYPES: readonly string[] = [
  'order_rate_in20_continue',
  'order_rate_in40_continue',
  'order_rate_in50_continue',
  'order_rate_in80_continue',
  'order_rate_out20_continue',
  'order_rate_out40_continue',
  'order_rate_out50_continue',
  'order_rate_out70_continue',
];

/**
 * 帯の条件から順位の境界を引く。
 * `in` は順位率がその値以前、`out` は以降。対応表は 9 頭立てと 12 頭立てだけを埋めてある。
 */
export function resolveOrderRateContinue(
  type: string,
  gateCount: number,
): OrderRateBoundary | undefined {
  const matched = /^order_rate_(in|out)(\d+)_continue$/.exec(type);
  if (matched === null) return undefined;
  const operator = matched[1] === 'in' ? '<=' : '>=';
  return orderRateBoundaries[`${operator}:${matched[2]}:${gateCount}`];
}
