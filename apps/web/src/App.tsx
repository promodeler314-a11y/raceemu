import { useEffect } from 'react';
import { CourseInput, RunPanel, SkillInput, UmaInput } from './components/Inputs.tsx';
import { SummaryOutput } from './components/Summary.tsx';
import { FrameCharts } from './components/Charts.tsx';
import { CompareOutput, ShareButton, SkillSummaryOutput } from './components/Compare.tsx';
import { useStore } from './store.ts';

export default function App() {
  const applyShared = useStore((s) => s.applyShared);
  useEffect(() => {
    applyShared();
  }, [applyShared]);

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="border-b border-neutral-200 bg-white px-4 py-3 dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-base font-semibold">レースエミュレータ</h1>
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              mee1080/umasim の計算モデルを移植したもの。順位条件は満たしている前提で扱う。
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
          <RunPanel />
        </div>
        <div className="space-y-4">
          <SummaryOutput />
          <SkillSummaryOutput />
          <CompareOutput />
          <FrameCharts />
        </div>
      </main>
    </div>
  );
}
