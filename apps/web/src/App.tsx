import { useEffect } from 'react';
import { CourseInput, OptionsInput, RunPanel, SkillInput, UmaInput } from './components/Inputs.tsx';
import { SummaryOutput } from './components/Summary.tsx';
import { FrameCharts } from './components/Charts.tsx';
import { CompareOutput, ShareButton, SkillSummaryOutput } from './components/Compare.tsx';
import { InversePanel } from './components/Inverse.tsx';
import { OptimizePanel } from './components/Optimize.tsx';
import { useStore } from './store.ts';

export default function App() {
  const bootstrap = useStore((s) => s.bootstrap);
  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="border-b border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-base font-semibold">レースエミュレータ</h1>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              mee1080/umasim の計算モデルを移植したもの。順位条件の判定、逆算、組み合わせ探索を足してある。
            </p>
          </div>
          <ShareButton />
        </div>
      </header>
      <main className="mx-auto grid max-w-6xl gap-4 p-4 lg:grid-cols-2">
        <div className="space-y-4">
          <CourseInput />
          <UmaInput />
          <SkillInput />
          <OptionsInput />
          <RunPanel />
          <InversePanel />
          <OptimizePanel />
        </div>
        <div className="space-y-4">
          <SummaryOutput />
          <SkillSummaryOutput />
          <CompareOutput />
          <FrameCharts />
        </div>
      </main>
      <footer className="mt-4 border-t border-neutral-200 px-4 py-3 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
        計算モデルは{' '}
        <a
          className="underline"
          href="https://github.com/mee1080/umasim"
          target="_blank"
          rel="noreferrer noopener"
        >
          mee1080/umasim
        </a>{' '}
        からの移植です。本アプリは AGPL v3 で公開しており、
        <a
          className="underline"
          href="https://github.com/promodeler314-a11y/raceemu"
          target="_blank"
          rel="noreferrer noopener"
        >
          ソースはこちら
        </a>
        から取得できます。
      </footer>
    </div>
  );
}
