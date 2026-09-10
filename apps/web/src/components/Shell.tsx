import { currentTrackDetail, gameData, useStore, type Tab } from '../store.ts';
import { ShareButton } from './Compare.tsx';

/**
 * 画面の骨格。
 *
 * [モック](../../../../design/README.md)の 6 面に共通する枠で、
 * ヘッダのタブ、左の設定列、フッタからなる。
 * 値は `design/*.dc.html` から取っている。
 */

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'settings', label: '設定' },
  { id: 'summary', label: '結果' },
  { id: 'compare', label: '比較' },
  { id: 'detail', label: '詳細' },
  { id: 'field', label: '勝率' },
  { id: 'solve', label: '探索' },
];

function surfaceName(surface: number): string {
  return surface === 1 ? '芝' : 'ダート';
}

const STYLE_LABELS: Record<string, string> = {
  NIGE: '逃げ',
  SEN: '先行',
  SASI: '差し',
  OI: '追込',
};

/** ヘッダに出す「いまの条件」。コースと脚質だけを短くまとめる。 */
function useConditionLine(): string {
  const uma = useStore((s) => s.uma);
  const track = useStore((s) => s.track);
  const detail = currentTrackDetail(track);
  const place = gameData.trackData[track.location]?.name ?? '';
  const course = detail === undefined ? '' : `${surfaceName(detail.surface)}${detail.distance}m`;
  return [`${place} ${course}`.trim(), STYLE_LABELS[uma.style] ?? uma.style]
    .filter((part) => part !== '')
    .join(' ／ ');
}

function ThemeToggle() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  return (
    <div className="flex h-[30px] overflow-hidden rounded-sm border border-rule2">
      {(['light', 'dark'] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={theme === value}
          onClick={() => setTheme(value)}
          className={`flex w-12 items-center justify-center border-r border-rule text-xs last:border-r-0 ${
            theme === value ? 'bg-acc-tint font-semibold text-acc-ink' : 'bg-surface text-ink2'
          }`}
        >
          {value === 'light' ? 'ライト' : 'ダーク'}
        </button>
      ))}
    </div>
  );
}

/**
 * スナップショットの保存はヘッダに置く。
 *
 * 比較の面の中にあると、保存するたびに面を移ることになる。
 * 「設定を少し変えて実行し、前のと並べる」が使い方の中心なので、
 * その往復の途中で面を移らせない。
 */
function SaveSnapshotButton() {
  const summary = useStore((s) => s.summary);
  const saveSnapshot = useStore((s) => s.saveSnapshot);
  return (
    <button
      type="button"
      className="h-[30px] rounded-sm bg-primary-bg px-3 text-xs font-semibold text-primary-fg disabled:opacity-40"
      onClick={saveSnapshot}
      disabled={summary === null}
    >
      スナップショットを保存
    </button>
  );
}

