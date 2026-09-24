import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { ORDER_RATE_CONTINUE_TYPES, orderRateBoundaries } from '../src/data/orderRate.ts';
import {
  ORDER_RATE_MAX_GATE_COUNT,
  ORDER_RATE_NOTED_GATE_COUNTS,
  orderRateBoundaryOf,
  orderRateByFormula,
  orderRateContinueBoundaries,
  orderRateContinueOf,
} from '../src/data/orderRateResolve.ts';

/**
 * 順位率の境界の番人。
 *
 * 9 頭と 12 頭は注記の表だけを引き、それ以外の頭数は表を全部再現する式 H で延ばす。
 * 延ばし方の根拠は「H が表の全項目と一致する」ことと「当てはまる式の族の中で延ばし方が
 * 1 通りに決まる」ことなので、ここが崩れたら延ばした境界を信じる理由が無くなる。
 * docs/order-condition.md 2.2 節を参照。
 */

const OPERATORS = ['<=', '>=', '>', '<'] as const;

/** 表の鍵を分解する。`${operator}:${value}:${頭数}` */
const tableEntries = Object.entries(orderRateBoundaries).map(([key, boundary]) => {
  const [operator, value, gateCount] = key.split(':');
  return { key, operator: operator!, value: Number(value), gateCount: Number(gateCount), boundary };
});

/** 式 H の T。`<=` と `>=` はこの順位が境界になる。 */
const formulaT = (value: number, gateCount: number) => Math.floor((value * (gateCount - 1)) / 100) + 1;

/**
 * スキルデータに現れる順位率の条件。条件（conditions）と前提（preConditions）の両方を見る。
 * `pairs` は `order_rate` の (演算子, 値)、`continueTypes` は帯を維持する条件の型。
 */
function usedOrderRates(): { pairs: Map<string, { operator: string; value: number }>; continueTypes: Set<string> } {
  const pairs = new Map<string, { operator: string; value: number }>();
  const continueTypes = new Set<string>();
  for (const skill of loadGameData().skills) {
    for (const invoke of skill.invokes) {
      for (const group of [...invoke.conditions, ...invoke.preConditions]) {
        for (const condition of group) {
          if (condition.type === 'order_rate') {
            pairs.set(`${condition.operator}:${condition.value}`, {
              operator: condition.operator,
              value: condition.value,
            });
          } else if (/^order_rate_(in|out)\d+_continue$/.test(condition.type)) {
            continueTypes.add(condition.type);
          }
        }
      }
    }
  }
  return { pairs, continueTypes };
}
const used = usedOrderRates();

describe('式 H と注記の表', () => {
  it('表は 9 頭と 12 頭の 46 項目である', () => {
    // docs/order-condition.md 2.1 節。使われている 22 通りに、帯の条件だけが使う <= 20 を足した 23 通り。
    expect(tableEntries).toHaveLength(46);
    expect(new Set(tableEntries.map((e) => e.gateCount))).toEqual(new Set([9, 12]));
    // 表だけを引く頭数は、表の持つ頭数と同じである。
    expect(ORDER_RATE_NOTED_GATE_COUNTS).toEqual(new Set([9, 12]));
  });

  it('式 H が表の 46 項目すべてを再現する', () => {
    for (const entry of tableEntries) {
      expect(orderRateByFormula(entry.operator, entry.value, entry.gateCount), entry.key).toEqual(
        entry.boundary,
      );
    }
  });

  it('表にある項目は表から引き、延ばした印を付けない', () => {
    for (const entry of tableEntries) {
      const resolved = orderRateBoundaryOf(entry.operator, entry.value, entry.gateCount);
      expect(resolved, entry.key).toEqual({ boundary: entry.boundary, extrapolated: false });
      // 表の値そのものを返す（写しではない）。
      expect(resolved!.boundary, entry.key).toBe(entry.boundary);
    }
  });

  it('よく使われる条件を 18 頭へ延ばした値', () => {
    // T = floor(X × 17 / 100) + 1
    expect(orderRateBoundaryOf('<=', 50, 18)).toEqual({ boundary: { atMost: 9 }, extrapolated: true });
    expect(orderRateBoundaryOf('>=', 40, 18)).toEqual({ boundary: { atLeast: 7 }, extrapolated: true });
    expect(orderRateBoundaryOf('>', 50, 18)).toEqual({ boundary: { atLeast: 10 }, extrapolated: true });
    expect(orderRateBoundaryOf('<', 80, 18)).toEqual({ boundary: { atMost: 15 }, extrapolated: true });
  });
});

