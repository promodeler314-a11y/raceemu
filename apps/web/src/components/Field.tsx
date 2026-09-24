import { useEffect, useMemo, useState } from 'react';
import type { Style } from '../../../../packages/sim/src/data/constants.ts';
import { listIndividuals, type Individual } from '../individualsApi.ts';
import { defaultOpponents, estimateMulti, gameData, skillChoices, useStore } from '../store.ts';
import { formatDuration } from '../format.ts';
import { rarityLabel } from '../skills.ts';
import { CancelButton, Panel } from './Inputs.tsx';
import { MultiRaceDetail, MultiTrialPicker } from './MultiRace.tsx';

const fieldCls = 'w-full rounded-sm border border-rule2 bg-surface px-2 py-1 text-sm';
const STYLES: Style[] = ['NIGE', 'SEN', 'SASI', 'OI'];
const STYLE_LABEL: Record<string, string> = { NIGE: '逃げ', SEN: '先行', SASI: '差し', OI: '追込' };

/** 保存した日時。表示は日本時間で、年は省く。読めなければ空にする。 */
function savedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
const pct = (x: number) => `${(100 * x).toFixed(1)} %`;

interface OpponentRowProps {
  readonly id: number;
  readonly index: number;
  /** null は未取得。取得済みなら（空でも）配列になる。 */
  readonly savedIndividuals: readonly Individual[] | null;
  readonly savedMessage: string | null;
  readonly onRequestSaved: () => void;
}

