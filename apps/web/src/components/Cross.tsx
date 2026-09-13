import { Fragment, useMemo } from 'react';
import type { CrossCourseRow } from '../../../../packages/sim/src/parallel/cross.ts';
import { formatDuration } from '../format.ts';
import { crossCourses, distancesOf, estimateCross, useStore, type CrossResult } from '../store.ts';
import { Panel } from './Inputs.tsx';

/**
 * コース横断の評価。
 *
 * 距離とバ場を選ぶと、当たる全コースを同じ個体で走らせて並べる。
 * Umalator の Global Compare にあたる（docs/roadmap.md 3.3 節）。
 *
 * **比較の面の表とは向きが違う。** 設定どうしの比較は列が設定で行が項目だが、
 * こちらは行がコースで列が指標である。コースは最大 26 本あり、列にすると
 * 幅 390 の画面に収まらない。理由は docs/webapp-design.md 6.5 節に書いた。
 */

/** 距離帯の並びと名前。データの `distanceType` と同じ順にする。 */
const CATEGORIES: readonly { readonly key: string; readonly label: string }[] = [
  { key: 'c:SHORT', label: '短距離' },
  { key: 'c:MILE', label: 'マイル' },
  { key: 'c:MIDDLE', label: '中距離' },
  { key: 'c:LONG', label: '長距離' },
];

function seconds(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : '-';
}

