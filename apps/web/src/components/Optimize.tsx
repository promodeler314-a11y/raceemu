import { useMemo } from 'react';
import { costModelFor, gameData, useStore } from '../store.ts';
import { Panel } from './Inputs.tsx';

const fieldCls =
  'w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900';

const name = (id: string) => gameData.skillsById.get(id)?.name ?? id;
const seconds = (value: number) => `${value >= 0 ? '' : '-'}${Math.abs(value).toFixed(3)}`;

export function OptimizePanel() {
  const skillIds = useStore((s) => s.skillIds);
  const budget = useStore((s) => s.optimizeBudget);
  const setBudget = useStore((s) => s.setOptimizeBudget);
  const run = useStore((s) => s.runOptimize);
  const cancel = useStore((s) => s.cancel);
  const running = useStore((s) => s.optimizeRunning);
  const busy = useStore((s) => s.running);
  const log = useStore((s) => s.optimizeLog);
  const result = useStore((s) => s.optimizeResult);
  const useField = useStore((s) => s.useField);
  const hintLevels = useStore((s) => s.hintLevels);

  const costModel = useMemo(() => costModelFor(hintLevels), [hintLevels]);
  const poolCost = costModel.totalCost(skillIds);

  return (
    <Panel title="組み合わせ探索">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        いま選んでいる {skillIds.length} 個を候補として、予算に収まる範囲で最もタイムを縮める組み合わせを探す。
        候補をすべて取ると {poolCost} pt かかる。
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="block text-xs text-neutral-500 dark:text-neutral-400">
            スキルポイントの予算
          </span>
          <input
            type="number"
            className={fieldCls}
            value={budget}
            min={0}
            max={20000}
            step={50}
            onChange={(e) => setBudget(Number(e.target.value))}
          />
        </label>
        <div className="flex items-end gap-3">
          <button
            type="button"
            className="rounded bg-neutral-900 px-4 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
            onClick={() => void run()}
            disabled={running || busy || skillIds.length < 2}
          >
            {running ? '探索中' : '探索する'}
          </button>
          {running && (
            <button
              type="button"
              className="rounded border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
              onClick={cancel}
            >
              中断
            </button>
          )}
        </div>
      </div>
      {!useField && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-500">
          順位条件を判定していない。脚質と噛み合わない条件のスキルが過大に評価される。
        </p>
      )}

      {log.length > 0 && (
        <ol className="mt-3 space-y-0.5 text-xs text-neutral-500 dark:text-neutral-400">
          {log.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ol>
      )}

      {result !== null && (
        <div className="mt-4 space-y-4">
          <div>
            <h3 className="text-xs font-semibold">
              最良の構成（{result.cost} pt / 予算 {budget} pt）
            </h3>
            <div className="mt-1 flex flex-wrap gap-1">
              {result.best.map((id) => (
                <span
                  key={id}
                  className="rounded-full border border-neutral-300 px-2 py-0.5 text-xs dark:border-neutral-700"
                >
                  {name(id)} <span className="text-neutral-500">{costModel.cost(id)} pt</span>
                </span>
              ))}
            </div>
            <p className="mt-1 text-sm">
              何も取らない場合より <strong>{seconds(result.bestDiff.mean)}</strong> 秒速い（誤差{' '}
              {(2 * result.bestDiff.stdError).toFixed(3)} 秒）
            </p>
            {result.bestDiff.spurtFlips > 0 && (
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                最大スパートの成否が入れ替わった試行が {result.bestDiff.spurtFlips} 本ある。
                この差は一部の試行が大きく動かしている。
              </p>
            )}
          </div>

          <div className="overflow-x-auto">
            <h3 className="text-xs font-semibold">最終段まで残った構成</h3>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              短縮量の大きい順に並べてある。
              採用は誤差の 2 倍を超えて改善したときだけ動かすので、点推定が少し上でも採用とは限らない。
            </p>
            <table className="mt-1 w-full text-xs">
              <thead className="text-neutral-500 dark:text-neutral-400">
                <tr>
                  <th className="py-1 pr-2" />
                  <th className="text-right">短縮（秒）</th>
                  <th className="text-right">pt</th>
                  <th className="pl-3 text-left">構成</th>
                </tr>
              </thead>
              <tbody>
                {result.top.slice(0, 8).map((entry) => {
                  const chosen = [...entry.skillIds].sort().join(',') === [...result.best].sort().join(',');
                  return (
                    <tr
                      key={entry.skillIds.join(',')}
                      className="border-t border-neutral-200 dark:border-neutral-800"
                    >
                      <td className="py-1 pr-2 whitespace-nowrap">
                        {chosen && (
                          <span className="rounded border border-neutral-400 px-1 dark:border-neutral-600">
                            採用
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap text-right tabular-nums">
                        {seconds(entry.diff.mean)}
                        <span className="text-neutral-500"> ± {(2 * entry.diff.stdError).toFixed(3)}</span>
                      </td>
                      <td className="text-right tabular-nums">{entry.cost}</td>
                      <td className="pl-3">{entry.skillIds.map(name).join('、')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="overflow-x-auto">
            <h3 className="text-xs font-semibold">単体で足したときの効き</h3>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              並べ替えの手がかりに使う粗い見積もりである。効きが 0 のものは、この設定では発動していない。
            </p>
            <table className="mt-1 w-full text-xs">
              <thead className="text-neutral-500 dark:text-neutral-400">
                <tr>
                  <th className="py-1 text-left">スキル</th>
                  <th className="text-right">短縮（秒）</th>
                  <th className="text-right">pt</th>
                  <th className="text-right">ミリ秒/pt</th>
                </tr>
              </thead>
              <tbody>
                {result.singles.map((single) => (
                  <tr
                    key={single.skillId}
                    className="border-t border-neutral-200 dark:border-neutral-800"
                  >
                    <td className="py-1">{name(single.skillId)}</td>
                    <td className="text-right tabular-nums">{single.diff.mean.toFixed(4)}</td>
                    <td className="text-right tabular-nums">{single.cost}</td>
                    <td className="text-right tabular-nums">
                      {(1000 * single.efficiency).toFixed(3)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            レース {result.races.toLocaleString()} 本、構成の評価 {result.evaluations} 回、
            {(result.elapsedMs / 1000).toFixed(1)} 秒、{result.rounds} 巡
          </p>
        </div>
      )}
    </Panel>
  );
}
