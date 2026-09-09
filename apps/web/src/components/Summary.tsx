import { approximateTypeToState } from '../../../../packages/sim/src/skill/approximate.ts';
import type { SkillData } from '../../../../packages/sim/src/skill/types.ts';
import { formatTime, percentile } from '../format.ts';
import { currentTrackDetail, gameData, useStore, type Snapshot } from '../store.ts';
import { TimeHistogram } from './Charts.tsx';
import { Panel } from './Inputs.tsx';

function percent(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)} %` : '-';
}

function signed(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return '-';
  return `${value > 0 ? '+' : value < 0 ? '−' : '±'}${Math.abs(value).toFixed(digits)}`;
}

/** そのスキルの発動条件に、他馬の位置などを確率で近似している判定が含まれるか。 */
function hasApproximateCondition(skill: SkillData): boolean {
  return skill.invokes.some((invoke) =>
    invoke.conditions.some((group) => group.some((c) => c.type in approximateTypeToState)),
  );
}

const PHASE_LABELS = ['序盤', '中盤', '終盤', 'ラスト'];

export function SummaryOutput() {
  const summary = useStore((s) => s.summary);
  const results = useStore((s) => s.results);
  const track = useStore((s) => s.track);
  const showTrial = useStore((s) => s.showTrial);
  const snapshots = useStore((s) => s.snapshots);
  const skillSummaries = useStore((s) => s.skillSummaries);
  const detail = currentTrackDetail(track);

  if (summary === null) {
    return (
      <Panel title="結果">
        <p className="text-sm text-ink3">まだ実行していない。</p>
      </Panel>
    );
  }

  // スナップショットは新しい順に並ぶ。最初に保存した 1 件を基準スナップショットとして使う。
  const baseline: Snapshot | undefined = snapshots.length > 0 ? snapshots[snapshots.length - 1] : undefined;
  const baselineDelta = baseline === undefined ? Number.NaN : summary.all.averageTime - baseline.summary.all.averageTime;
  const spurtRateDelta =
    baseline === undefined ? Number.NaN : (summary.spurtRate - baseline.summary.spurtRate) * 100;

  const times = results.map((r) => r.raceTime).sort((a, b) => a - b);
  const goalSp = results.map((r) => r.goalSp).sort((a, b) => a - b);
  const standardErrorOfMean = (() => {
    const n = times.length;
    if (n < 2) return Number.NaN;
    const mean = times.reduce((a, b) => a + b, 0) / n;
    const variance = times.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
    return Math.sqrt(variance / n);
  })();
  const goalSpP5 = percentile(goalSp, 0.05);

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
      <p className="text-xs text-ink3">
        <span data-testid="trial-count">{summary.all.count.toLocaleString('ja-JP')}</span> 試行 ・{' '}
        {(summary.elapsedMs / 1000).toFixed(2)} 秒
        {detail !== undefined && ` ・ ${detail.name}`}
      </p>

      {/* 主数字とタイル。結果パネルは画面の半分ほどの幅しかないので、横並びにはしない。 */}
      <div className="mt-3 flex flex-col gap-4">
        <div className="flex flex-col gap-1 border-b border-rule pb-3">
          <span className="text-xs text-ink3">平均タイム</span>
          <span
            data-testid="average-time"
            className="font-mono text-4xl font-semibold tabular-nums leading-none"
          >
            {formatTime(summary.all.averageTime)}
          </span>
          <span className="text-xs text-ink3">
            {baseline === undefined ? (
              'スナップショットを保存すると基準比を表示'
            ) : (
              <>
                基準スナップショット比{' '}
                <span className="font-mono tabular-nums">{signed(baselineDelta)}</span> 秒{' '}
                {baselineDelta < 0 ? '短縮' : baselineDelta > 0 ? '延長' : '同じ'}
              </>
            )}
            {Number.isFinite(standardErrorOfMean) && (
              <>
                {' '}
                ・ 標準誤差{' '}
                <span className="font-mono tabular-nums">±{standardErrorOfMean.toFixed(3)}</span> 秒
              </>
            )}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-ink3">最速タイム</span>
            <span className="font-mono text-lg font-semibold tabular-nums">{formatTime(summary.all.bestTime)}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-ink3">最遅タイム</span>
            <span className="font-mono text-lg font-semibold tabular-nums">{formatTime(summary.all.worstTime)}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-ink3">完走率</span>
            <span className="font-mono text-lg font-semibold tabular-nums">{percent(summary.finishRate)}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-ink3">最大スパート率</span>
            <span className="font-mono text-lg font-semibold tabular-nums">{percent(summary.spurtRate)}</span>
            {Number.isFinite(spurtRateDelta) && (
              <span className="text-xs text-ink3">
                基準比 <span className="font-mono tabular-nums">{signed(spurtRateDelta, 1)}</span> pt
              </span>
            )}
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-ink3">ゴール時の残り体力</span>
            <span className="font-mono text-lg font-semibold tabular-nums">
              {summary.all.averageGoalSp.toFixed(1)}
            </span>
            {Number.isFinite(goalSpP5) && (
              <span className="text-xs text-ink3">
                下位 5% で <span className="font-mono tabular-nums">{goalSpP5.toFixed(1)}</span>
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 分布 */}
      <div className="mt-5">
        <TimeHistogram />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="text-xs text-ink3">この 1 本を見る:</span>
        {picks.map(({ label, entry }) => (
          <button
            key={label}
            type="button"
            className="rounded-sm border border-rule2 px-2 py-0.5 text-xs"
            onClick={() => showTrial(entry!.trial)}
          >
            {label}（{formatTime(entry!.time)}）
          </button>
        ))}
      </div>

      {/* スキル別の発動状況 */}
      {skillSummaries.length > 0 && (
        <div className="mt-5">
          <div className="flex items-baseline gap-2">
            <h3 className="text-sm font-medium">スキル別の発動状況</h3>
            <span className="text-xs text-ink3">
              △ 発動条件に近似が含まれるスキル ・ 数値は {summary.all.count.toLocaleString('ja-JP')} 試行の平均
            </span>
          </div>
          <div className="mt-2 overflow-x-auto">
            <table data-testid="skill-table" className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b border-rule text-xs text-ink3">
                  <th scope="col" className="py-1 pr-3 text-left font-normal">スキル</th>
                  <th scope="col" className="py-1 pr-3 text-right font-normal">発動率</th>
                  <th scope="col" className="py-1 pr-3 text-right font-normal">平均発動位置</th>
                  <th scope="col" className="py-1 pr-3 text-right font-normal">2 回発動</th>
                  <th scope="col" className="py-1 text-left font-normal">発動位置の分布</th>
                </tr>
              </thead>
              <tbody>
                {skillSummaries.map((skill) => {
                  const data = gameData.skillsById.get(skill.skillId);
                  const approximate = data !== undefined && hasApproximateCondition(data);
                  const peak = Math.max(...skill.phaseRates, 0.0001);
                  return (
                    <tr key={skill.skillId} className="border-b border-rule last:border-0">
                      <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                        {data?.name ?? skill.skillId}
                        {approximate && (
                          <span className="ml-1 text-ink3" title="発動条件に近似が含まれる">
                            △
                          </span>
                        )}
                      </th>
                      <td className="py-1.5 pr-3 text-right tabular-nums">
                        <div className="flex items-center justify-end gap-2">
                          <div className="h-1.5 w-20 rounded-full bg-sunken">
                            <div
                              className="h-1.5 rounded-full bg-s1"
                              style={{ width: `${(skill.triggerRate * 100).toFixed(1)}%` }}
                            />
                          </div>
                          <span className="w-14 font-mono">{(skill.triggerRate * 100).toFixed(1)} %</span>
                        </div>
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                        {Number.isFinite(skill.averageFirstPosition)
                          ? `${skill.averageFirstPosition.toFixed(0)} m`
                          : '—'}
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono tabular-nums">
                        {skill.triggerRate === 0 ? '—' : `${(skill.doubleTriggerRate * 100).toFixed(1)} %`}
                      </td>
                      <td className="py-1.5">
                        {skill.triggerRate === 0 ? (
                          <span className="text-ink3">—</span>
                        ) : (
                          <svg width="72" height="16" viewBox="0 0 72 16" aria-hidden="true">
                            {skill.phaseRates.map((rate, i) => {
                              const h = Math.max((rate / peak) * 15, rate > 0 ? 1.5 : 0);
                              return (
                                <rect
                                  key={PHASE_LABELS[i]}
                                  x={i * 18 + 2}
                                  y={16 - h}
                                  width={14}
                                  height={h}
                                  className="fill-s1"
                                >
                                  <title>
                                    {PHASE_LABELS[i]}: {(rate * 100).toFixed(1)} %
                                  </title>
                                </rect>
                              );
                            })}
                          </svg>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Panel>
  );
}
