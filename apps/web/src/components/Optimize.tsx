import { useMemo } from 'react';
import { costModelFor, gameData, skillFidelities, useStore } from '../store.ts';
import { countFidelity, FidelityLegend, SkillNameWithMark } from './Fidelity.tsx';
import { Panel } from './Inputs.tsx';
import { PlanInput, ROUTE_LABEL } from './Plan.tsx';
import { ServerSearchInput } from './ServerSearch.tsx';

const fieldCls =
  'w-full rounded-sm border border-rule2 bg-surface px-2 py-1 text-sm';

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
  const setUseField = useStore((s) => s.setUseField);
  const selfConsistent = useStore((s) => s.optimizeSelfConsistent);
  const setSelfConsistent = useStore((s) => s.setOptimizeSelfConsistent);
  const hintLevels = useStore((s) => s.hintLevels);

  const plan = useStore((s) => s.plan);
  const planCandidates = useStore((s) => s.planCandidates);
  // 直前の探索がどちらで回ったか。落ちたときに気付けるよう、結果に添える。
  const ranOnServer = useStore((s) => s.ranOnServer);

  // 近似の印。値は個別に選び、組み立ては useMemo で行う。
  // セレクタの中で組み立てると毎回新しい参照が返り、描画が止まる。
  const uma = useStore((s) => s.uma);
  const track = useStore((s) => s.track);
  const options = useStore((s) => s.options);
  const debuffCounts = useStore((s) => s.debuffCounts);
  const shownIds = useMemo(() => {
    const ids = new Set<string>(skillIds);
    if (result !== null) {
      for (const id of result.best) ids.add(id);
      for (const entry of result.top) for (const id of entry.skillIds) ids.add(id);
      for (const single of result.singles) ids.add(single.skillId);
    }
    return [...ids];
  }, [skillIds, result]);
  const fidelities = useMemo(
    () => skillFidelities({ uma, track, skillIds, options, debuffCounts, useField }, shownIds),
    [uma, track, skillIds, options, debuffCounts, useField, shownIds],
  );
  const bestFidelity = result === null ? null : countFidelity(result.best, fidelities);

  /*
    近似の感度分析の結果。印（△ / ▲）とは別に添える。
    印は「どれだけ怪しいか」を発動条件の型から言い、感度分析は「どれだけ結果が動くか」を
    実測で言う。どちらも近似の話だが、出どころも要る手間も違うので混ぜない。
    docs/solver-design.md 4.1 節を参照。
  */
  const sensitivity = useStore((s) => s.sensitivityResult);
  const sensitivityAxis = useStore((s) => s.sensitivityAxis);
  const shakyInBest = useMemo(() => {
    if (result === null || sensitivity === null) return [];
    const best = new Set(result.best);
    return sensitivity.skills.filter(
      (skill) => best.has(skill.skillId) && skill.widthPerError >= 1,
    );
  }, [result, sensitivity]);

  // 結果の表示に使う費用は、育成計画のときはヒントの割引を含む。
  const levels = plan.source !== 'selected' && planCandidates !== null ? planCandidates.hintLevels : hintLevels;
  const costModel = useMemo(() => costModelFor(levels), [levels]);
  const poolCost = costModel.totalCost(skillIds);
  const routeOf = (id: string) =>
    planCandidates?.entries.find((entry) => entry.skillId === id)?.route ?? null;
  // 初期解に入ったものは限界貢献度を測らない。足しても構成が変わらないためである。
  const marginalOf = (id: string) =>
    result?.marginals.find((entry) => entry.skillId === id) ?? null;

  return (
    <Panel title="組み合わせ探索">
      {plan.source === 'plan' && (
        <p className="text-xs text-ink3">
          育成ウマ娘とデッキ、それに継承から候補を組み立て、予算に収まる範囲で最もタイムを縮める
          組み合わせを探す。固有の継承版は 6 つまでしか積めない。
        </p>
      )}
      {plan.source === 'all' && (
        <p className="text-xs text-ink3">
          買えるスキル全体を候補として、予算に収まる範囲で最もタイムを縮める組み合わせを探す。
          入手経路は問わないので、これは「取れるとしたら何が効くか」への答えである。
        </p>
      )}
      {plan.source === 'selected' && (
        <p className="text-xs text-ink3">
          いま選んでいる {skillIds.length} 個を候補として、予算に収まる範囲で最もタイムを縮める組み合わせを探す。
          候補をすべて取ると {poolCost} pt かかる。
        </p>
      )}
      <div className="mt-3">
        <PlanInput />
      </div>
      <ServerSearchInput />
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="block text-xs text-ink3">
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
            className="rounded-sm bg-primary-bg px-4 py-1.5 text-sm text-primary-fg disabled:opacity-50"
            onClick={() => void run()}
            disabled={running || busy || (plan.source === 'selected' && skillIds.length < 2)}
          >
            {running ? '探索中' : '探索する'}
          </button>
          {running && (
            <button
              type="button"
              className="rounded-sm border border-rule2 px-3 py-1.5 text-sm"
              onClick={cancel}
            >
              中断
            </button>
          )}
          {result !== null && !running && (
            <span className="num text-xs text-ink3" data-testid="optimize-stats">
              {ranOnServer ? 'サーバ' : 'ブラウザ'} ・ レース {result.races.toLocaleString()} 本 ・ 構成の評価{' '}
              {result.evaluations} 回 ・ {(result.elapsedMs / 1000).toFixed(1)} 秒 ・ {result.rounds} 巡
            </span>
          )}
        </div>
      </div>
      {/*
        順位条件の切り替えは設定の面にもあるが、探索の結果を最も大きく動かすのがこれである。
        知らせるだけで切り替えを別の面に置いておくと、warning を読んでも直せない。
      */}
      <label className="mt-2 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={useField}
          onChange={(e) => setUseField(e.target.checked)}
          disabled={running || busy}
        />
        順位条件を判定する
      </label>
      {/*
        自己整合。自分だけがスキルを積むと、相手は置いていかれるだけになり、
        前寄りの条件が過大に評価される。束を作り直すぶん時間が倍近くかかるので、
        既定では切ってある。docs/order-field.md 4.6 節を参照。
      */}
      <label className="mt-1 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={selfConsistent}
          onChange={(e) => setSelfConsistent(e.target.checked)}
          disabled={running || busy || !useField}
        />
        相手にも同じ構成を配る（自己整合）
        <span className="text-xs text-ink3">初期解が決まった時点で相手の 3 割に配り、測り直す</span>
      </label>
      {!useField && (
        <p className="mt-2 rounded-sm border border-warn-rule bg-warn-tint px-3 py-2 text-xs text-warn-ink">
          順位条件を判定していない。脚質と噛み合わない条件のスキルが過大に評価される。
          固有の継承版は 8 割 5 分が順位条件を持つので、判定しないと継承版だけがまとめて得をする。
        </p>
      )}

      {/* 進捗は走っている間だけ出す。終わったあとは結果を読む邪魔になる。 */}
      {running && log.length > 0 && (
        <ol className="mt-3 space-y-0.5 text-xs text-ink3">
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
                  className="rounded-full border border-rule2 px-2 py-0.5 text-xs"
                >
                  <SkillNameWithMark name={name(id)} fidelity={fidelities.get(id)} />{' '}
                  <span className="text-ink3">{costModel.cost(id)} pt</span>
                  {routeOf(id) !== null && (
                    <span className="text-ink3">・{ROUTE_LABEL[routeOf(id)!]}</span>
                  )}
                </span>
              ))}
            </div>
            <p className="mt-1 text-sm">
              何も取らない場合より <strong>{seconds(result.bestDiff.mean)}</strong> 秒速い（誤差{' '}
              {(2 * result.bestDiff.stdError).toFixed(3)} 秒）
            </p>
            {result.bestDiff.spurtFlips > 0 && (
              <p className="text-xs text-ink3">
                最大スパートの成否が入れ替わった試行が {result.bestDiff.spurtFlips} 本ある。
                この差は一部の試行が大きく動かしている。
              </p>
            )}
            {/*
              近似の印。探索はモデルが高く評価している箇所を選び出すので、
              解がどれだけそこに乗っているかを数で出す。docs/solver-design.md 4 節を参照。
            */}
            {bestFidelity !== null && (bestFidelity.approximate > 0 || bestFidelity.dropped > 0) && (
              <p className="mt-1 text-xs text-ink3">
                この構成の {result.best.length} 個のうち、{bestFidelity.approximate} 個は発動条件に
                近似を含み、{bestFidelity.dropped} 個は条件を落としている。
                落としているものが多いほど、短縮量は本来より大きく出ている。
              </p>
            )}
            {/*
              感度分析を走らせてあれば、その解の短縮量が近似の置き方でどれだけ動くかを添える。
              上の印は型から言う話、こちらは実測から言う話である。
            */}
            {shakyInBest.length > 0 && (
              <p className="mt-1 text-xs text-warn-ink" data-testid="optimize-sensitivity">
                {sensitivityAxis === 'near' ? '「近く」の距離' : '近似確率の倍率'}
                を振った結果では、この構成の {shakyInBest.length} 個は短縮量が誤差より
                大きく動く（
                {shakyInBest
                  .slice(0, 3)
                  .map((skill) => name(skill.skillId))
                  .join('、')}
                {shakyInBest.length > 3 && ' ほか'}
                ）。この差は近似の中に消えるので、近い順位の構成どうしはここでは決められない。
              </p>
            )}
          </div>

          <FidelityLegend useField={useField} />

          <div className="overflow-x-auto">
            <h3 className="text-xs font-semibold">最終段まで残った構成</h3>
            <p className="text-xs text-ink3">
              短縮量の大きい順に並べてある。
              採用は誤差の 2 倍を超えて改善したときだけ動かすので、点推定が少し上でも採用とは限らない。
            </p>
            <table className="mt-1 w-full text-xs">
              <thead className="text-ink3">
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
                      className="border-t border-rule"
                    >
                      <td className="py-1 pr-2 whitespace-nowrap">
                        {chosen && (
                          <span className="rounded-sm border border-rule2 px-1">
                            採用
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap text-right tabular-nums">
                        {seconds(entry.diff.mean)}
                        <span className="text-ink3"> ± {(2 * entry.diff.stdError).toFixed(3)}</span>
                      </td>
                      <td className="text-right tabular-nums">{entry.cost}</td>
                      <td className="pl-3">
                        {entry.skillIds.map((id, i) => (
                          <span key={id}>
                            {i > 0 && '、'}
                            <SkillNameWithMark name={name(id)} fidelity={fidelities.get(id)} />
                          </span>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="overflow-x-auto">
            <h3 className="text-xs font-semibold">単体で足したときの効き</h3>
            <p className="text-xs text-ink3">
              単体は何も持っていない構成へ 1 つ足したとき、限界は初期解へ 1 つ足したときの短縮量である。
              既に持っているものと食い合うスキルは限界のほうが小さくなる。並べ替えと足切りは限界で行う。
              効きが 0 のものは、この設定では発動していない。
            </p>
            <table className="mt-1 w-full text-xs">
              <thead className="text-ink3">
                <tr>
                  <th className="py-1 text-left">スキル</th>
                  <th className="text-right">単体（秒）</th>
                  <th className="text-right">限界（秒）</th>
                  <th className="text-right">pt</th>
                  <th className="text-right">ミリ秒/pt</th>
                  {planCandidates !== null && <th className="pl-3 text-left">経路</th>}
                </tr>
              </thead>
              <tbody>
                {result.positionCompetition !== null && (
                  <tr className="border-t border-rule bg-paper/40">
                    <td className="py-1">
                      位置取り調整
                      <span className="ml-1 text-ink3">
                        （平均 {result.positionCompetition.averageCount.toFixed(1)} 回・買えない）
                      </span>
                    </td>
                    <td className="text-right tabular-nums">
                      {result.positionCompetition.diff.mean.toFixed(4)}
                      <span className="text-ink3">
                        {' '}
                        ± {(2 * result.positionCompetition.diff.stdError).toFixed(4)}
                      </span>
                    </td>
                    <td className="text-right tabular-nums">—</td>
                    <td className="text-right tabular-nums">—</td>
                    <td className="text-right tabular-nums">—</td>
                    {planCandidates !== null && <td className="pl-3 text-ink3">—</td>}
                  </tr>
                )}
                {result.singles.map((single) => (
                  <tr
                    key={single.skillId}
                    className="border-t border-rule"
                  >
                    <td className="py-1">
                      <SkillNameWithMark
                        name={name(single.skillId)}
                        fidelity={fidelities.get(single.skillId)}
                      />
                    </td>
                    <td className="text-right tabular-nums">{single.diff.mean.toFixed(4)}</td>
                    <td className="text-right tabular-nums">
                      {marginalOf(single.skillId) === null ? (
                        <span className="text-ink3">採用</span>
                      ) : (
                        marginalOf(single.skillId)!.diff.mean.toFixed(4)
                      )}
                    </td>
                    <td className="text-right tabular-nums">{single.cost}</td>
                    <td className="text-right tabular-nums">
                      {(1000 * single.efficiency).toFixed(3)}
                    </td>
                    {planCandidates !== null && (
                      <td className="pl-3 text-ink3">
                        {routeOf(single.skillId) === null ? '—' : ROUTE_LABEL[routeOf(single.skillId)!]}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {result.positionCompetition !== null && (
            <p className="text-xs text-ink3">
              位置取り調整は取捨を選べないので候補には入れていない。それでもスタミナを払って速度を
              得る取引であり、単体スキルより大きく効くことがある。この行が正なら払えている。大きく
              負なら、スキルを増やすより先にスタミナか回復を足したほうがよい。平均回数が 0 に近い
              ときは持久力温存の側にいて、そもそも調整が起きていない。
            </p>
          )}

        </div>
      )}
    </Panel>
  );
}