/** モックは 1440px しか描いていない。狭い幅では折り返して縦に伸ばす。 */
export function Header() {
  const tab = useStore((s) => s.tab);
  const setTab = useStore((s) => s.setTab);
  const summary = useStore((s) => s.summary);
  const condition = useConditionLine();

  return (
    <header className="flex flex-none flex-wrap items-center gap-x-5 gap-y-2 border-b border-rule2 bg-surface px-5 py-2 md:h-[52px] md:flex-nowrap md:py-0">
      <h1 className="font-mono text-[11px] tracking-[0.14em] text-ink2">RACE EMULATOR</h1>
      {/* タブが増えると狭い幅では収まらないので、はみ出すぶんは横に送る */}
      <nav className="flex min-w-0 max-w-full gap-0.5 self-stretch overflow-x-auto" aria-label="画面">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => setTab(id)}
            className={`flex flex-none items-center px-3 text-[13px] ${
              tab === id ? 'font-semibold text-ink shadow-[inset_0_-2px_0_var(--color-s1)]' : 'text-ink3'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>
      {/* 狭い幅ではタブが折り返すので、この行も折り返せるようにしておく */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <span className="truncate text-[13px] text-ink2">{condition}</span>
        {summary === null && <span className="flex-none text-[11px] text-ink3">未実行</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2 md:flex-none md:flex-nowrap">
        <ThemeToggle />
        <ShareButton />
        <SaveSnapshotButton />
      </div>
    </header>
  );
}

export function Footer() {
  const summary = useStore((s) => s.summary);
  const elapsedMs = useStore((s) => s.elapsedMs);
  return (
    <footer className="flex flex-none items-center gap-4 border-t border-rule bg-surface px-5 py-1.5 text-[11px] text-ink3">
      <span>設定は自動で保存されます</span>
      {summary !== null && (
        <span className="num">
          {summary.all.count.toLocaleString('ja-JP')} 試行 ・ {(elapsedMs / 1000).toFixed(2)} 秒
        </span>
      )}
      <span className="flex-1" />
      <span>
        計算モデルは{' '}
        <a
          className="text-ink2 underline"
          href="https://github.com/mee1080/umasim"
          target="_blank"
          rel="noreferrer noopener"
        >
          mee1080/umasim
        </a>{' '}
        の移植 ・ AGPL v3 ・{' '}
        <a
          className="text-ink2 underline"
          href="https://github.com/promodeler314-a11y/raceemu"
          target="_blank"
          rel="noreferrer noopener"
        >
          ソースはこちら
        </a>
      </span>
    </footer>
  );
}

/**
 * 設定を畳んだ要約。設定以外の面では、左をこれに入れ替える。
 * 何を見ているかを見失わないためのもので、編集は設定の面でする。
 */
export function SettingsRail() {
  const uma = useStore((s) => s.uma);
  const track = useStore((s) => s.track);
  const skillIds = useStore((s) => s.skillIds);
  const snapshots = useStore((s) => s.snapshots);
  const setTab = useStore((s) => s.setTab);
  const detail = currentTrackDetail(track);
  const place = gameData.trackData[track.location]?.name ?? '';

  const rows: readonly [string, string][] = [
    ['ウマ娘', `${STYLE_LABELS[uma.style] ?? uma.style} ・ 適性 ${uma.distanceFit}/${uma.surfaceFit}/${uma.styleFit}`],
    ['', `${uma.speed} / ${uma.stamina} / ${uma.power} / ${uma.guts} / ${uma.wisdom}`],
    ['コース', `${place} ${detail === undefined ? '' : `${surfaceName(detail.surface)}${detail.distance}m`}`],
    ['', `${track.gateCount} 頭 ・ コーナー ${detail?.corners.length ?? 0}`],
    ['所持スキル', `${skillIds.length} 件`],
  ];

  return (
    <aside className="flex w-full flex-none flex-col gap-4 overflow-y-auto border-b border-rule2 bg-surface p-4 md:w-[280px] md:border-r md:border-b-0">
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold">設定</span>
        <span className="flex-1" />
        <button type="button" className="text-xs text-s1 underline" onClick={() => setTab('settings')}>
          編集
        </button>
      </div>
      <div className="flex flex-col gap-2.5">
        {rows.map(([label, value], i) => (
          <div key={i} className="flex flex-col gap-0.5">
            {label !== '' && <span className="text-[11px] text-ink3">{label}</span>}
            <span className={`text-xs ${label === '' ? 'num text-ink2' : ''}`}>{value}</span>
          </div>
        ))}
      </div>
      {snapshots.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-rule pt-3">
          <span className="text-[13px] font-semibold">
            スナップショット <span className="text-[11px] font-normal text-ink3">{snapshots.length}</span>
          </span>
          {snapshots.map((snapshot) => (
            <div key={snapshot.id} className="rounded-sm border border-rule px-2.5 py-2">
              <div className="text-xs font-semibold">{snapshot.label}</div>
              <div className="num text-xs text-ink2">
                {snapshot.summary.all.averageTime.toFixed(3)}
              </div>
            </div>
          ))}
          <button type="button" className="text-left text-xs text-s1 underline" onClick={() => setTab('compare')}>
            {snapshots.length} 件を比較する
          </button>
        </div>
      )}
    </aside>
  );
}
