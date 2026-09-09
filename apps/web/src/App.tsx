import { useEffect } from 'react';
import { CourseInput, OptionsInput, RunPanel, SkillInput, UmaInput } from './components/Inputs.tsx';
import { SummaryOutput } from './components/Summary.tsx';
import { FrameCharts } from './components/Charts.tsx';
import { CompareOutput } from './components/Compare.tsx';
import { InversePanel } from './components/Inverse.tsx';
import { OptimizePanel } from './components/Optimize.tsx';
import { ErrorBanner } from './components/Notices.tsx';
import { Footer, Header, SettingsRail } from './components/Shell.tsx';
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
  if (summary === null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-24 text-center">
        <h2 className="text-base font-semibold">まだ実行していません</h2>
        <p className="max-w-md text-xs text-ink2">
          左で設定を決めて実行すると、試行の分布とスキルごとの発動状況が出ます。
        </p>
      </div>
    );
  }
  return <SummaryOutput />;
}
