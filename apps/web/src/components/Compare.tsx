import { useState } from 'react';
import { gameData, useStore } from '../store.ts';
import { Panel } from './Inputs.tsx';

function seconds(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : '-';
}

function percent(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)} %` : '-';
}

/** 保存した設定を列として並べ、1 列目と違う値だけ強調する。 */
export function CompareOutput() {
  const snapshots = useStore((s) => s.snapshots);
  const summary = useStore((s) => s.summary);
  const saveSnapshot = useStore((s) => s.saveSnapshot);
  const removeSnapshot = useStore((s) => s.removeSnapshot);
  const restoreSnapshot = useStore((s) => s.restoreSnapshot);

  if (snapshots.length === 0) {
    return (
      <Panel title="比較">
        <p className="text-sm text-neutral-500">
          実行したあとに保存すると、設定同士を並べて比べられる。
        </p>
        <button
          type="button"
          className="mt-3 rounded border border-neutral-300 px-3 py-1 text-sm disabled:opacity-50 dark:border-neutral-700"
          onClick={saveSnapshot}
          disabled={summary === null}
        >
          いまの結果を保存
        </button>
      </Panel>
    );
  }

  const columns = [...snapshots].reverse();
  const base = columns[0]!;

  const rows: { label: string; value: (s: (typeof columns)[number]) => string; numeric?: boolean }[] = [
    { label: '平均タイム', value: (s) => seconds(s.summary.all.averageTime), numeric: true },
    { label: '中央値', value: (s) => seconds(s.summary.all.medianTime), numeric: true },
    { label: '最大スパート率', value: (s) => percent(s.summary.spurtRate) },
    { label: '完走率', value: (s) => percent(s.summary.finishRate) },
    { label: '平均残り体力', value: (s) => s.summary.all.averageGoalSp.toFixed(1) },
    { label: 'スピード', value: (s) => String(s.uma.speed) },
    { label: 'スタミナ', value: (s) => String(s.uma.stamina) },
    { label: 'パワー', value: (s) => String(s.uma.power) },
    { label: '根性', value: (s) => String(s.uma.guts) },
    { label: '賢さ', value: (s) => String(s.uma.wisdom) },
    { label: 'スキル数', value: (s) => String(s.skillIds.length) },
    { label: '試行回数', value: (s) => String(s.summary.all.count) },
  ];

  return (
    <Panel title="比較">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] text-sm">
          <thead>
            <tr>
              <th scope="col" className="py-1 text-left font-normal text-neutral-500 dark:text-neutral-400">
                項目
              </th>
              {columns.map((snapshot) => (
                <th key={snapshot.id} scope="col" className="py-1 text-right font-medium">
                  <button
                    type="button"
                    className="underline decoration-dotted"
                    onClick={() => restoreSnapshot(snapshot.id)}
                    aria-label={`スナップショット ${snapshot.id} の設定を入力欄に戻す`}
                    title="この設定を入力欄に戻す"
                  >
                    #{snapshot.id}
                  </button>
                  <button
                    type="button"
                    className="ml-1 text-neutral-400"
                    onClick={() => removeSnapshot(snapshot.id)}
                    aria-label={`スナップショット ${snapshot.id} を削除する`}
                    title="削除"
                  >
                    ×
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const baseValue = row.value(base);
              return (
                <tr key={row.label} className="border-b border-neutral-100 last:border-0 dark:border-neutral-800">
                  <th scope="row" className="py-1 text-left font-normal text-neutral-500 dark:text-neutral-400">
                    {row.label}
                  </th>
                  {columns.map((snapshot) => {
                    const value = row.value(snapshot);
                    const differs = value !== baseValue;
                    const delta =
                      row.numeric === true && differs
                        ? Number(value) - Number(baseValue)
                        : Number.NaN;
                    return (
                      <td
                        key={snapshot.id}
                        className={`py-1 text-right tabular-nums ${differs ? 'font-semibold' : 'text-neutral-500 dark:text-neutral-400'}`}
                      >
                        {value}
                        {Number.isFinite(delta) && (
                          <span className="ml-1 text-xs font-normal text-neutral-500">
                            ({delta > 0 ? '+' : ''}
                            {delta.toFixed(3)})
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
        太字は左端の列と違う値。括弧内は左端との差。
      </p>
      <button
        type="button"
        className="mt-3 rounded border border-neutral-300 px-3 py-1 text-sm disabled:opacity-50 dark:border-neutral-700"
        onClick={saveSnapshot}
        disabled={summary === null}
      >
        いまの結果を保存
      </button>
    </Panel>
  );
}

/** スキルごとの発動率と発動位置。 */
export function SkillSummaryOutput() {
  const skillSummaries = useStore((s) => s.skillSummaries);
  if (skillSummaries.length === 0) return null;

  const phaseLabels = ['序盤', '中盤', '終盤', 'ラスト'];
  return (
    <Panel title="スキルごとの発動">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[30rem] text-sm">
          <thead>
            <tr className="border-b border-neutral-200 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
              <th scope="col" className="py-1 text-left font-normal">スキル</th>
              <th scope="col" className="py-1 text-right font-normal">発動率</th>
              <th scope="col" className="py-1 text-right font-normal">平均発動位置</th>
              <th scope="col" className="py-1 text-right font-normal">2 回発動率</th>
              <th scope="col" className="py-1 text-right font-normal">初回のフェーズ</th>
            </tr>
          </thead>
          <tbody>
            {skillSummaries.map((skill) => {
              const data = gameData.skillsById.get(skill.skillId);
              const topPhase = skill.phaseRates.indexOf(Math.max(...skill.phaseRates));
              return (
                <tr key={skill.skillId} className="border-b border-neutral-100 last:border-0 dark:border-neutral-800">
                  <th scope="row" className="py-1 text-left font-normal">
                    {data?.name ?? skill.skillId}
                  </th>
                  <td className="py-1 text-right tabular-nums">
                    {(skill.triggerRate * 100).toFixed(1)} %
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {Number.isFinite(skill.averageFirstPosition)
                      ? `${skill.averageFirstPosition.toFixed(0)} m`
                      : '-'}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {(skill.doubleTriggerRate * 100).toFixed(1)} %
                  </td>
                  <td className="py-1 text-right text-xs">
                    {skill.triggerRate === 0
                      ? '-'
                      : `${phaseLabels[topPhase]} ${(skill.phaseRates[topPhase]! * 100).toFixed(0)} %`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

export function ShareButton() {
  const shareUrl = useStore((s) => s.shareUrl);
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rounded border border-neutral-300 px-3 py-1.5 text-sm dark:border-neutral-700"
      onClick={() => {
        const url = shareUrl();
        history.replaceState(null, '', url);
        void navigator.clipboard?.writeText(url).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          },
          () => setCopied(false),
        );
      }}
    >
      {copied ? 'コピーした' : '設定を URL に'}
    </button>
  );
}
