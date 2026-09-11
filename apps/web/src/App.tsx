import { useEffect } from 'react';
import { CourseInput, OptionsInput, RunPanel, SkillInput, UmaInput } from './components/Inputs.tsx';
import { SummaryOutput } from './components/Summary.tsx';
import { FrameCharts } from './components/Charts.tsx';
import { CompareOutput } from './components/Compare.tsx';
import { InversePanel } from './components/Inverse.tsx';
import { OptimizePanel } from './components/Optimize.tsx';
import { FieldPanel } from './components/Field.tsx';
import { ImportPanel, StatusImportPanel } from './components/Import.tsx';
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
    <div className="flex h-screen flex-col bg-paper text-ink">
      <Header />
      <ErrorBanner />
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/*
          設定の面では入力欄そのものを、他の面では畳んだ要約を左に置く。
          モックの 1440px では設定 468px / 要約 280px である。
        */}
        {tab === 'settings' ? (
          <section className="flex w-full flex-none flex-col gap-3.5 overflow-y-auto border-b border-rule2 bg-surface p-5 md:w-[468px] md:border-r md:border-b-0">
            <UmaInput />
            <CourseInput />
            <SkillInput />
            <ImportPanel />
            <StatusImportPanel />
            <OptionsInput />
          </section>
        ) : (
          <SettingsRail />
        )}
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {/* 実行バーはどの面でも同じ場所にある。走らせるのに面を移らなくてよい。 */}
          <RunPanel />
          <div className="flex flex-col gap-4 p-5">
            {tab === 'settings' && <EmptyOrSummary />}
            {tab === 'summary' && <SummaryOutput />}
            {tab === 'compare' && <CompareOutput />}
            {tab === 'detail' && <FrameCharts />}
            {tab === 'field' && <FieldPanel />}
            {tab === 'solve' && (
              <>
                <InversePanel />
                <OptimizePanel />
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
      <div className="grid w-full max-w-xl grid-cols-1 gap-2.5 text-left sm:grid-cols-3">
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => applyPreset(preset)}
            className="flex flex-col gap-1.5 rounded-sm border border-rule2 bg-surface p-3 text-left hover:bg-sunken"
          >
            <span className="text-[13px] font-semibold">{preset.name}</span>
            <span className="text-[11px] text-ink3">{preset.note}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
