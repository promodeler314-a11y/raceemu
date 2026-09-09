import { useMemo } from 'react';
import { achievementCurve } from '../../../../packages/solver/src/critical.ts';
import { GOAL_LABEL, STATUS_LABEL, type Goal, type TargetStatus } from '../../../../packages/solver/src/target.ts';
import { useStore } from '../store.ts';
import { Panel } from './Inputs.tsx';

const fieldCls =
  'w-full rounded-sm border border-rule2 bg-surface px-2 py-1 text-sm';
const labelCls = 'block text-xs text-ink3';

const STATUSES: TargetStatus[] = ['stamina', 'speed', 'power', 'guts', 'wisdom'];
const GOALS: Goal[] = [{ kind: 'maxSpurt' }, { kind: 'finish' }];

/** 臨界値の分布。単系列なので凡例は置かず、見出しで何かを示す。 */
function CriticalHistogram({ values, from, to }: { values: Float64Array; from: number; to: number }) {
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
      <h3 className="text-sm font-medium">臨界値の分布</h3>
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
              fill="#2a78d6"
            >
              <title>
                {(from + i * bins.width).toFixed(0)} から {(from + (i + 1) * bins.width).toFixed(0)}: {count} 件
              </title>
            </rect>
          );
        })}
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
  const { inverseStatus, inverseGoal, inverseCount, inverseResult, running, progress, setInverse, solveInverse, cancel } =
    useStore();

  const curve = useMemo(
    () => (inverseResult === null ? null : achievementCurve(inverseResult.values)),
    [inverseResult],
  );

  return (
    <Panel title="逆算">
      <p className="mb-3 text-xs text-ink3">
        目標を先に決めて、必要なステータスを求める。試行ごとに目標を満たす最小値を探し、その分布から達成率ごとの必要値を読む。
        返すのは最小値なので、この水準では持久力温存の側に落ちる。つまり<strong>位置取り調整をほとんど払わない走りを前提にした答え</strong>である。
        調整が毎回起きる前提だと、必要なスタミナは 170 から 210 ほど上がる。
      </p>
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
            <span className="text-sm text-ink3">
              {progress} / {inverseCount}
            </span>
          </>
        )}
      </div>

      {inverseResult !== null && curve !== null && (
        <div className="mt-4 space-y-4">
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
              {curve.map(({ rate, value }) => (
                <tr key={rate} className="border-b border-rule last:border-0">
                  <th scope="row" className="py-1 text-left font-normal text-ink3">
                    {(rate * 100).toFixed(0)} %
                  </th>
                  <td className="py-1 text-right tabular-nums">
                    {Number.isNaN(value) ? '範囲外' : value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <CriticalHistogram
            values={inverseResult.values}
            from={inverseResult.from}
            to={inverseResult.to}
          />

          <p className="text-xs text-ink3">
            {GOAL_LABEL[inverseResult.goal.kind]}を目標に、{inverseResult.values.length} 試行。
            探し方は{inverseResult.method === 'bisect' ? '二分探索' : '全走査'}。
            レース {inverseResult.races.toLocaleString()} 本、
            {(inverseResult.elapsedMs / 1000).toFixed(2)} 秒。
            {inverseResult.method === 'scan' &&
              '完走は 1 試行の中で単調に変わらないため、二分探索は使えない。'}
          </p>
        </div>
      )}
    </Panel>
  );
}
