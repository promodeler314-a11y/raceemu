import { execFileSync } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 組んだ版のコミット。フッタに出す。
 *
 * AGPL v3 の 13 条が実際に効くのは、他人にネットワーク越しに使わせるときである。
 * ソースへのリンクは前からあるが、**動かしている版と push してある版がズレると
 * リンクがあっても意味がない**（docs/server-design.md 6 節）。自前ホストは
 * 手で入れ替えられるぶんズレやすいので、どの版が動いているかを埋めておく。
 *
 * git の無い所で組んでも壊れないようにする。CI は `GITHUB_SHA` を持っているので
 * そちらを先に見て、どちらも取れなければ空にする（空ならフッタは何も出さない）。
 */
function commitSha(): string {
  const fromEnv = process.env['RACEEMU_COMMIT'] ?? process.env['GITHUB_SHA'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv.slice(0, 12);
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * スキルデータから、計算にも画面にも使っていない項目を落とす。
 *
 * `skills.json` は本家のデータをそのまま置いたもので、
 * 更新スクリプトが上書きする対象でもあるため、ファイル自体は触らない。
 * 落とすのはバンドルに入る段階だけにする。
 *
 * - `info`：条件と効果を日本語で書いた説明。約 220 kB ある。
 *   いまは誰も読んでいない。設計書 6.3 節の「近似の表示」で使う目が
 *   あるので、そのときは別ファイルとして取りに行く。近似の印（#58）は
 *   条件の型から理由を組み立てるので、これを落としたままで足りている
 *   （`packages/sim/src/skill/classify.ts`）。
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
  define: { __COMMIT_SHA__: JSON.stringify(commitSha()) },
  base: './',
  build: { target: 'es2022' },
  worker: { format: 'es', plugins: () => [trimSkillData([...MAIN_DROPPED, 'holder'])] },
});
