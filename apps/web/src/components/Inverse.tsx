import { useMemo } from 'react';
import {
  achievementCurve,
  ADJUSTMENT_COUNT_BUCKETS,
  pickAdjustmentCount,
} from '../../../../packages/solver/src/critical.ts';
import { GOAL_LABEL, STATUS_LABEL, type Goal, type TargetStatus } from '../../../../packages/solver/src/target.ts';
import { useStore } from '../store.ts';
import { Panel } from './Inputs.tsx';

/** 回数の見出し。最後の区切りはそれ以上をまとめて受け持つ。 */
function bucketLabel(count: number): string {
  return count < ADJUSTMENT_COUNT_BUCKETS - 1 ? `${count} 回` : `${count} 回以上`;
}

const fieldCls =
  'w-full rounded-sm border border-rule2 bg-surface px-2 py-1 text-sm';
const labelCls = 'block text-xs text-ink3';

const STATUSES: TargetStatus[] = ['stamina', 'speed', 'power', 'guts', 'wisdom'];
const GOALS: Goal[] = [{ kind: 'maxSpurt' }, { kind: 'finish' }];

/**
 * 臨界値の分布。単系列なので凡例は置かず、見出しで何かを示す。
 *
 * `current` にいまの設定値を渡すと、その位置に破線を引く。
 * 表の達成率だけを見ても「自分がどこにいるか」が分からないためである。
 */
function CriticalHistogram({
  values,
  from,
  to,
  current,
}: {
  values: Float64Array;
  from: number;
  to: number;
  current?: number;
}) {
  const bins = useMemo(() => {
    const binCount = 40;
    const width = (to - from) / binCount;
    const counts = new Array<number>(binCount).fill(0);
    let unreachable = 0;
    for (const value of values) {
      if (Number.isNaN(value)) {
        unreachable++;
        continue;
      }
      counts[Math.min(binCount - 1, Math.max(0, Math.floor((value - from) / width)))]! += 1;
    }
    return { counts, width, unreachable, peak: Math.max(1, ...counts) };
  }, [values, from, to]);

  const barWidth = 100 / bins.counts.length;
  return (
    <div>
      <h3 className="text-sm font-medium">
        臨界値の分布
        {current !== undefined && current >= from && current <= to && (
          <span className="ml-2 text-xs font-normal text-ink3">
            破線はいまの設定値 <span className="num">{current}</span>
          </span>
        )}
      </h3>
      <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="mt-2 h-28 w-full">
        {bins.counts.map((count, i) => {
          const height = (count / bins.peak) * 28;
          return (
            <rect
              key={i}
              x={i * barWidth + 0.15}
              y={30 - height}
              width={barWidth - 0.3}
              height={height}
              rx={0.3}
              className="fill-s1"
            >
              <title>
                {(from + i * bins.width).toFixed(0)} から {(from + (i + 1) * bins.width).toFixed(0)}: {count} 件
              </title>
            </rect>
          );
        })}
        {current !== undefined && current >= from && current <= to && (
          <line
            x1={((current - from) / (to - from)) * 100}
            x2={((current - from) / (to - from)) * 100}
            y1={0}
            y2={30}
            stroke="currentColor"
            strokeWidth={0.3}
            strokeDasharray="1 1"
            className="text-ink2"
          />
        )}
      </svg>
      <div className="flex justify-between text-xs text-ink3">
        <span>{from}</span>
        <span>{to}</span>
      </div>
      {bins.unreachable > 0 && (
        <p className="mt-1 text-xs text-ink3">
          範囲内では達成できなかった試行が {bins.unreachable} 件ある。
        </p>
      )}
    </div>
  );
}

