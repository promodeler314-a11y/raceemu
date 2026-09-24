import { useEffect } from 'react';
import {
  CourseInput,
  OpponentInput,
  OptionsInput,
  RunPanel,
  SkillInput,
  UmaInput,
} from './components/Inputs.tsx';
import { SummaryOutput } from './components/Summary.tsx';
import { FrameCharts } from './components/Charts.tsx';
import { CompareOutput } from './components/Compare.tsx';
import { CrossPanel } from './components/Cross.tsx';
import { InversePanel } from './components/Inverse.tsx';
import { OptimizePanel } from './components/Optimize.tsx';
import { SensitivityPanel } from './components/Sensitivity.tsx';
import { SkillListPanel } from './components/SkillList.tsx';
import { FieldPanel } from './components/Field.tsx';
import { ImportPanel, StatusImportPanel } from './components/Import.tsx';
import { TransferPanel } from './components/Transfer.tsx';
import { ErrorBanner } from './components/Notices.tsx';
import { Footer, Header, SettingsRail } from './components/Shell.tsx';
import { PRESETS } from './presets.ts';
import { useStore } from './store.ts';

export default function App() {
  const bootstrap = useStore((s) => s.bootstrap);
  const tab = useStore((s) => s.tab);
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // 戻る・進むで面を合わせる。pushState は hashchange を出さないので popstate も見る。
  useEffect(() => {
    const sync = () => useStore.getState().syncTabFromHash();
    window.addEventListener('popstate', sync);
    window.addEventListener('hashchange', sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener('hashchange', sync);
    };
  }, []);

  // 実行と中断だけは手を止めずに叩けるようにする。
  // 入力欄に文字を打っている最中でも困らない組み合わせを選んである。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { run, cancel, running, optimizeRunning } = useStore.getState();
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (!running && !optimizeRunning) void run();
        return;
      }
      if (event.key === 'Escape' && (running || optimizeRunning)) {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    // 広い幅では画面の高さに固定し、左右の列をそれぞれの中でスクロールさせる。
    // 狭い幅では列を縦に積むので、固定するとあとの列の高さが 0 になり、
    // 実行バーごと見えなくなる。狭い幅ではページ全体をスクロールさせる。
    <div className="flex min-h-screen flex-col bg-paper text-ink md:h-screen">
      <Header />
      <ErrorBanner />
      <div
        className={`flex flex-1 flex-col md:grid md:min-h-0 md:grid-rows-[auto_minmax(0,1fr)] ${
          tab === 'settings' ? 'md:grid-cols-[468px_minmax(0,1fr)]' : 'md:grid-cols-[280px_minmax(0,1fr)]'
        }`}
      >
        {/*
          実行バーはどの面でも同じ場所にある。走らせるのに面を移らなくてよい。
          広い幅では右の列の上端に置く。狭い幅では設定の列より先に置き、
          スクロールしても上に貼り付ける。設定を全部通らないと実行に届かない
          形にしない（docs/ui-gap.md 8 節、design/Mobile.dc.html）。
        */}
        <div className="sticky top-0 z-10 md:static md:col-start-2 md:row-start-1">
          <RunPanel />
        </div>
        {/*
          設定の面では入力欄そのものを、他の面では畳んだ要約を左に置く。
          モックの 1440px では設定 468px / 要約 280px である。
          relative は、中の sr-only（absolute）の置き場をこの列にするため。
          無いとページの外に置かれ、広い幅でもページ全体がスクロールしてしまう。
        */}
        {tab === 'settings' ? (
          <section className="relative flex w-full flex-none flex-col gap-3.5 border-b border-rule2 bg-surface p-5 md:col-start-1 md:row-span-2 md:row-start-1 md:min-h-0 md:overflow-y-auto md:border-r md:border-b-0">
            <UmaInput />
            <CourseInput />
            <SkillInput />
            <ImportPanel />
            <StatusImportPanel />
            <TransferPanel />
            <OptionsInput />
            <OpponentInput />
          </section>
        ) : (
          <SettingsRail />
        )}
        <main className="flex min-w-0 flex-1 flex-col md:col-start-2 md:row-start-2 md:min-h-0 md:overflow-y-auto">
          <div className="flex flex-col gap-4 p-5">
            {tab === 'settings' && <EmptyOrSummary />}
            {tab === 'summary' && <SummaryOutput />}
            {tab === 'compare' && (
              <>
                <CompareOutput />
                {/* コース横断は設定どうしではなくコースどうしの比較。同じ面に置く */}
                <CrossPanel />
              </>
            )}
            {tab === 'detail' && <FrameCharts />}
            {tab === 'field' && <FieldPanel />}
            {tab === 'skills' && <SkillListPanel />}
            {tab === 'solve' && (
              <>
                <InversePanel />
                <OptimizePanel />
                <SensitivityPanel />
              </>
            )}
          </div>
        </main>
      </div>
      <Footer />
    </div>
  );
}

/**
 * 設定の面の右側。
 *
 * まだ走らせていないときは、何をすればよいかを出す。
 * 走らせたあとは結果を出す。設定をいじりながら結果を見る往復が中心なので、
 * 設定の面から結果が消えると往復のたびにタブを移ることになる。
 */
function EmptyOrSummary() {
  const summary = useStore((s) => s.summary);
  const applyPreset = useStore((s) => s.applyPreset);
  const count = useStore((s) => s.count);
  if (summary !== null) return <SummaryOutput />;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 py-20 text-center">
      <svg width="52" height="52" viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-rule2">
        <path d="M6 40h36" />
        <path d="M6 40V8" />
        <path d="M10 33c6 0 8-14 14-14s8 8 14-6" strokeDasharray="3 3" />
      </svg>
      <div className="flex max-w-xl flex-col gap-2">
        <h2 className="text-lg font-semibold">まだ実行していません</h2>
        <p className="text-[13px] text-ink2">
          左で設定を決めて実行すると、{count.toLocaleString('ja-JP')} 回の試行からタイムの分布と
          スキルごとの発動状況が出ます。まず試すなら、下のプリセットから始めるのが早いです。
        </p>
      </div>
      {/*
        プリセットは罫線で区切った一覧にする。同じ形のカードを 3 枚横に並べる
        構成は使わない（docs/ui-audit-race-emulator.md 第1節「レイアウト」）。
      */}
      <ul className="w-full max-w-xl divide-y divide-rule border-y border-rule text-left">
        {PRESETS.map((preset) => (
          <li key={preset.id}>
            <button
              type="button"
              onClick={() => applyPreset(preset)}
              className="flex w-full flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-2 py-2.5 text-left hover:bg-sunken"
            >
              <span className="text-[13px] font-semibold">{preset.name}</span>
              <span className="text-[11px] text-ink3">{preset.note}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
