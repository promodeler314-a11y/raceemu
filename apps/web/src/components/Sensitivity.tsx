import { useMemo } from 'react';
import type { SensitivityAxis } from '../../../../packages/solver/src/sensitivity.ts';
import { formatDuration } from '../format.ts';
import {
  estimateSensitivity,
  gameData,
  sensitivityCandidates,
  sensitivityScales,
  useStore,
} from '../store.ts';
import { CancelButton, Panel } from './Inputs.tsx';

/**
 * 近似の感度分析。
 *
 * 他のウマ娘との接触や追い抜きの扱いはゲームと突き合わせて確かめたものではないので、
 * 結果がどれだけその置き方に依っているかは分からない。ここでは置き方を上下に振って
 * 走らせ、平均タイムとスキルごとの短縮量がどれだけ動くかを幅として出す。
 * docs/solver-design.md 4.1 節を参照。
 *
 * **振る軸は 2 つある。** 近似確率の倍率（`approximateRateScale`）と、「近く」と
 * 見なす距離（`nearLaneMeters`）である。順位条件を判定していると、追い抜きや前後の
 * ウマ娘は確率ではなく位置から決まるので（`packages/sim/src/field/conditions.ts`）、
 * そのとき効くのは距離のほうになる。判定していなければ逆で、倍率のほうが効く。
 * **1 つの幅にまとめない。** 確率が倍になる世界と近くが倍になる世界は別の世界で、
 * まとめた幅は「どれだけ不確かか」ではなく「いくつ任意性を並べたか」になってしまう。
 * 軸は切り替えにして、1 度に 1 つだけ測る。
 *
 * **置き場を探索の面にしたのは、実行の重さが理由である。** 相手の強さの幅
 * （結果の面の「相手の強さで幅を見る」）はレース 3 回で済むが、こちらは
 * 「振る値の数 × (1 + 候補の数)」構成を走らせる。**重さが候補の数に比例して伸びる**ので、
 * 候補が「持っているスキル全部」に決まってしまうスキル表の隣には置けない。
 * 押す前に見込みを出し、中断もできるようにしてある。
 *
 * **印（△ / ▲）とは別に出している。** 印は「どれだけ怪しいか」を発動条件の型から言い、
 * こちらは「どれだけ結果が動くか」を実測で言う。同じ列に混ぜると意味が濁る。
 */

const fieldCls = 'w-full rounded-sm border border-rule2 bg-surface px-2 py-1 text-sm';

const name = (id: string) => gameData.skillsById.get(id)?.name ?? id;

/** 軸ごとの言葉。表の見出しと文をここから引く。 */
const AXIS: Readonly<
  Record<SensitivityAxis, { label: string; unit: (value: number) => string; column: string }>
> = {
  rate: { label: '近似確率の倍率', unit: (v) => `×${v.toFixed(2)}`, column: '近似' },
  near: { label: '「近く」の距離', unit: (v) => `${v.toFixed(2)} m`, column: '距離' },
};

/**
 * いまの設定でその軸が効くか。
 *
 * 順位条件を判定していれば、位置から決まる 12 型には倍率が効かず距離が効く。
 * 判定していなければ全部が確率のままなので、逆に距離が効かない。
 */
function axisNote(axis: SensitivityAxis, useField: boolean): { text: string; weak: boolean } {
  if (axis === 'near') {
    return useField
      ? {
          text:
            '順位条件を判定しているので、前後のウマ娘・近くの人数・追い抜きはこの距離で決まる。' +
            '既定の 1 バ身（2.5 m）はスキルデータの注記からの読み取りで、ゲームと突き合わせていない。',
          weak: false,
        }
      : {
          text:
            '順位条件を判定していないので、距離を振っても何も動かない。' +
            'この設定では近似はすべて確率のままなので、倍率の軸で測ること。',
          weak: true,
        };
  }
  return useField
    ? {
        text:
          '順位条件を判定しているあいだ、追い抜きと前後のウマ娘は確率ではなく位置から決まる。' +
          '倍率が効くのは残りの近似だけなので、幅は狭く出る。距離の軸のほうも測ること。',
        weak: true,
      }
    : {
        text:
          '順位条件を判定していないので、他のウマ娘にまつわる条件はすべて確率のままである。' +
          'この設定では倍率の軸がそのまま効く。',
        weak: false,
      };
}

