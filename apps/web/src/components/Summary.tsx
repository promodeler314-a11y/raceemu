import { currentTrackDetail, useStore } from '../store.ts';
import { TimeHistogram } from './Charts.tsx';
import { Panel } from './Inputs.tsx';

function seconds(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(3)} 秒` : '-';
}

function percent(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)} %` : '-';
}

export function SummaryOutput() {
  const summary = useStore((s) => s.summary);
  const results = useStore((s) => s.results);
  const track = useStore((s) => s.track);
  const showTrial = useStore((s) => s.showTrial);
  const detail = currentTrackDetail(track);

  if (summary === null) {
    return (
      <Panel title="結果">
        <p className="text-sm text-neutral-500">まだ実行していない。</p>
      </Panel>
    );
  }

  const baseline = detail === undefined ? Number.NaN : detail.finishTimeMax / 1.18;
  const rows: [string, string][] = [
    ['試行回数', String(summary.all.count)],
    ['平均タイム', seconds(summary.all.averageTime)],
    ['中央値', seconds(summary.all.medianTime)],
    ['最速タイム', seconds(summary.all.bestTime)],
    ['最遅タイム', seconds(summary.all.worstTime)],
    ['基準との差', Number.isFinite(baseline) ? `${(summary.all.averageTime - baseline).toFixed(3)} 秒` : '-'],
    ['最大スパート率', percent(summary.spurtRate)],
    ['完走率', percent(summary.finishRate)],
    ['平均残り体力', summary.all.averageGoalSp.toFixed(1)],
    ['スパート平均余剰', summary.all.averageSpDiff.toFixed(1)],
    ['所要時間', `${(summary.elapsedMs / 1000).toFixed(2)} 秒`],
  ];

  // 分布の端を選んで、その 1 本の中身を開けるようにする。
  const sorted = results
    .map((r, trial) => ({ trial, time: r.raceTime }))
    .sort((a, b) => a.time - b.time);
  const picks = [
    { label: '最速', entry: sorted[0] },
    { label: '中央', entry: sorted[Math.floor(sorted.length / 2)] },
    { label: '最遅', entry: sorted[sorted.length - 1] },
  ].filter((p) => p.entry !== undefined);

  return (
    <Panel title="結果">
      <table className="w-full text-sm">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label} className="border-b border-neutral-100 last:border-0 dark:border-neutral-800">
              <th scope="row" className="py-1 text-left font-normal text-neutral-500 dark:text-neutral-400">
                {label}
              </th>
              <td className="py-1 text-right tabular-nums">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-4">
        <TimeHistogram />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-neutral-500 dark:text-neutral-400">この 1 本を見る:</span>
        {picks.map(({ label, entry }) => (
          <button
            key={label}
            type="button"
            className="rounded border border-neutral-300 px-2 py-0.5 text-xs dark:border-neutral-700"
            onClick={() => showTrial(entry!.trial)}
          >
            {label}（{entry!.time.toFixed(2)} 秒）
          </button>
        ))}
      </div>
    </Panel>
  );
}