export function InversePanel() {
  const {
    inverseStatus,
    inverseGoal,
    inverseCount,
    inverseByAdjustmentCount,
    inverseResult,
    running,
    progress,
    setInverse,
    solveInverse,
    cancel,
  } = useStore();
  const uma = useStore((s) => s.uma);

  const curve = useMemo(
    () => (inverseResult === null ? null : achievementCurve(inverseResult.values)),
    [inverseResult],
  );

  const byCountCurves = useMemo(() => {
    if (inverseResult?.byCount === undefined) return null;
    const byCount = inverseResult.byCount;
    const buckets: { count: number; curve: { rate: number; value: number }[] }[] = [];
    for (let count = 0; count < ADJUSTMENT_COUNT_BUCKETS; count++) {
      const values = pickAdjustmentCount(byCount, count);
      if (values.every((value) => Number.isNaN(value))) continue;
      buckets.push({ count, curve: achievementCurve(values) });
    }
    return buckets;
  }, [inverseResult]);

  return (
    <Panel title="逆算">
      <p className="mb-3 text-xs text-ink3">
        目標を先に決めて、必要なステータスを求める。試行ごとに目標を満たす最小値を探し、その分布から達成率ごとの必要値を読む。
        返すのは最小値なので、この水準では持久力温存の側に落ちる。つまり<strong>位置取り調整をほとんど払わない走りを前提にした答え</strong>である。
        調整が毎回起きる前提だと、必要なスタミナは 170 から 210 ほど上がる。
        下の「位置取り調整の回数ごとに表示」を付けると、調整が 0 回・1 回・2 回…だけ起きた場合の必要値をそれぞれ求める。
        同じ試行でもステータスの値によって調整が起きるかどうかが変わるため、これは全走査になり通常より遅い。
      </p>
      <label className="mb-3 flex items-center gap-2 text-xs text-ink3">
        <input
          type="checkbox"
          checked={inverseByAdjustmentCount}
          onChange={(e) => setInverse({ byAdjustmentCount: e.target.checked })}
        />
        位置取り調整の回数ごとに表示する（遅くなる）
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <label className="block">
          <span className={labelCls}>求めるステータス</span>
          <select
            className={fieldCls}
            value={inverseStatus}
            onChange={(e) => setInverse({ status: e.target.value as TargetStatus })}
          >
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABEL[status]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>目標</span>
          <select
            className={fieldCls}
            value={inverseGoal.kind}
            onChange={(e) =>
              setInverse({ goal: GOALS.find((g) => g.kind === e.target.value) ?? { kind: 'maxSpurt' } })
            }
          >
            {GOALS.map((goal) => (
              <option key={goal.kind} value={goal.kind}>
                {GOAL_LABEL[goal.kind]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className={labelCls}>試行回数</span>
          <input
            type="number"
            className={fieldCls}
            value={inverseCount}
            min={50}
            max={20000}
            step={100}
            onChange={(e) => setInverse({ count: Number(e.target.value) })}
          />
        </label>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          className="rounded-sm bg-primary-bg px-4 py-1.5 text-sm text-primary-fg disabled:opacity-50"
          onClick={() => void solveInverse()}
          disabled={running}
        >
          {running ? '計算中' : '逆算する'}
        </button>
        {running && (
          <>
            <button
              type="button"
              className="rounded-sm border border-rule2 px-3 py-1.5 text-sm"
              onClick={cancel}
            >
              中断
            </button>
            <span className="num text-sm text-ink3">
              {progress} / {inverseCount}
            </span>
          </>
        )}
        {inverseResult !== null && !running && (
          <span className="num text-xs text-ink3">
            レース {inverseResult.races.toLocaleString()} 本 ・{' '}
            {(inverseResult.elapsedMs / 1000).toFixed(2)} 秒 ・ 探し方は
            {inverseResult.method === 'bisect' ? '二分探索' : '全走査'}
          </span>
        )}
      </div>

      {inverseResult !== null && curve !== null && (
        <div className="mt-4 space-y-4">
          {byCountCurves !== null && byCountCurves.length > 0 ? (
            <div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-rule text-xs text-ink3">
                      <th className="py-1 text-left font-normal">達成率</th>
                      {byCountCurves.map(({ count }) => (
                        <th key={count} className="py-1 text-right font-normal whitespace-nowrap">
                          調整{bucketLabel(count)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {byCountCurves[0]!.curve.map((row, i) => (
                      <tr key={row.rate} className="border-b border-rule last:border-0">
                        <th scope="row" className="py-1 text-left font-normal text-ink3">
                          {(row.rate * 100).toFixed(0)} %
                        </th>
                        {byCountCurves.map(({ count, curve: bucketCurve }) => (
                          <td key={count} className="num py-1 text-right">
                            {Number.isNaN(bucketCurve[i]!.value) ? '範囲外' : bucketCurve[i]!.value}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-ink3">
                列は「調整がちょうどこの回数だけ起きた場合」に必要な最小{STATUS_LABEL[inverseResult.status]}
                。実際に何回起きるかは運なので、安全を見るなら右の列を見る。いまの
                {STATUS_LABEL[inverseResult.status]}は <span className="num">{uma[inverseResult.status]}</span>。
              </p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-rule text-xs text-ink3">
                  <th className="py-1 text-left font-normal">達成率</th>
                  <th className="py-1 text-right font-normal">
                    必要な{STATUS_LABEL[inverseResult.status]}
                  </th>
                </tr>
              </thead>
              <tbody>
                {curve.map(({ rate, value }, i) => {
                  // いまの設定値で届いている行のうち、いちばん達成率の高いもの。
                  // 表だけでは「自分がどこにいるか」が読み取れない。
                  const reached =
                    !Number.isNaN(value) &&
                    uma[inverseResult.status] >= value &&
                    (curve[i + 1] === undefined ||
                      Number.isNaN(curve[i + 1]!.value) ||
                      uma[inverseResult.status] < curve[i + 1]!.value);
                  return (
                    <tr
                      key={rate}
                      className={`border-b border-rule last:border-0 ${reached ? 'bg-acc-tint' : ''}`}
                    >
                      <th
                        scope="row"
                        className={`py-1 text-left font-normal ${reached ? 'font-semibold text-acc-ink' : 'text-ink3'}`}
                      >
                        {(rate * 100).toFixed(0)} %
                        {reached && <span className="ml-2 text-[11px] font-normal">いまここ</span>}
                      </th>
                      <td className="num py-1 text-right">
                        {Number.isNaN(value) ? '範囲外' : value}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <CriticalHistogram
            values={inverseResult.values}
            from={inverseResult.from}
            to={inverseResult.to}
            current={uma[inverseResult.status]}
          />

          <p className="text-xs text-ink3">
            {GOAL_LABEL[inverseResult.goal.kind]}を目標に、{inverseResult.values.length} 試行。
            {inverseResult.byCount !== undefined
              ? '回数ごとの内訳は二分探索では拾えないため、全走査になっている。'
              : inverseResult.method === 'scan' &&
                '完走は 1 試行の中で単調に変わらないため、二分探索は使えず全走査になる。'}
          </p>
        </div>
      )}
    </Panel>
  );
}