export function SensitivityPanel() {
  // セレクタの中でオブジェクトを組み立てないこと。毎回新しい参照が返り、描画が止まる。
  const skillIds = useStore((s) => s.skillIds);
  const optimizeResult = useStore((s) => s.optimizeResult);
  const axis = useStore((s) => s.sensitivityAxis);
  const setAxis = useStore((s) => s.setSensitivityAxis);
  const trials = useStore((s) => s.sensitivityTrials);
  const limit = useStore((s) => s.sensitivityLimit);
  const setTrials = useStore((s) => s.setSensitivityTrials);
  const setLimit = useStore((s) => s.setSensitivityLimit);
  const run = useStore((s) => s.runSensitivity);
  const running = useStore((s) => s.sensitivityRunning);
  const busy = useStore((s) => s.running);
  const optimizeRunning = useStore((s) => s.optimizeRunning);
  const log = useStore((s) => s.sensitivityLog);
  const result = useStore((s) => s.sensitivityResult);
  const pace = useStore((s) => s.pace);
  const useField = useStore((s) => s.useField);

  const candidates = useMemo(
    () => sensitivityCandidates({ skillIds, optimizeResult, sensitivityLimit: limit }),
    [skillIds, optimizeResult, limit],
  );
  const estimate = useMemo(
    () =>
      estimateSensitivity({
        pace,
        useField,
        sensitivityAxis: axis,
        sensitivityTrials: trials,
        candidateCount: candidates.length,
      }),
    [pace, useField, axis, trials, candidates.length],
  );
  const scaleCount = sensitivityScales(axis).length;
  const note = axisNote(axis, useField);

  const times = result === null ? [] : result.scales.map((entry) => entry.meanTime);
  const timeWidth = times.length === 0 ? 0 : Math.max(...times) - Math.min(...times);
  // 幅 ÷ 誤差が 1 を超えるものは、短縮量が試行の揺れではなく置き方で動いている。
  const shaky = result === null ? [] : result.skills.filter((skill) => skill.widthPerError >= 1);

  return (
    <Panel title="近似の感度">
      <p className="text-xs text-ink3">
        他のウマ娘との接触や追い抜きの扱いは、ゲームと突き合わせて確かめたものではない。
        置き方を半分と倍に振って走らせ、短縮量がどれだけ動くかを見る。
        幅が誤差より広いスキルは、順位を置き方のほうが決めている。
        {scaleCount} 通り × (1 + 候補) 構成を走らせるので、候補は上限で切る。
      </p>

      {/*
        軸は 2 つある。まとめて 1 つの幅にはしない。確率が倍になる世界と
        近くが倍になる世界は別の世界で、まとめた幅は「どれだけ不確かか」ではなく
        「いくつ任意性を並べたか」になる。docs/solver-design.md 4.1 節を参照。
      */}
      <div className="mt-3">
        <span className="block text-xs text-ink3">振る軸</span>
        <div className="mt-1 flex flex-wrap gap-3" role="radiogroup" aria-label="振る軸">
          {(['rate', 'near'] as const).map((value) => (
            <label key={value} className="flex items-center gap-1.5 text-sm">
              <input
                type="radio"
                name="sensitivity-axis"
                data-testid={`sensitivity-axis-${value}`}
                checked={axis === value}
                onChange={() => setAxis(value)}
                disabled={running || busy || optimizeRunning}
              />
              {AXIS[value].label}
            </label>
          ))}
        </div>
        <p
          className={`mt-1 text-xs ${note.weak ? 'text-warn-ink' : 'text-ink3'}`}
          data-testid="sensitivity-axis-note"
        >
          {note.text}
        </p>
      </div>

      <p className="mt-2 text-xs text-ink3">
        測るのは{' '}
        {optimizeResult === null
          ? 'いま選んでいるスキルの先頭から'
          : '直前の探索の最良の構成と、効きの大きい候補から'}{' '}
        {candidates.length} 個である。
        {optimizeResult === null && ' 先に探索を走らせると、効いているものから選ばれる。'}
      </p>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="block text-xs text-ink3">1 構成あたりの試行数</span>
          <input
            type="number"
            data-testid="sensitivity-trials"
            className={fieldCls}
            value={trials}
            min={50}
            max={5000}
            step={50}
            onChange={(e) => setTrials(Number(e.target.value))}
          />
        </label>
        <label className="block">
          <span className="block text-xs text-ink3">幅を測るスキルの上限</span>
          <input
            type="number"
            data-testid="sensitivity-limit"
            className={fieldCls}
            value={limit}
            min={1}
            max={30}
            step={1}
            onChange={(e) => setLimit(Number(e.target.value))}
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="rounded-sm bg-primary-bg px-4 py-1.5 text-sm text-primary-fg disabled:opacity-50"
          onClick={() => void run()}
          disabled={running || busy || optimizeRunning || candidates.length === 0}
        >
          {running ? '測っている' : '近似の幅を測る'}
        </button>
        {running ? (
          <CancelButton />
        ) : (
          <span
            className="text-xs text-ink3"
            data-testid="sensitivity-estimate"
            title={
              estimate.measured
                ? '直前の実測から出している'
                : '作り付けの目安。1 回走らせると実測に置き換わる'
            }
          >
            {`${estimate.measured ? '見込み' : '目安'} 約 ${formatDuration(estimate.ms)}`}
            {`・レース ${estimate.totalTrials.toLocaleString()} 本`}
          </span>
        )}
        {result !== null && !running && (
          <span className="num text-xs text-ink3">
            レース {result.races.toLocaleString()} 本 ・ {(result.elapsedMs / 1000).toFixed(1)} 秒
          </span>
        )}
      </div>

      {/* 進捗は走っている間だけ出す。終わったあとは結果を読む邪魔になる。 */}
      {running && log.length > 0 && (
        <ol className="mt-3 space-y-0.5 text-xs text-ink3">
          {log.slice(-6).map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ol>
      )}

      {result !== null && (
        <div className="mt-4 space-y-4" data-testid="sensitivity-result">
          <div className="overflow-x-auto">
            <h3 className="text-xs font-semibold">平均タイム（候補を 1 つも取らない構成）</h3>
            <table className="mt-1 w-full text-xs">
              <thead className="text-ink3">
                <tr>
                  <th className="py-1 text-left font-normal">{AXIS[axis].label}</th>
                  <th className="text-right font-normal">平均タイム</th>
                  <th className="text-right font-normal">既定との差</th>
                  <th className="text-right font-normal">最大スパート率</th>
                </tr>
              </thead>
              <tbody>
                {result.scales.map((entry) => (
                  <tr key={entry.scale} className="border-t border-rule">
                    <td className="py-1 tabular-nums">{AXIS[axis].unit(entry.scale)}</td>
                    <td className="text-right tabular-nums">{entry.meanTime.toFixed(4)}</td>
                    <td className="text-right tabular-nums">
                      {entry.shift.mean >= 0 ? '+' : '−'}
                      {Math.abs(entry.shift.mean).toFixed(4)}
                      <span className="text-ink3">
                        {' '}
                        ± {(2 * entry.shift.stdError).toFixed(4)}
                      </span>
                    </td>
                    <td className="text-right tabular-nums">
                      {(100 * entry.maxSpurtRate).toFixed(1)} %
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-xs text-ink3">
              平均タイムの幅は <strong>{timeWidth.toFixed(4)}</strong> 秒である。
              これが「{AXIS[axis].label}の置き方だけで動く量」で、試行数を増やしても縮まない。
            </p>
          </div>

          <div className="overflow-x-auto">
            <h3 className="text-xs font-semibold">スキルごとの短縮量（幅の広い順）</h3>
            <p className="text-xs text-ink3">
              幅 ÷ 誤差が 1 を超えるスキルは、短縮量が測り方の揺れではなく置き方で動いている。
              その差は近似の中に消えるものとして読む。
              振っても動かないものは、その軸に依っていないか、確率が既に 1.0 で頭打ちになっている。
              「{AXIS[axis].column}」の列が − なのに幅が出たときは、そのスキルの条件ではなく、
              走りが変わったことの間接の影響を拾っている。
            </p>
            <table className="mt-1 w-full text-xs" data-testid="sensitivity-table">
              <thead className="text-ink3">
                <tr>
                  <th className="py-1 text-left font-normal">スキル</th>
                  <th
                    className="text-center font-normal"
                    title={
                      axis === 'near'
                        ? '発動条件に、位置から計算する条件を含むか'
                        : '発動条件に、確率で近似している条件を含むか'
                    }
                  >
                    {AXIS[axis].column}
                  </th>
                  {result.scales.map((entry) => (
                    <th key={entry.scale} className="text-right font-normal">
                      {AXIS[axis].unit(entry.scale)}
                    </th>
                  ))}
                  <th className="text-right font-normal">幅</th>
                  <th className="text-right font-normal">幅 ÷ 誤差</th>
                </tr>
              </thead>
              <tbody>
                {[...result.skills]
                  .sort((a, b) => b.width - a.width)
                  .map((skill) => (
                    <tr key={skill.skillId} className="border-t border-rule">
                      <td className="py-1 whitespace-nowrap">{name(skill.skillId)}</td>
                      <td className="text-center text-ink3">{skill.approximate ? '○' : '−'}</td>
                      {skill.byScale.map((entry) => (
                        <td key={entry.scale} className="text-right tabular-nums">
                          {entry.diff.mean.toFixed(4)}
                        </td>
                      ))}
                      <td className="text-right tabular-nums">{skill.width.toFixed(4)}</td>
                      <td
                        className={`text-right tabular-nums ${
                          skill.widthPerError >= 1 ? 'text-warn-ink' : ''
                        }`}
                      >
                        {skill.widthPerError.toFixed(2)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-ink3" data-testid="sensitivity-verdict">
            {shaky.length === 0
              ? `測った ${result.skills.length} 個は、${AXIS[axis].label}を振っても短縮量が誤差の中に収まっている。この軸については、順位の付け方が置き方に依っていない。`
              : `測った ${result.skills.length} 個のうち ${shaky.length} 個は、${AXIS[axis].label}の置き方で短縮量が誤差より大きく動く（${shaky
                  .slice(0, 3)
                  .map((skill) => name(skill.skillId))
                  .join('、')}${shaky.length > 3 ? ' ほか' : ''}）。この差は近似の中に消えるので、これらどうしの順位はこの分析の中では決められない。`}
            {' もう一方の軸は別に測ること。片方で動かなくても、もう一方で動くことがある。'}
          </p>
        </div>
      )}
    </Panel>
  );
}