function percent(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)} %` : '-';
}

/**
 * 同じ距離の行をひとまとまりにする。
 *
 * タイムは距離が違えば比べても意味が無い。距離帯で選ぶと 1 つの表に
 * 複数の距離が並ぶので、どこまでが比べてよい範囲かを区切りで示す。
 */
interface DistanceGroup {
  readonly distance: number;
  readonly rows: readonly CrossCourseRow[];
  /** この距離でいちばん速かった行。差の基準になる。 */
  readonly best: CrossCourseRow;
}

function groupByDistance(rows: readonly CrossCourseRow[]): DistanceGroup[] {
  // 行は距離の昇順に並んでいる（matchCourses がそう並べる）ので、
  // 隣を見るだけで区切れる。
  const buckets: CrossCourseRow[][] = [];
  for (const row of rows) {
    const last = buckets[buckets.length - 1];
    if (last !== undefined && last[0]!.distance === row.distance) last.push(row);
    else buckets.push([row]);
  }
  return buckets.map((bucket) => ({
    distance: bucket[0]!.distance,
    rows: bucket,
    best: bucket.reduce((a, b) =>
      b.summary.all.averageTime < a.summary.all.averageTime ? b : a,
    ),
  }));
}

/**
 * 平均タイムの差の 95 % 区間。
 *
 * コースどうしは別々に走らせているので、試行を対応付けた引き算はできない。
 * 比較の面の `confidenceInterval` と同じ考え方である。
 */
function confidenceInterval(row: CrossCourseRow, best: CrossCourseRow): number {
  const n1 = row.summary.all.count;
  const n2 = best.summary.all.count;
  if (!Number.isFinite(row.sd) || !Number.isFinite(best.sd) || n1 < 2 || n2 < 2) return Number.NaN;
  return 1.96 * Math.sqrt(row.sd ** 2 / n1 + best.sd ** 2 / n2);
}

export function CrossPanel() {
  const cross = useStore((s) => s.cross);
  const setCross = useStore((s) => s.setCross);
  const run = useStore((s) => s.runCross);
  const cancel = useStore((s) => s.cancel);
  const running = useStore((s) => s.crossRunning);
  const progress = useStore((s) => s.crossProgress);
  const busy = useStore((s) => s.running || s.multiRunning || s.optimizeRunning);
  const result = useStore((s) => s.crossResult);
  const useField = useStore((s) => s.useField);
  const pace = useStore((s) => s.pace);

  // セレクタの中で配列や組を作らない。毎回新しい参照になって描画が止まる。
  const courses = useMemo(() => crossCourses(cross), [cross]);
  const distances = useMemo(() => distancesOf(cross.surface), [cross.surface]);
  const estimate = useMemo(
    () => estimateCross({ pace, useField, count: cross.count, courses: courses.length }),
    [pace, useField, cross.count, courses.length],
  );
  const groups = useMemo(() => (result === null ? [] : groupByDistance(result.rows)), [result]);

  return (
    <Panel title="コース横断">
      <p className="text-xs text-ink3">
        いまの個体を、選んだ距離とバ場に当たる全コースで走らせて並べる。
        チャンピオンズミーティングのコースが決まる前に候補を見るときと、
        育成中に「どのコースなら走れるか」を見るときに使う。
      </p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="block text-xs text-ink3">バ場</span>
          <select
            className="rounded-sm border border-rule2 bg-surface px-2 py-1 text-sm"
            value={cross.surface}
            onChange={(e) => setCross({ surface: Number(e.target.value) })}
            aria-label="バ場"
          >
            <option value={1}>芝</option>
            <option value={2}>ダート</option>
          </select>
        </label>
        <label className="block">
          <span className="block text-xs text-ink3">距離</span>
          <select
            className="rounded-sm border border-rule2 bg-surface px-2 py-1 text-sm"
            value={cross.distanceKey}
            onChange={(e) => setCross({ distanceKey: e.target.value })}
            aria-label="距離"
          >
            {/* 帯はコースが決まる前に見る人、ぴったりの距離は育成中の人が使う */}
            <optgroup label="距離帯">
              {CATEGORIES.map((category) => (
                <option key={category.key} value={category.key}>
                  {category.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="距離">
              {distances.map((distance) => (
                <option key={distance} value={`d:${distance}`}>
                  {distance} m
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label className="block">
          <span className="block text-xs text-ink3">試行回数 / コース</span>
          <input
            type="number"
            className="w-28 rounded-sm border border-rule2 bg-surface px-2 py-1 text-sm"
            value={cross.count}
            min={1}
            max={20000}
            step={100}
            aria-label="コース 1 本あたりの試行回数"
            onChange={(e) => setCross({ count: Number(e.target.value) })}
          />
        </label>
        <button
          type="button"
          className="rounded-sm bg-ink px-4 py-1.5 text-sm text-paper disabled:opacity-50"
          onClick={() => void run()}
          disabled={running || busy || courses.length === 0}
        >
          {running ? '計算中' : 'コースを走らせる'}
        </button>
        {running ? (
          <>
            <button
              type="button"
              className="rounded-sm border border-rule2 px-3 py-1.5 text-sm"
              onClick={cancel}
            >
              中断
            </button>
            <span className="num text-sm text-ink3">
              {progress} / {courses.length} コース
            </span>
          </>
        ) : (
          <span
            className="pb-1.5 text-xs text-ink3"
            data-testid="cross-estimate"
            title={
              estimate.measured
                ? '直前の実測から出している'
                : '作り付けの目安。1 回走らせると実測に置き換わる'
            }
          >
            {courses.length} コース ・ {estimate.measured ? '見込み' : '目安'} 約{' '}
            {formatDuration(estimate.ms)}
          </span>
        )}
      </div>

      <p className="mt-2 text-xs text-ink3">
        {courses.length === 0
          ? 'この距離とバ場に当たるコースがありません。'
          : `当たるコース ${courses.length} 本を ${cross.count.toLocaleString('ja-JP')} 試行ずつ、順に走らせる。`}
        {useField
          ? ' 順位条件はコースごとに束を作り直して判定する。そのぶんコース 1 本あたり数秒が余計にかかる。'
          : ' 順位条件は満たしている前提（本家と同じ）で走らせる。設定の面で切り替えられる。'}
      </p>

      {result !== null && <CrossTable groups={groups} result={result} />}
    </Panel>
  );
}

function CrossTable({
  groups,
  result,
}: {
  groups: readonly DistanceGroup[];
  result: CrossResult;
}) {
  return (
    <div className="mt-4">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 text-xs text-ink3">
        <span className="num">
          {result.rows.length} コース ・ {result.trials.toLocaleString('ja-JP')} 試行 / コース ・{' '}
          {(result.elapsedMs / 1000).toFixed(1)} 秒
        </span>
        <span>{result.useField ? '順位条件を判定した' : '順位条件は満たしている前提'}</span>
        {result.cancelled && <span>中断したので、走り終えたコースまでである</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[30rem] text-xs" data-testid="cross-table">
          <thead className="text-ink3">
            <tr>
              <th scope="col" className="pb-1 pr-3 text-left font-normal">
                コース
              </th>
              <th scope="col" className="pb-1 pr-2 text-right font-normal">
                平均タイム
              </th>
              <th scope="col" className="pb-1 pr-2 text-right font-normal">
                最速との差
              </th>
              <th scope="col" className="pb-1 pr-2 text-right font-normal">
                最大スパート率
              </th>
              <th scope="col" className="pb-1 pr-2 text-right font-normal">
                完走率
              </th>
              <th scope="col" className="pb-1 text-right font-normal">
                平均残り体力
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <Fragment key={group.distance}>
                {groups.length > 1 && (
                  <tr className="bg-sunken">
                    <td colSpan={6} className="num py-1 text-[11px] font-semibold text-ink2">
                      {group.distance} m
                    </td>
                  </tr>
                )}
                {group.rows.map((row) => {
                  const delta = row.summary.all.averageTime - group.best.summary.all.averageTime;
                  const interval = confidenceInterval(row, group.best);
                  return (
                    <tr
                      key={`${row.location}:${row.course}`}
                      className="border-b border-rule last:border-0"
                    >
                      <th scope="row" className="py-1 pr-3 text-left font-normal">
                        {row.locationName} {row.courseName}
                      </th>
                      <td className="num py-1 pr-2 text-right">
                        {seconds(row.summary.all.averageTime)}
                      </td>
                      <td
                        className={`num py-1 pr-2 text-right ${delta === 0 ? 'font-semibold' : 'text-ink3'}`}
                      >
                        {delta === 0 ? '最速' : `+${delta.toFixed(3)}`}
                        {delta !== 0 && Number.isFinite(interval) && (
                          <span className="ml-1 text-[11px]">±{interval.toFixed(3)}</span>
                        )}
                      </td>
                      <td className="num py-1 pr-2 text-right">{percent(row.summary.spurtRate)}</td>
                      <td
                        className={`num py-1 pr-2 text-right ${row.summary.finishRate < 1 ? 'font-semibold' : ''}`}
                      >
                        {percent(row.summary.finishRate)}
                      </td>
                      <td className="num py-1 text-right text-ink3">
                        {row.summary.all.averageGoalSp.toFixed(1)}
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink3">
        「最速との差」は<strong>同じ距離の中</strong>で比べたものである。距離が違う行のあいだで
        タイムを比べても意味が無い。±はその差の 95 % 区間で、コースどうしを別々に走らせて
        求めたものなので、同じ試行番号で引き算する探索の面の区間より広い。
        {result.useField
          ? ' 順位条件は相手の分布（設定の面の「相手の想定」）に対して判定している。相手を変えれば発動率も変わる。'
          : ' 順位条件つきのスキルは満たしている前提で発動するので、完走率も最大スパート率も甘めに出る。'}
      </p>
    </div>
  );
}
