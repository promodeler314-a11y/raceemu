import { useMemo } from 'react';
import { formatTime, percentile } from '../format.ts';
import {
  gameData,
  skillFidelities,
  useStore,
  type Snapshot,
  type TriggerBand,
} from '../store.ts';
import { TimeHistogram } from './Charts.tsx';
import { FidelityLegend, FidelityMark } from './Fidelity.tsx';
import { Panel } from './Inputs.tsx';

function percent(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)} %` : '-';
}

function signed(value: number, digits = 3): string {
  if (!Number.isFinite(value)) return '-';
  return `${value > 0 ? '+' : value < 0 ? '−' : '±'}${Math.abs(value).toFixed(digits)}`;
}

const PHASE_LABELS = ['序盤', '中盤', '終盤', 'ラスト'];

/**
 * 発動率が相手の強さでどこまで動くか。
 *
 * 幅が広いスキルは、相手の想定を変えると評価がひっくり返る。
 * docs/order-field.md 4.5 節を参照。
 */
function BandCell({ band }: { band: TriggerBand | undefined }) {
  if (band === undefined) {
    return <td className="py-1.5 pr-3 text-right text-ink3">—</td>;
  }
  const low = Math.min(band.weaker, band.base, band.stronger);
  const high = Math.max(band.weaker, band.base, band.stronger);
  const width = high - low;
  return (
    <td
      className="py-1.5 pr-3 text-right font-mono tabular-nums"
      title={`相手 −100 で ${(band.weaker * 100).toFixed(1)} %、+100 で ${(band.stronger * 100).toFixed(1)} %`}
    >
      <span className={width >= 0.2 ? 'text-warn-ink' : undefined}>
        {(low * 100).toFixed(0)} – {(high * 100).toFixed(0)} %
      </span>
    </td>
  );
}

export function SummaryOutput() {
  const summary = useStore((s) => s.summary);
  const results = useStore((s) => s.results);
  const track = useStore((s) => s.track);
  const showTrial = useStore((s) => s.showTrial);
  const snapshots = useStore((s) => s.snapshots);
  const skillSummaries = useStore((s) => s.skillSummaries);
  const band = useStore((s) => s.band);
  const bandRunning = useStore((s) => s.bandRunning);
  const runBand = useStore((s) => s.runBand);
  const running = useStore((s) => s.running);
  const startSpAtRun = useStore((s) => s.summaryStartSp);
  const useField = useStore((s) => s.useField);

  // 近似の印。値は個別に選び、組み立ては useMemo で行う。
  // セレクタの中で組み立てると毎回新しい参照が返り、描画が止まる。
  const uma = useStore((s) => s.uma);
  const options = useStore((s) => s.options);
  const debuffCounts = useStore((s) => s.debuffCounts);
  const skillIds = useStore((s) => s.skillIds);
  const shownIds = useMemo(() => skillSummaries.map((s) => s.skillId), [skillSummaries]);
  const fidelities = useMemo(
    () => skillFidelities({ uma, track, skillIds, options, debuffCounts, useField }, shownIds),
    [uma, track, skillIds, options, debuffCounts, useField, shownIds],
  );

  if (summary === null) {
    return (
      <Panel title="結果">
        <p className="text-sm text-ink3">まだ実行していません。</p>
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
        {/* コースはヘッダの「いまの条件」に出ているので繰り返さない */}
      </p>

      {/* 主数字とタイル。結果パネルは画面の半分ほどの幅しかないので、横並びにはしない。 */}
      <div className="mt-3 flex flex-col gap-4">
        <div className="flex flex-col gap-1 border-b border-rule pb-3">
          <span className="text-xs text-ink3">平均タイム</span>
          <span
            data-testid="average-time"
            className="font-mono text-4xl font-bold tabular-nums leading-none"
          >
            {formatTime(summary.all.averageTime)}
          </span>
          <span className="text-xs text-ink3">
            {baseline === undefined ? (
              'スナップショットを保存すると基準比を表示します'
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
        {/*
          脇の指標は 4 つに絞る。最速と最遅は「タイムの幅」として 1 つにまとめた。
          5 つを同じ大きさで格子に並べると空きマスができ、重さの違いも見えない
          （docs/ui-audit-race-emulator.md 第1節「数値タイル」）。4 つなら 2 列でも 4 列でも埋まる。
        */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-ink3">タイムの幅</span>
            <span className="font-mono text-base font-bold tabular-nums">
              {formatTime(summary.all.bestTime)}
            </span>
            <span className="text-xs text-ink3">
              〜 <span className="font-mono tabular-nums">{formatTime(summary.all.worstTime)}</span>
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-ink3">完走率</span>
            <span className="font-mono text-base font-bold tabular-nums">{percent(summary.finishRate)}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-ink3">最大スパート率</span>
            <span className="font-mono text-base font-bold tabular-nums">{percent(summary.spurtRate)}</span>
            {Number.isFinite(spurtRateDelta) && (
              <span className="text-xs text-ink3">
                基準比 <span className="font-mono tabular-nums">{signed(spurtRateDelta, 1)}</span> pt
              </span>
            )}
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-ink3">ゴール時の残り体力</span>
            <span className="font-mono text-base font-bold tabular-nums">
              {summary.all.averageGoalSp.toFixed(1)}
            </span>
            {/* 数だけでは多いのか少ないのかが読めないので、スタート時の体力に対する割合を添える（#105） */}
            {Number.isFinite(startSpAtRun) && startSpAtRun > 0 && (
              <span className="text-xs text-ink3">
                スタート時 <span className="font-mono tabular-nums">{startSpAtRun.toFixed(0)}</span> の{' '}
                <span className="font-mono tabular-nums">
                  {((summary.all.averageGoalSp / startSpAtRun) * 100).toFixed(1)}
                </span>{' '}
                %
              </span>
            )}
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
            {/* タイムは上の「タイムの幅」と分布の軸に出ているので、ボタンには繰り返さない */}
            {label}
          </button>
        ))}
      </div>

      {/* スキル別の発動状況 */}
      {skillSummaries.length > 0 && (
        <div className="mt-5">
          <div className="flex items-baseline gap-2">
            <h3 className="text-sm font-bold">スキル別の発動状況</h3>
            <span className="text-xs text-ink3">
              数値は全試行の平均
            </span>
            {/*
              発動率は相手の想定に依る。1 つの数字だけを出すと、そのことが見えない。
              3 通りぶん余計に走るので、押したときだけ測る。
              docs/order-field.md 4.5 節を参照。
            */}
            <button
              type="button"
              className="ml-auto rounded-sm border border-rule2 px-2 py-0.5 text-xs disabled:opacity-50"
              onClick={() => void runBand()}
              disabled={bandRunning || running || !useField}
              title={
                useField
                  ? '相手の強さを −100、0、+100 で走らせ、発動率がどこまで動くかを出します'
                  : '順位条件を判定していないので、相手の強さを振っても発動率は動きません'
              }
            >
              {bandRunning ? '測定中' : '相手の強さによる幅の測定'}
            </button>
          </div>
          <div className="mt-2 overflow-x-auto">
            <table data-testid="skill-table" className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b border-rule text-xs text-ink3">
                  <th scope="col" className="py-1 pr-3 text-left font-normal">スキル</th>
                  <th scope="col" className="py-1 pr-3 text-right font-normal">発動率</th>
                  {band !== null && (
                    <th
                      scope="col"
                      className="py-1 pr-3 text-right font-normal"
                      title="相手を 100 弱くしたとき ― 100 強くしたとき"
                    >
                      相手の強さで振れる幅
                    </th>
                  )}
                  <th scope="col" className="py-1 pr-3 text-right font-normal">平均発動位置</th>
                  <th scope="col" className="py-1 pr-3 text-right font-normal">2 回発動</th>
                  <th scope="col" className="py-1 text-left font-normal">発動位置の分布</th>
                </tr>
              </thead>
              <tbody>
                {skillSummaries.map((skill) => {
                  const data = gameData.skillsById.get(skill.skillId);
                  const peak = Math.max(...skill.phaseRates, 0.0001);
                  return (
                    <tr key={skill.skillId} className="border-b border-rule last:border-0">
                      <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                        {data?.name ?? skill.skillId}
                        <FidelityMark fidelity={fidelities.get(skill.skillId)} />
                      </th>
                      <td className="py-1.5 pr-3 text-right tabular-nums">
                        <div className="flex items-center justify-end gap-2">
                          <div className="h-1.5 w-20 rounded-full bg-sunken">
                            <div
                              className="h-1.5 rounded-full bg-s1"
                              style={{ width: `${(skill.triggerRate * 100).toFixed(1)}%` }}
                            />
                          </div>
                          <span className="w-16 whitespace-nowrap font-mono">{(skill.triggerRate * 100).toFixed(1)} %</span>
                        </div>
                      </td>
                      {band !== null && <BandCell band={band[skill.skillId]} />}
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
          {/* 印の意味。発動率をどこまで信じてよいかの話なので、表のすぐ下に置く。 */}
          <div className="mt-2">
            <FidelityLegend useField={useField} />
          </div>
        </div>
      )}
    </Panel>
  );
}
