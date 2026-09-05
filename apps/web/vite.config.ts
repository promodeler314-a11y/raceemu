import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * スキルデータから、計算にも画面にも使っていない項目を落とす。
 *
 * `skills.json` は本家のデータをそのまま置いたもので、
 * 更新スクリプトが上書きする対象でもあるため、ファイル自体は触らない。
 * 落とすのはバンドルに入る段階だけにする。
 *
 * - `info`：条件と効果を日本語で書いた説明。約 220 kB ある。
 *   いまは誰も読んでいない。設計書 6.3 節の「近似の表示」で使う目が
 *   あるので、そのときは別ファイルとして取りに行く。
 * - `description`, `holder`：型にも計算にも現れない。
 */
function trimSkillData(): Plugin {
  const dropped = ['info', 'description', 'holder'];
  return {
    name: 'raceemu-trim-skill-data',
    enforce: 'pre',
    transform(code, id) {
      if (!id.endsWith('assets/skills.json')) return null;
      const skills = JSON.parse(code) as Record<string, unknown>[];
      for (const skill of skills) for (const key of dropped) delete skill[key];
      return { code: JSON.stringify(skills), map: null };
    },
  };
}

export default defineConfig({
  plugins: [trimSkillData(), react(), tailwindcss()],
  base: './',
  build: { target: 'es2022' },
  worker: { format: 'es', plugins: () => [trimSkillData()] },
});