describe('2〜18 頭へ延ばした境界', () => {
  const values = Array.from({ length: 101 }, (_, x) => x);

  // 下の 2 件は式そのものの性質なので、9 頭と 12 頭も含めて式を直接見る。
  // 判定に使うかどうか（9 頭と 12 頭は表だけ）は、その次の 2 件が見る。
  it('式の境界が 1 から頭数 + 1 に収まる', () => {
    for (let n = 2; n <= ORDER_RATE_MAX_GATE_COUNT; n++) {
      for (const operator of OPERATORS) {
        for (const x of values) {
          const boundary = orderRateByFormula(operator, x, n);
          expect(boundary, `${operator}:${x}:${n}`).toBeDefined();
          const rank = boundary!.atMost ?? boundary!.atLeast!;
          expect(rank, `${operator}:${x}:${n}`).toBeGreaterThanOrEqual(1);
          expect(rank, `${operator}:${x}:${n}`).toBeLessThanOrEqual(n + 1);
          // <= と >= は必ず誰かが満たせる境界になる。
          if (operator === '<=' || operator === '>=') {
            expect(rank, `${operator}:${x}:${n}`).toBeLessThanOrEqual(n);
          }
          // 片方だけを持つ。
          const { atMost, atLeast } = boundary!;
          expect(atMost === undefined, `${operator}:${x}:${n}`).toBe(operator === '>=' || operator === '>');
          expect(atLeast === undefined, `${operator}:${x}:${n}`).toBe(operator === '<=' || operator === '<');
        }
      }
    }
  });

  it('式の値が大きいほど境界が後ろへ動き、戻らない', () => {
    for (let n = 2; n <= ORDER_RATE_MAX_GATE_COUNT; n++) {
      for (const operator of OPERATORS) {
        let previous = 0;
        for (const x of values) {
          const b = orderRateByFormula(operator, x, n)!;
          const rank = b.atMost ?? b.atLeast!;
          expect(rank, `${operator}:${x}:${n}`).toBeGreaterThanOrEqual(previous);
          previous = rank;
        }
      }
    }
  });

  it('9 頭と 12 頭は表だけを引き、表に無い条件を式で埋めない', () => {
    for (const n of [9, 12]) {
      let listed = 0;
      for (const operator of OPERATORS) {
        for (const x of values) {
          const key = `${operator}:${x}:${n}`;
          const resolved = orderRateBoundaryOf(operator, x, n);
          const row = orderRateBoundaries[key];
          if (row === undefined) {
            // 従来どおり満たしている前提に落とし、未対応として記録させる（skill-coverage.test.ts）。
            expect(resolved, key).toBeUndefined();
          } else {
            expect(resolved, key).toEqual({ boundary: row, extrapolated: false });
            listed++;
          }
        }
      }
      expect(listed, String(n)).toBe(23);
      // 帯の型も同じ。表に無い値（35）は引かない。
      expect(orderRateContinueOf('order_rate_in35_continue', n), String(n)).toBeUndefined();
      expect(orderRateContinueOf('order_rate_out35_continue', n), String(n)).toBeUndefined();
    }
  });

  it('9 頭と 12 頭以外の 1〜18 頭は、式の値に延ばした印を付けて返す', () => {
    for (let n = 1; n <= ORDER_RATE_MAX_GATE_COUNT; n++) {
      if (n === 9 || n === 12) continue;
      for (const operator of OPERATORS) {
        for (const x of values) {
          expect(orderRateBoundaryOf(operator, x, n), `${operator}:${x}:${n}`).toEqual({
            boundary: orderRateByFormula(operator, x, n),
            extrapolated: true,
          });
        }
      }
    }
  });

  it('9 頭と 12 頭以外は延ばした印が付き、9 頭と 12 頭の表にある項目には付かない', () => {
    for (let n = 1; n <= ORDER_RATE_MAX_GATE_COUNT; n++) {
      for (const entry of tableEntries.filter((e) => e.gateCount === 9)) {
        const resolved = orderRateBoundaryOf(entry.operator, entry.value, n)!;
        expect(resolved.extrapolated, `${entry.operator}:${entry.value}:${n}`).toBe(n !== 9 && n !== 12);
      }
    }
  });

  it('頭数が 1〜18 の整数でなければ引かない', () => {
    for (const n of [0, -1, 19, 9.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(orderRateBoundaryOf('<=', 50, n), String(n)).toBeUndefined();
      expect(orderRateContinueOf('order_rate_in50_continue', n), String(n)).toBeUndefined();
      expect(orderRateContinueBoundaries(n).every((b) => b === undefined), String(n)).toBe(true);
    }
  });

  it('未知の演算子や範囲外の値は引かない', () => {
    expect(orderRateBoundaryOf('==', 50, 18)).toBeUndefined();
    expect(orderRateBoundaryOf('<=', 101, 18)).toBeUndefined();
    expect(orderRateBoundaryOf('<=', 12.5, 18)).toBeUndefined();
    // 表に無い値は、9 頭と 12 頭では式で延ばさずに引かない。ほかの頭数では延ばす。
    expect(orderRateBoundaryOf('<=', 25, 9)).toBeUndefined();
    expect(orderRateBoundaryOf('<=', 25, 12)).toBeUndefined();
    expect(orderRateBoundaryOf('<=', 25, 10)).toEqual({ boundary: { atMost: 3 }, extrapolated: true });
  });

  it('何度引いても同じ値を返す（控えを返しても値は変わらない）', () => {
    // 40 は 9 頭と 12 頭の表に <= と >= と > があり、< が無い。引けない側の控えも見る。
    for (let n = 1; n <= ORDER_RATE_MAX_GATE_COUNT; n++) {
      for (const operator of OPERATORS) {
        const first = orderRateBoundaryOf(operator, 40, n);
        const second = orderRateBoundaryOf(operator, 40, n);
        expect(second, `${operator}:40:${n}`).toBe(first);
        if (n !== 9 && n !== 12) {
          expect(first!.boundary).toEqual(orderRateByFormula(operator, 40, n));
        } else {
          expect(first === undefined, `${operator}:40:${n}`).toBe(operator === '<');
        }
      }
    }
  });
});

describe('帯を維持する条件', () => {
  it('in は <=、out は >= として引く', () => {
    for (let n = 1; n <= ORDER_RATE_MAX_GATE_COUNT; n++) {
      for (const type of ORDER_RATE_CONTINUE_TYPES) {
        const [, side, value] = /^order_rate_(in|out)(\d+)_continue$/.exec(type)!;
        const expected = orderRateBoundaryOf(side === 'in' ? '<=' : '>=', Number(value), n);
        expect(orderRateContinueOf(type, n), `${type}:${n}`).toBe(expected);
      }
    }
  });

  it('作り置きの並びが ORDER_RATE_CONTINUE_TYPES と揃う', () => {
    for (let n = 1; n <= ORDER_RATE_MAX_GATE_COUNT; n++) {
      const boundaries = orderRateContinueBoundaries(n);
      expect(boundaries).toHaveLength(ORDER_RATE_CONTINUE_TYPES.length);
      ORDER_RATE_CONTINUE_TYPES.forEach((type, i) => {
        expect(boundaries[i], `${type}:${n}`).toBe(orderRateContinueOf(type, n)!.boundary);
      });
      expect(orderRateContinueBoundaries(n)).toBe(boundaries);
    }
  });

  it('型の形が違えば引かない', () => {
    expect(orderRateContinueOf('order_rate', 9)).toBeUndefined();
    expect(orderRateContinueOf('order_rate_mid50_continue', 9)).toBeUndefined();
  });
});

/**
 * データの取り直しの番人。
 *
 * 9 頭と 12 頭で表に無い条件は、式で埋めずに満たしている前提へ落とす。
 * そのとき skill-coverage.test.ts（9 頭）が未対応の記録で落ちるが、12 頭は見ていない。
 * 表を作り直す生成器（build-order-rate-table.py）は CI でも週次の同期でも回らないので、
 * 注記に無い値がデータに増えたことを、9 頭と 12 頭の両方についてここで捕まえる。
 */
describe('スキルデータに現れる順位率の条件', () => {
  it('条件と前提に現れる順位率が、9 頭と 12 頭ではすべて注記の表から引ける', () => {
    expect(used.pairs.size).toBeGreaterThan(0);
    expect(used.continueTypes.size).toBeGreaterThan(0);
    for (const n of [9, 12]) {
      for (const { operator, value } of used.pairs.values()) {
        const resolved = orderRateBoundaryOf(operator, value, n);
        expect(resolved, `${operator}:${value}:${n}`).toBeDefined();
        expect(resolved!.extrapolated, `${operator}:${value}:${n}`).toBe(false);
      }
      for (const type of used.continueTypes) {
        const resolved = orderRateContinueOf(type, n);
        expect(resolved, `${type}:${n}`).toBeDefined();
        expect(resolved!.extrapolated, `${type}:${n}`).toBe(false);
      }
    }
  });

  it('データに現れる帯の型は、毎フレーム更新している型に含まれる', () => {
    // 含まれない型は calculator.ts が状態を落とさないので、帯を外れても真のままになる。
    const updated = new Set(ORDER_RATE_CONTINUE_TYPES);
    for (const type of used.continueTypes) expect([type, updated.has(type)]).toEqual([type, true]);
  });
});

/**
 * 式 H の二つ目の根拠（docs/order-condition.md 2.2 節）。
 *
 * T = R((X × (n + b) + c) / 100) + d の族（R は切り捨て、切り上げ、四捨五入）を総当たりし、
 * 表の `<=` と `>=` の項目（9 頭と 12 頭の 40 項目）に当てはまる式を集める。
 * 当てはまる式はすべて b = −1 で、いま使われている X と 2〜18 頭では同じ境界を出す。
 * 探索範囲は b が −3〜3、c が −200〜200、d が −2〜3 で、当てはまる式の数（今は 61）は
 * 範囲の切り方で変わるので固定しない。データの取り直しで X が増えたとき、
 * 延ばし方が 1 通りに決まらなくなればここで落ちる。
 */
describe('当てはまる式の族の総当たり', () => {
  const rounders: Record<string, (v: number) => number> = {
    floor: Math.floor,
    ceil: Math.ceil,
    round: (v) => Math.floor(v + 0.5),
  };
  const items = tableEntries
    .filter((e) => e.operator === '<=' || e.operator === '>=')
    .map((e) => ({ ...e, rank: e.boundary.atMost ?? e.boundary.atLeast! }));
  const fits: { name: string; b: number; c: number; d: number; t: (x: number, n: number) => number }[] = [];
  for (const [name, round] of Object.entries(rounders)) {
    for (let b = -3; b <= 3; b++) {
      for (let c = -200; c <= 200; c++) {
        for (let d = -2; d <= 3; d++) {
          const t = (x: number, n: number) => round((x * (n + b) + c) / 100) + d;
          if (items.every((e) => t(e.value, e.gateCount) === e.rank)) fits.push({ name, b, c, d, t });
        }
      }
    }
  }
  const usedValues = new Set<number>([
    ...[...used.pairs.values()].map((p) => p.value),
    ...[...used.continueTypes].map((type) => Number(/(\d+)_continue$/.exec(type)![1])),
  ]);

  it('表の <= と >= は 9 頭と 12 頭の 40 項目で、式 H がその中に含まれる', () => {
    expect(items).toHaveLength(40);
    expect(fits.length).toBeGreaterThan(0);
    // 式 H は R = 切り捨て、b = −1、c = 0、d = 1 にあたる。
    expect(fits.some((f) => f.name === 'floor' && f.b === -1 && f.c === 0 && f.d === 1)).toBe(true);
  });

  it('当てはまる式はすべて b = −1 である', () => {
    for (const f of fits) expect(`${f.name} b=${f.b} c=${f.c} d=${f.d}`).toMatch(/ b=-1 /);
  });

  it('いま使われている X と 2〜18 頭では、当てはまる式がすべて式 H と同じ境界を出す', () => {
    expect(usedValues.size).toBeGreaterThan(0);
    for (let n = 2; n <= ORDER_RATE_MAX_GATE_COUNT; n++) {
      for (const x of usedValues) {
        const predictions = new Set(fits.map((f) => f.t(x, n)));
        expect([...predictions], `X=${x} n=${n}`).toEqual([formulaT(x, n)]);
      }
    }
  });
});
