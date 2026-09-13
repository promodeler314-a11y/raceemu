import type { RaceState } from '../state.ts';

/**
 * 他のウマ娘との位置関係で決まる条件を、フィールドから実際に計算する。
 *
 * 本家は他馬を持たないので、追い抜きも前後のウマ娘も固定の確率で近似するしかなかった
 * （`skill/approximate.ts`）。本リポジトリはフィールドを渡したときに他頭の位置の
 * 時系列を持っているので、**位置の比較だけで決まるものは確率を引かずに数えられる。**
 * docs/order-condition.md 5.3 節と docs/order-field.md 8 節を参照。
 *
 * **フィールドが無いときは近似のままである。** 本家との突き合わせ
 * （`packages/sim/test/reference.test.ts`）はフィールドを渡さないので、
 * ここを入れても単騎モデルの挙動は 1 ビットも変わらない。
 *
 * 更新は近似と同じく 1 秒に 1 回で、状態の持ち方（連続している秒数を数える、
 * 回数を積む、その秒の変化だけを置く）も近似に合わせてある。
 * 条件の読み側（`skill/condition.ts` の `checkSpecialState`）を変えずに
 * 中身だけを差し替えるためである。
 */

/** 1 秒前の値。追い抜きと詰め寄られの判定に要る。 */
export interface FieldSnapshot {
  /** 1 位を 1 とする順位 */
  readonly order: number;
  /** すぐ前にいるウマ娘との距離。前がいなければ無限。 */
  readonly frontGap: number;
  /** すぐ後ろにいるウマ娘との距離。後ろがいなければ無限。 */
  readonly behindGap: number;
}

/**
 * フィールドがあるとき、確率を引かずに位置から決める条件の型。
 *
 * 分類（`skill/classify.ts`）と感度分析（`packages/solver/src/sensitivity.ts`）が
 * 同じ表を見る。ここに載る型は `approximateRateScale` の倍率が効かない。
 */
export const FIELD_COMPUTED_TYPES: ReadonlySet<string> = new Set([
  'change_order_onetime',
  'is_overtake',
  'overtake_target_time',
  'infront_near_lane_time',
  'near_count',
  'behind_near_lane_time',
  'change_order_up_end_after',
  'change_order_up_middle',
  'is_surrounded',
  'overtake_target_no_order_up_time',
  'change_order_up_finalcorner_after',
  'near_infront_count',
]);

/**
 * 上の型が読む `specialState` の鍵。
 *
 * `skill/approximate.ts` の `approximateTypeToState` と同じ対応だが、
 * ここは鍵の側だけが要るので値を並べてある。フィールドがあるときは、
 * この鍵の近似を回さずに `updateFieldConditions` が置く。
 */
export const FIELD_COMPUTED_STATES: ReadonlySet<string> = new Set([
  'change_order_onetime',
  'overtake',
  'overtaken',
  'infront_near_lane',
  'near_count',
  'behind_near_lane',
  'change_order_up_end_after',
  'change_order_up_middle',
  'is_surrounded',
  'overtake_target_no_order_up_time',
  'change_order_up_finalcorner_after',
  'near_infront_count',
]);

/** 続いていれば 1 秒ぶん足し、切れていれば 0 に戻す。近似の `StartContinue` と同じ持ち方。 */
function hold(previous: number, continuing: boolean): number {
  return continuing ? previous + 1 : 0;
}

/**
 * 位置関係で決まる条件を、そのフレームの位置から置き直す。
 *
 * 呼ぶのは 1 秒に 1 回（`calculator.ts` の `changeSecond`）。
 * フィールドが無いときは何もしない。出走前も判定しない（全頭が同じ位置にいて
 * 誰もが 1 位に見えるため。docs/order-field.md 4.4 節）。
 */
export function updateFieldConditions(state: RaceState): void {
  const field = state.field;
  const simulation = state.simulation;
  if (field === null) return;
  if (state.beforeStart) {
    // 出走前は比べる相手が無い。1 秒前の値も持たない（出走直後を追い抜きにしない）。
    simulation.fieldPrevious = null;
    return;
  }

  const frame = simulation.frameElapsed;
  const position = simulation.startPosition;
  const special = simulation.specialState;
  const near = state.setting.nearLaneMeters;

  const order = field.order(frame, position);
  const frontGap = field.distanceToFront(frame, position);
  const behindGap = field.distanceToBehind(frame, position);
  const counts = field.countNear(frame, position, near);
  const previous = simulation.fieldPrevious;

  // 近くのウマ娘の人数。前がひらけているか（near_infront_count == 0）も同じ数え方。
  special['near_count'] = counts.front + counts.behind;
  special['near_infront_count'] = counts.front;

  // すぐ前・すぐ後ろにウマ娘がいる時間。続いた秒数を数える。
  const inFront = frontGap <= near;
  const behind = behindGap <= near;
  special['infront_near_lane'] = hold(special['infront_near_lane'] ?? 0, inFront);
  special['behind_near_lane'] = hold(special['behind_near_lane'] ?? 0, behind);
  // 囲まれている。レーンを持たないので、前にも後ろにも近くにいることを「囲まれ」と読む。
  special['is_surrounded'] = hold(special['is_surrounded'] ?? 0, inFront && behind);

  // 1 秒ぶんの順位の変化。追い抜けば負、追い抜かれれば正になる
  // （スキルデータの `change_order_onetime < 0` が「追い抜いて」である）。
  const delta = previous === null ? 0 : order - previous.order;
  special['change_order_onetime'] = delta;

  // 追い抜きモード。この 1 秒で追い抜いたか、近くの前の相手に差を詰めている。
  const closingFront = previous !== null && inFront && frontGap < previous.frontGap;
  special['overtake'] = hold(special['overtake'] ?? 0, delta < 0 || closingFront);

  // 詰め寄られ。近くの後ろの相手が差を詰めてきている。
  const pressed = previous !== null && behind && behindGap < previous.behindGap;
  special['overtaken'] = hold(special['overtaken'] ?? 0, pressed);
  // 詰め寄られていて、まだ抜かれていない。
  special['overtake_target_no_order_up_time'] = hold(
    special['overtake_target_no_order_up_time'] ?? 0,
    pressed && delta <= 0,
  );

  // 追い抜いた回数。区間ごとに積む。区間の切り方は近似と同じにしてある
  // （中盤は中盤のあいだだけ、終盤以降は終盤から、最終コーナー以降はコーナーから）。
  // 1 秒で 2 人抜けば 2 回と数える。条件が数えているのは「追い抜いた回数」だからである。
  const gained = previous === null ? 0 : Math.max(0, previous.order - order);
  if (gained > 0) {
    const phase = state.currentPhase;
    if (phase === 1) special['change_order_up_middle'] = (special['change_order_up_middle'] ?? 0) + gained;
    if (phase >= 2) {
      special['change_order_up_end_after'] = (special['change_order_up_end_after'] ?? 0) + gained;
    }
    if (state.isAfterFinalCorner) {
      special['change_order_up_finalcorner_after'] =
        (special['change_order_up_finalcorner_after'] ?? 0) + gained;
    }
  }

  simulation.fieldPrevious = { order, frontGap, behindGap };
}
