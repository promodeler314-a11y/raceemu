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
