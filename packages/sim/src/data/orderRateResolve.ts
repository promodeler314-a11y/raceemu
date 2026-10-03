import {
  ORDER_RATE_CONTINUE_TYPES,
  orderRateBoundaries,
  type OrderRateBoundary,
} from './orderRate.ts';

/**
 * 順位率の条件から順位の境界を引く口。判定（`condition.ts`、`calculator.ts`）と
 * 分類（`classify.ts`）はすべてここを通す。
 *
 * 9 頭立てと 12 頭立ては、注記から組み立てた表（`orderRate.ts`、生成物）だけを引く。
 * 表に無い条件は式で埋めず、引けなかったこととして返す。呼び出し側は従来どおり
 * 満たしている前提に落とし、`unsupportedConditions` に記録する。データの取り直しで
 * 注記に無い値が増えたとき、`skill-coverage.test.ts` がそれで気付けるようにするためである。
 *
 * それ以外の頭数は、表の 46 項目をすべて再現する式 H で延ばす。
 *
 *   T = floor(X × (n − 1) / 100) + 1
 *   `<= X` は T 位以内、`>= X` は T 位以降、`> X` は T + 1 位以降、`< X` は T + 1 位以内
 *
 * 式はゲームの実装を確かめたものではなく、注記に当てはめた近似である。
 * 延ばした境界には `extrapolated` を立て、分類で近似の印を付ける。
 * docs/order-condition.md 2.2 節を参照。
 */
export interface ResolvedOrderRate {
  readonly boundary: OrderRateBoundary;
  /** 注記の表に無く、式 H で延ばした境界であるか */
  readonly extrapolated: boolean;
}

/**
 * 注記の表が持つ頭数（9 と 12）。この頭数では式を使わず、表だけを引く。
 * 表の鍵から取るので、生成器（`build-order-rate-table.py` の `HEAD_COUNTS`）と食い違わない。
 */
export const ORDER_RATE_NOTED_GATE_COUNTS: ReadonlySet<number> = new Set(
  Object.keys(orderRateBoundaries).map((key) => Number(key.slice(key.lastIndexOf(':') + 1))),
);

/** 式 H で延ばす頭数の上限。フルゲートの 18 頭である。 */
export const ORDER_RATE_MAX_GATE_COUNT = 18;

/** 式 H で延ばせる頭数か。1〜18 の整数に限る。 */
function isExtensibleGateCount(gateCount: number): boolean {
  return Number.isInteger(gateCount) && gateCount >= 1 && gateCount <= ORDER_RATE_MAX_GATE_COUNT;
}

/**
 * 式 H で境界を求める。表は見ない。
 *
 * 頭数が 1〜18 の整数、値が 0〜100 の整数、演算子が 4 つのどれかのときだけ値を返す。
 * それ以外は undefined で、呼び出し側は従来どおり満たしている前提に落とす。
 * 9 頭と 12 頭でも値を返すが、判定には使わない（`orderRateBoundaryOf` は表だけを引く）。
 *
 * X × (n − 1) は整数なので、100 で割って切り捨てても誤差は出ない
 * （割り切れないときは、商が整数から 0.01 以上離れている）。
 */
export function orderRateByFormula(
  operator: string,
  value: number,
  gateCount: number,
): OrderRateBoundary | undefined {
  if (!isExtensibleGateCount(gateCount)) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > 100) return undefined;
  const t = Math.floor((value * (gateCount - 1)) / 100) + 1;
  switch (operator) {
    case '<=':
      return { atMost: t };
    case '>=':
      return { atLeast: t };
    case '>':
      return { atLeast: t + 1 };
    case '<':
      return { atMost: t + 1 };
    default:
      return undefined;
  }
}

/**
 * 引いた結果の控え。引けなかったことも null として控える。
 *
 * 帯の条件は毎フレーム引き直されるので、表に無い頭数では正規表現と文字列の鍵を
 * 作り続けて重くなっていた。結果は入力だけで決まるので、控えを返しても
 * 判定は 1 ビットも変わらない。
 */
const memo = new Map<string, ResolvedOrderRate | null>();

function resolveUncached(
  operator: string,
  value: number,
  gateCount: number,
): ResolvedOrderRate | null {
  const listed = orderRateBoundaries[`${operator}:${value}:${gateCount}`];
  if (listed !== undefined) return Object.freeze({ boundary: listed, extrapolated: false });
  // 9 頭と 12 頭は表だけを使う。表に無い条件は式で埋めず、引けなかったことにする。
  if (ORDER_RATE_NOTED_GATE_COUNTS.has(gateCount)) return null;
  const formula = orderRateByFormula(operator, value, gateCount);
  if (formula === undefined) return null;
  return Object.freeze({ boundary: Object.freeze(formula), extrapolated: true });
}

/**
 * `order_rate` の条件 1 つの境界を引く。
 *
 * 表にあれば表の値を返す。9 頭と 12 頭で表に無ければ undefined。
 * それ以外の 1〜18 頭では式 H の値を返す。どちらでも引けなければ undefined。
 */
export function orderRateBoundaryOf(
  operator: string,
  value: number,
  gateCount: number,
): ResolvedOrderRate | undefined {
  const key = `${operator}:${value}:${gateCount}`;
  let hit = memo.get(key);
  if (hit === undefined) {
    hit = resolveUncached(operator, value, gateCount);
    // 壊れた頭数（0 や 19 や小数）は表にも式にも無い。控えが膨らまないよう残さない。
    if (isExtensibleGateCount(gateCount)) memo.set(key, hit);
  }
  return hit ?? undefined;
}

const CONTINUE_PATTERN = /^order_rate_(in|out)(\d+)_continue$/;

/**
 * 帯を維持する条件（`order_rate_inX_continue` と `order_rate_outX_continue`）の境界を引く。
 *
 * `in` は順位率 X 以前（`<= X`）、`out` は X 以降（`>= X`）として `orderRateBoundaryOf` に渡す。
 * 9 頭と 12 頭で表に無い値や、型の形が違うときは undefined。
 */
export function orderRateContinueOf(
  type: string,
  gateCount: number,
): ResolvedOrderRate | undefined {
  const matched = CONTINUE_PATTERN.exec(type);
  if (matched === null) return undefined;
  const operator = matched[1] === 'in' ? '<=' : '>=';
  return orderRateBoundaryOf(operator, Number(matched[2]), gateCount);
}

/** 頭数ごとの、`ORDER_RATE_CONTINUE_TYPES` と同じ並びの境界 */
const continueByGateCount = new Map<number, readonly (OrderRateBoundary | undefined)[]>();

/**
 * 帯の型の境界を、`ORDER_RATE_CONTINUE_TYPES` と同じ並びで返す。引けない型は undefined。
 *
 * 毎フレームの更新（`calculator.ts` の `updateOrderRateContinue`）から呼ぶ。
 * 頭数ごとに 1 度だけ作り、あとは同じ配列を返す。
 */
export function orderRateContinueBoundaries(
  gateCount: number,
): readonly (OrderRateBoundary | undefined)[] {
  let hit = continueByGateCount.get(gateCount);
  if (hit === undefined) {
    hit = Object.freeze(
      ORDER_RATE_CONTINUE_TYPES.map((type) => orderRateContinueOf(type, gateCount)?.boundary),
    );
    if (isExtensibleGateCount(gateCount)) continueByGateCount.set(gateCount, hit);
  }
  return hit;
}
