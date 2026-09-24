import { Fragment, useState } from 'react';
import { currentTrackDetail, gameData, startSp, useStore, type Snapshot } from '../store.ts';
import { formatTime } from '../format.ts';
import { CONDITION_LABEL as MOOD_LABEL, Panel } from './Inputs.tsx';

function percent(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)} %` : '-';
}

/**
 * 保存した設定を列として並べる。
 *
 * [モック](../../../../design/Compare.dc.html)に合わせて、行を群に分け、
 * 基準の列を選べるようにし、同じ値の行を畳めるようにした。
 * 12 行を平坦に並べていたときは、どこが違うのかを目で探す必要があった。
 */

type Row = {
  readonly label: string;
  readonly value: (s: Snapshot) => string;
  /** 基準との差を数値で出すか */
  readonly numeric?: boolean;
  /**
   * 差を取るための値。表示が数字そのものでない行（タイムの「1:57.644」）で使う。
   * 省くと表示の文字列を数として読む。
   */
  readonly amount?: (s: Snapshot) => number;
  /** 差の小数桁。タイムは 3 桁、ステータスのような整数は 0 桁。 */
  readonly digits?: number;
};

const GROUPS: readonly { readonly name: string; readonly rows: readonly Row[] }[] = [
  {
    name: '結果',
    rows: [
      { label: '平均タイム', value: (s) => formatTime(s.summary.all.averageTime), amount: (s) => s.summary.all.averageTime, numeric: true, digits: 3 },
      { label: '中央値', value: (s) => formatTime(s.summary.all.medianTime), amount: (s) => s.summary.all.medianTime, numeric: true, digits: 3 },
      { label: '最速タイム', value: (s) => formatTime(s.summary.all.bestTime), amount: (s) => s.summary.all.bestTime, numeric: true, digits: 3 },
      { label: '最遅タイム', value: (s) => formatTime(s.summary.all.worstTime), amount: (s) => s.summary.all.worstTime, numeric: true, digits: 3 },
      { label: '最大スパート率', value: (s) => percent(s.summary.spurtRate) },
      { label: '完走率', value: (s) => percent(s.summary.finishRate) },
      { label: '平均残り体力', value: (s) => s.summary.all.averageGoalSp.toFixed(1) },
      // 残り体力を読む基準（#105）。スタミナやコースを変えた列どうしでは、ここも動く
      { label: 'スタート時の体力', value: (s) => startSp(s).toFixed(0), numeric: true },
    ],
  },
  {
    name: 'ステータス',
    rows: [
      { label: 'スピード', value: (s) => String(s.uma.speed), numeric: true },
      { label: 'スタミナ', value: (s) => String(s.uma.stamina), numeric: true },
      { label: 'パワー', value: (s) => String(s.uma.power), numeric: true },
      { label: '根性', value: (s) => String(s.uma.guts), numeric: true },
      { label: '賢さ', value: (s) => String(s.uma.wisdom), numeric: true },
      { label: '脚質', value: (s) => STYLE_LABEL[s.uma.style] ?? s.uma.style },
      { label: 'やる気', value: (s) => MOOD_LABEL[s.uma.condition] ?? '' },
    ],
  },
  {
    name: 'コース',
    rows: [
      {
        label: 'コース',
        value: (s) => {
          const detail = currentTrackDetail(s.track);
          const place = gameData.trackData[s.track.location]?.name ?? '';
          return detail === undefined ? place : `${place} ${detail.distance}m`;
        },
      },
      { label: '出走頭数', value: (s) => String(s.track.gateCount), numeric: true },
      { label: 'バ場状態', value: (s) => CONDITION_LABEL[s.track.condition] ?? String(s.track.condition) },
    ],
  },
  {
    name: 'スキル',
    rows: [
      { label: 'スキル数', value: (s) => String(s.skillIds.length), numeric: true },
      { label: '試行回数', value: (s) => String(s.summary.all.count), numeric: true },
    ],
  },
];

const STYLE_LABEL: Record<string, string> = { NIGE: '逃げ', SEN: '先行', SASI: '差し', OI: '追込' };
const CONDITION_LABEL: Record<number, string> = { 1: '良', 2: '稍重', 3: '重', 4: '不良' };

/** 系列の色。3 列までに抑えているのは、明色面で区別が付く枠がここまでだからである。 */
const SERIES_COLORS = ['var(--color-s1)', 'var(--color-s2)', 'var(--color-s3)'];

/**
 * 分布の重ね合わせ。
 *
 * スナップショットは畳んだヒストグラムを持っている。ビンの範囲は
 * 件ごとに違うので、共通の範囲に取り直してから重ねる。
 */
function DistributionOverlay({ columns }: { columns: readonly Snapshot[] }) {
  const withHistogram = columns.filter((s) => s.histogram !== undefined).slice(0, 3);
  if (withHistogram.length < 2) return null;

  const min = Math.min(...withHistogram.map((s) => s.histogram!.min));
  const max = Math.max(...withHistogram.map((s) => s.histogram!.max));
  if (!(max > min)) return null;

  const bins = 60;
  const series = withHistogram.map((snapshot) => {
    const histogram = snapshot.histogram!;
    const out = new Array<number>(bins).fill(0);
    const sourceWidth = (histogram.max - histogram.min) / histogram.counts.length;
    let total = 0;
    histogram.counts.forEach((count, i) => {
      const center = histogram.min + (i + 0.5) * sourceWidth;
      const target = Math.min(bins - 1, Math.max(0, Math.floor(((center - min) / (max - min)) * bins)));
      out[target]! += count;
      total += count;
    });
    // 試行回数が違う列を並べるので、件数ではなく割合にする。
    return { id: snapshot.id, values: out.map((v) => (total === 0 ? 0 : v / total)) };
  });
  const peak = Math.max(...series.flatMap((s) => s.values), 1e-9);

  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h3 className="text-sm font-bold">タイムの分布</h3>
        {series.map((s, i) => (
          <span key={s.id} className="flex items-center gap-1 text-[11px] text-ink2">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: SERIES_COLORS[i] }}
            />
            #{s.id}
          </span>
        ))}
      </div>
      <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="mt-2 h-24 w-full">
        {series.map((s, i) => (
          <polyline
            key={s.id}
            points={s.values
              .map((v, j) => `${(j / (bins - 1)) * 100},${30 - (v / peak) * 28}`)
              .join(' ')}
            fill="none"
            stroke={SERIES_COLORS[i]}
            strokeWidth={1.2}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="flex justify-between text-[11px] text-ink3">
        <span className="num">{formatTime(min)}</span>
        <span className="num">{formatTime(max)}</span>
      </div>
    </div>
  );
}

export function CompareOutput() {
  const snapshots = useStore((s) => s.snapshots);
  const summary = useStore((s) => s.summary);
  const saveSnapshot = useStore((s) => s.saveSnapshot);
  const removeSnapshot = useStore((s) => s.removeSnapshot);
  const restoreSnapshot = useStore((s) => s.restoreSnapshot);
  const [baseId, setBaseId] = useState<number | null>(null);
  const [onlyDiff, setOnlyDiff] = useState(false);

  if (snapshots.length === 0) {
    return (
      <Panel title="比較">
        <p className="text-sm text-ink3">
          実行したあとにヘッダの「スナップショットを保存」を押すと、設定同士を並べて比べられます。
        </p>
      </Panel>
    );
  }

  const columns = [...snapshots].reverse();
  const base = columns.find((s) => s.id === baseId) ?? columns[0]!;

  // スキルの差。どのスキルが増えて減ったかは、数だけでは分からない。
  const baseSkills = new Set(base.skillIds);
  const skillName = (id: string) => gameData.skillsById.get(id)?.name ?? id;
  const commonCount = columns.reduce(
    (count, snapshot) =>
      Math.min(count, snapshot.skillIds.filter((id) => baseSkills.has(id)).length),
    base.skillIds.length,
  );

  return (
    <Panel title="比較">
      <DistributionOverlay columns={columns} />

      <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={onlyDiff}
            onChange={(e) => setOnlyDiff(e.target.checked)}
          />
          差のある項目だけ表示
        </label>
        <label className="flex items-center gap-1.5">
          基準
          <select
            className="rounded-sm border border-rule2 bg-surface px-1.5 py-0.5 text-xs"
            value={base.id}
            onChange={(e) => setBaseId(Number(e.target.value))}
          >
            {columns.map((snapshot) => (
              <option key={snapshot.id} value={snapshot.id}>
                #{snapshot.id}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] text-sm">
          <thead>
            <tr>
              <th scope="col" className="py-1 text-left font-normal text-ink3">
                項目
              </th>
              {columns.map((snapshot, i) => (
                <th key={snapshot.id} scope="col" className="py-1 text-right font-bold">
                  {i < 3 && (
                    <span
                      className="mr-1 inline-block h-2 w-2 rounded-full align-middle"
                      style={{ background: SERIES_COLORS[i] }}
                    />
                  )}
                  <button
                    type="button"
                    className="underline decoration-dotted"
                    onClick={() => restoreSnapshot(snapshot.id)}
                    aria-label={`スナップショット ${snapshot.id} の設定を入力欄に戻す`}
                    title="この設定を入力欄に戻す"
                  >
                    #{snapshot.id}
                  </button>
                  {snapshot.id === base.id && (
                    <span className="ml-1 text-[11px] font-normal text-ink3">基準</span>
                  )}
                  <button
                    type="button"
                    className="ml-1 text-ink3"
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
            {GROUPS.map((group) => {
              const rows = group.rows.filter(
                (row) => !onlyDiff || columns.some((s) => row.value(s) !== row.value(base)),
              );
              if (rows.length === 0) return null;
              return (
                <Fragment key={group.name}>
                  <tr className="bg-sunken">
                    <td colSpan={columns.length + 1} className="py-1 text-xs font-bold text-ink2">
                      {group.name}
                    </td>
                  </tr>
                  {rows.map((row) => {
                    const baseValue = row.value(base);
                    return (
                      <tr key={row.label} className="border-b border-rule last:border-0">
                        <th scope="row" className="py-1 text-left font-normal text-ink3">
                          {row.label}
                        </th>
                        {columns.map((snapshot) => {
                          const value = row.value(snapshot);
                          const differs = value !== baseValue;
                          const delta =
                            row.numeric === true && differs
                              ? row.amount !== undefined
                                ? row.amount(snapshot) - row.amount(base)
                                : Number(value) - Number(baseValue)
                              : Number.NaN;
                          const interval =
                            row.label === '平均タイム' && differs
                              ? confidenceInterval(base, snapshot)
                              : null;
                          return (
                            <td
                              key={snapshot.id}
                              className={`${row.numeric === true ? 'num ' : ''}py-1 text-right ${differs ? 'font-bold' : 'text-ink3'}`}
                            >
                              {value}
                              {Number.isFinite(delta) && (
                                <span className="ml-1 text-xs font-normal text-ink3">
                                  ({delta > 0 ? '+' : ''}
                                  {delta.toFixed(row.digits ?? 0)}
                                  {interval !== null && ` ±${interval.toFixed(3)}`})
                                </span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                  {group.name === 'スキル' && (
                    <>
                      <tr className="border-b border-rule">
                        <th scope="row" className="py-1 text-left font-normal text-ink3">
                          基準にないスキル
                        </th>
                        {columns.map((snapshot) => {
                          const added = snapshot.skillIds.filter((id) => !baseSkills.has(id));
                          return (
                            <td key={snapshot.id} className="py-1 text-right text-xs">
                              {added.length === 0 ? (
                                <span className="text-ink3">—</span>
                              ) : (
                                added.map(skillName).join('、')
                              )}
                            </td>
                          );
                        })}
                      </tr>
                      <tr className="border-b border-rule last:border-0">
                        <th scope="row" className="py-1 text-left font-normal text-ink3">
                          基準から外したスキル
                        </th>
                        {columns.map((snapshot) => {
                          const removed = base.skillIds.filter(
                            (id) => !snapshot.skillIds.includes(id),
                          );
                          return (
                            <td key={snapshot.id} className="py-1 text-right text-xs">
                              {removed.length === 0 ? (
                                <span className="text-ink3">—</span>
                              ) : (
                                removed.map(skillName).join('、')
                              )}
                            </td>
                          );
                        })}
                      </tr>
                      {commonCount > 0 && (
                        <tr>
                          <td
                            colSpan={columns.length + 1}
                            className="py-1 text-[11px] text-ink3"
                          >
                            残り {commonCount} 件のスキルは {columns.length} 件とも同じです
                          </td>
                        </tr>
                      )}
                    </>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-ink3">
        太字は基準と違う値です。括弧内は基準との差で、平均タイムには 95% の区間を添えてあります。
        区間は列どうしを別々に平均して求めたもので、探索の画面で使っている
        <strong>試行ごとに引き算した区間より広い</strong>です。
        スナップショットは別々に走らせたものなので、試行を対応付けられません。
      </p>
    </Panel>
  );
}

/**
 * 平均タイムの差の 95% 区間。
 *
 * スナップショットは毎試行の値を持たないので、対応付けた比較はできない。
 * 別々に平均した場合の区間になり、共通乱数の効きは乗らない。
 */
function confidenceInterval(base: Snapshot, other: Snapshot): number | null {
  if (base.sd === undefined || other.sd === undefined) return null;
  const n1 = base.summary.all.count;
  const n2 = other.summary.all.count;
  if (n1 < 2 || n2 < 2) return null;
  return 1.96 * Math.sqrt(base.sd ** 2 / n1 + other.sd ** 2 / n2);
}

export function ShareButton() {
  const shareUrl = useStore((s) => s.shareUrl);
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="rounded-sm border border-rule2 px-3 py-1.5 text-sm"
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
      {copied ? 'コピー済み' : '共有 URL のコピー'}
    </button>
  );
}