/** 相手 1 頭ぶんの行。ステータスは横に並べ、スキルと個体選びは開いたときだけ出す。 */
function OpponentRow({ id, index, savedIndividuals, savedMessage, onRequestSaved }: OpponentRowProps) {
  const opponent = useStore((s) => s.opponents.find((o) => o.id === id));
  const setOpponent = useStore((s) => s.setOpponent);
  const toggleSkill = useStore((s) => s.toggleOpponentSkill);
  const setFromIndividual = useStore((s) => s.setOpponentFromIndividual);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  const matched = useMemo(() => {
    if (query.trim() === '') return [];
    return skillChoices.filter((c) => c.name.includes(query.trim())).slice(0, 20);
  }, [query]);

  if (opponent === undefined) return null;
  const uma = opponent.uma;
  const stat = (key: 'speed' | 'stamina' | 'power' | 'guts' | 'wisdom') => (
    <input
      type="number"
      className="w-16 rounded-sm border border-rule2 bg-surface px-1 py-0.5 text-right text-xs tabular-nums"
      value={uma[key]}
      min={1}
      max={2500}
      onChange={(e) => setOpponent(id, { [key]: Number(e.target.value) })}
    />
  );

  return (
    <>
      <tr className="border-t border-rule2">
        <td className="py-1 pr-3 text-ink3 tabular-nums">{index + 2}</td>
        <td className="pr-2">
          <select
            className="rounded-sm border border-rule2 bg-surface px-1 py-0.5 text-xs"
            value={uma.style}
            onChange={(e) => setOpponent(id, { style: e.target.value as Style })}
          >
            {STYLES.map((style) => (
              <option key={style} value={style}>
                {STYLE_LABEL[style]}
              </option>
            ))}
          </select>
        </td>
        <td className="pr-1 text-right">{stat('speed')}</td>
        <td className="pr-1 text-right">{stat('stamina')}</td>
        <td className="pr-1 text-right">{stat('power')}</td>
        <td className="pr-1 text-right">{stat('guts')}</td>
        <td className="pr-1 text-right">{stat('wisdom')}</td>
        <td className="flex flex-wrap gap-1 pl-2">
          <button
            type="button"
            className="whitespace-nowrap rounded-sm border border-rule2 px-1.5 py-0.5 text-xs"
            onClick={() => setOpen(!open)}
          >
            スキル {opponent.skillIds.length}
          </button>
          <button
            type="button"
            className="whitespace-nowrap rounded-sm border border-rule2 px-1.5 py-0.5 text-xs"
            onClick={() => {
              setPickerOpen(!pickerOpen);
              if (!pickerOpen) onRequestSaved();
            }}
          >
            個体から選択
          </button>
        </td>
      </tr>
      {pickerOpen && (
        <tr className="border-t border-rule2 bg-paper">
          <td colSpan={8} className="p-2">
            {savedIndividuals === null && <p className="text-xs text-ink3">読み込み中…</p>}
            {savedMessage !== null && <p className="text-xs text-ink3">{savedMessage}</p>}
            {savedIndividuals !== null && savedIndividuals.length > 0 && (
              <ul className="max-h-40 overflow-y-auto rounded-sm border border-rule2 text-xs">
                {savedIndividuals.map((individual) => (
                  <li key={individual.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-2 px-2 py-1 text-left hover:bg-sunken"
                      onClick={() => {
                        setFromIndividual(id, individual);
                        setPickerOpen(false);
                      }}
                    >
                      <span className="truncate">{individual.label || '(名称未設定)'}</span>
                      {/* 同じ構成を何度か保存すると名前だけでは見分けが付かない。保存した日時を添える */}
                      <span className="whitespace-nowrap text-ink3">
                        {STYLE_LABEL[individual.uma.style] ?? individual.uma.style} ・ スキル{' '}
                        {individual.skillIds.length} ・ {savedAt(individual.createdAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      )}
      {open && (
        <tr className="border-t border-rule2 bg-paper">
          <td colSpan={8} className="p-2">
            <input
              className={fieldCls}
              placeholder="スキル名で検索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {matched.length > 0 && (
              <ul className="mt-1 max-h-32 overflow-y-auto rounded-sm border border-rule2 text-xs">
                {matched.map((skill) => (
                  <li key={skill.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between px-2 py-1 text-left hover:bg-sunken"
                      onClick={() => toggleSkill(id, skill.id)}
                    >
                      <span>{skill.name}</span>
                      <span className="text-ink3">
                        {opponent.skillIds.includes(skill.id) ? '選択中' : rarityLabel(skill.rarity)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {opponent.skillIds.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {opponent.skillIds.map((skillId) => (
                  <button
                    key={skillId}
                    type="button"
                    className="rounded-sm border border-rule2 px-2 py-0.5 text-xs"
                    onClick={() => toggleSkill(id, skillId)}
                    title="クリックで外します。"
                  >
                    {gameData.skillsById.get(skillId)?.name ?? skillId} ×
                  </button>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function FieldPanel() {
  const opponents = useStore((s) => s.opponents);
  const gateCount = useStore((s) => s.track.gateCount);
  const reset = useStore((s) => s.resetOpponents);
  const trials = useStore((s) => s.multiTrials);
  const setTrials = useStore((s) => s.setMultiTrials);
  const run = useStore((s) => s.runMulti);
  const running = useStore((s) => s.multiRunning);
  const progress = useStore((s) => s.multiProgress);
  const busy = useStore((s) => s.running || s.optimizeRunning);
  const result = useStore((s) => s.multiResult);
  // 全頭同時は 1 試行が単騎の 10 倍ほどかかる。押す前に待ち時間を出す。
  // 組み立てはセレクタの外で行う（Inputs.tsx の RunPanel と同じ理由）。
  const pace = useStore((s) => s.pace);
  const track = useStore((s) => s.track);
  const estimate = useMemo(
    () => estimateMulti({ pace, track, multiTrials: trials }),
    [pace, track, trials],
  );

  // 保存済み個体は行ごとではなく面全体で 1 回だけ取りに行く。9 行が
  // それぞれ叩くと、開くたびに毎回同じ一覧を 9 回取りに行くことになる。
  const [savedIndividuals, setSavedIndividuals] = useState<readonly Individual[] | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  // 開くたびに取り直す。1 度取った一覧を使い回すと、面を開いたまま
  // ヘッダから保存した個体が出てこない（docs/ui-audit-race-emulator.md 第3節 C-4）。
  // 取り直しているあいだは前の一覧を出したままにする。
  const loadSavedIndividuals = () => {
    setSavedMessage(null);
    listIndividuals()
      .then((items) => {
        setSavedIndividuals(items);
        setSavedMessage(items.length === 0 ? '保存された個体がまだありません。' : null);
      })
      .catch((error: unknown) => {
        setSavedMessage(error instanceof Error ? error.message : String(error));
      });
  };

  // 出走頭数を変えたら相手の数を合わせ直す
  useEffect(() => {
    if (opponents.length !== gateCount - 1) reset();
  }, [gateCount, opponents.length, reset]);

  return (
    <>
      <Panel title="相手">
        <p className="text-xs text-ink3">
          出走する {gateCount} 頭を同時に走らせ、着順の分布と勝率を出します。
          相手は自分の走りに反応し、位置取りも相手を見て決まります。
        </p>
        <p className="mt-1 text-xs text-ink3">
          この面は上の実行バーとは別に動きます。
          試行回数はここで指定し、シードは実行バーの値を使います。「順位条件を判定する」の指定は使いません（順位は実際の位置から決まります）。
          枠番は空いているところから配ります。
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-ink3">
              <tr>
                <th className="whitespace-nowrap pb-1 pr-3 text-left">出走</th>
                <th className="pb-1 pr-3 text-left">脚質</th>
                <th className="pb-1 pr-1 text-right">スピード</th>
                <th className="pb-1 pr-1 text-right">スタミナ</th>
                <th className="pb-1 pr-1 text-right">パワー</th>
                <th className="pb-1 pr-1 text-right">根性</th>
                <th className="pb-1 pr-1 text-right">賢さ</th>
                <th className="w-full" />
              </tr>
            </thead>
            <tbody>
              {opponents.map((opponent, index) => (
                <OpponentRow
                  key={opponent.id}
                  id={opponent.id}
                  index={index}
                  savedIndividuals={savedIndividuals}
                  savedMessage={savedMessage}
                  onRequestSaved={loadSavedIndividuals}
                />
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="block text-xs text-ink3">試行回数</span>
            <input
              type="number"
              className="w-28 rounded-sm border border-rule2 bg-surface px-2 py-1 text-sm"
              value={trials}
              min={1}
              max={50000}
              step={100}
              onChange={(e) => setTrials(Number(e.target.value))}
            />
          </label>
          <button
            type="button"
            className="rounded-sm bg-primary-bg px-4 py-1.5 text-sm text-primary-fg disabled:opacity-50"
            onClick={() => void run()}
            disabled={running || busy}
          >
            {running ? '計算中' : '勝率の計算'}
          </button>
          {running ? (
            <>
              <CancelButton />
              <span className="text-sm text-ink3">
                {progress} / {trials}
              </span>
            </>
          ) : (
            <span
              className="pb-1.5 text-xs text-ink3"
              data-testid="multi-estimate"
              title={
                estimate.measured
                  ? '直前の実測から出しています。'
                  : '作り付けの目安です。1 回走らせると実測に置き換わります。'
              }
            >
              {estimate.measured ? '見込み' : '目安'} 約 {formatDuration(estimate.ms)}
            </span>
          )}
          <button type="button" className="text-xs text-ink3 underline" onClick={reset}>
            相手の初期化
          </button>
        </div>
      </Panel>

      {result !== null && (
        <Panel title="着順">
          {result.cancelled && (
            <p className="mb-2 text-xs text-ink3">
              中断したので、終わった {result.trials} 試行だけを集計しています。
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-ink3">
                <tr>
                  <th className="pb-1 text-left">出走</th>
                  <th className="pb-1 text-right">勝率</th>
                  <th className="pb-1 text-right">連対率</th>
                  <th className="pb-1 text-right">複勝率</th>
                  <th className="pb-1 text-right">平均着順</th>
                  <th className="pb-1 text-right">平均タイム</th>
                  <th className="pb-1 pl-3 text-left">着順の分布</th>
                </tr>
              </thead>
              <tbody>
                {result.summaries.map((s) => {
                  const self = s.index === 0;
                  return (
                    <tr
                      key={s.index}
                      className={`border-t border-rule2 ${self ? 'font-bold' : ''}`}
                    >
                      <td className="py-1">{self ? '自分' : `${s.index + 1} 番`}</td>
                      <td className="text-right tabular-nums">{pct(s.winRate)}</td>
                      <td className="text-right tabular-nums">{pct(s.quinellaRate)}</td>
                      <td className="text-right tabular-nums">{pct(s.showRate)}</td>
                      <td className="text-right tabular-nums">{s.meanOrder.toFixed(2)}</td>
                      <td className="text-right tabular-nums">{s.meanTime.toFixed(3)}</td>
                      <td className="pl-3">
                        <OrderBar counts={s.counts} trials={s.trials} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-ink3">
            {result.trials} 試行 / {(result.elapsedMs / 1000).toFixed(1)} 秒
          </p>
          {/* 勝率の次に来る問いは「なぜこの試行で負けたのか」である。#57 */}
          <MultiTrialPicker />
        </Panel>
      )}

      <MultiRaceDetail />
    </>
  );
}

/**
 * 着順の分布を 1 行の帯で示す。
 * 左が 1 着で、右にいくほど後ろになる。濃さで着順を表す。
 */
function OrderBar({ counts, trials }: { counts: readonly number[]; trials: number }) {
  if (trials === 0) return null;
  const last = counts.length - 1;
  return (
    <div className="flex h-3 w-40 overflow-hidden rounded-sm" role="img" aria-label="着順の分布">
      {counts.slice(1).map((count, i) => {
        const order = i + 1;
        const share = count / trials;
        if (share <= 0) return null;
        // 1 着を最も濃く、最下位を最も薄くする
        const alpha = 0.15 + 0.85 * (1 - (order - 1) / Math.max(1, last - 1));
        return (
          <div
            key={order}
            style={{ width: `${100 * share}%`, backgroundColor: `color-mix(in srgb, var(--color-s1) ${100 * alpha}%, transparent)` }}
            title={`${order} 着 ${(100 * share).toFixed(1)} %`}
          />
        );
      })}
    </div>
  );
}
