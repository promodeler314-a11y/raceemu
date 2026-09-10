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
 * - `description`：型にも計算にも現れない。
 * - `holder`：固有と進化の持ち主。画面でキャラを選ぶのに要るので本体には
 *   残し、計算しかしない Worker からだけ落とす。本体は 53 kB（gzip で 21 kB）
 *   増える。907 件が 266 通りの文字列を指すので、表に畳めば縮むが、
 *   読み込み側の形を変えることになるのでそこまではしていない。
 */
const MAIN_DROPPED = ['info', 'description'];

function trimSkillData(dropped: readonly string[]): Plugin {
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
  plugins: [trimSkillData(MAIN_DROPPED), react(), tailwindcss()],
  base: './',
  build: { target: 'es2022' },
  worker: { format: 'es', plugins: () => [trimSkillData([...MAIN_DROPPED, 'holder'])] },
});
