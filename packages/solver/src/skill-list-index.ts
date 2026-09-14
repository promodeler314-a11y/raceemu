/**
 * 版を教える 1 枚（`skill-list/index.json`）の書き出し。
 *
 * **読む側は版を当てられない。** 版はデータと計算式と相手の分布の指紋から決まるので、
 * 画面がファイル名を組み立てることはできない。名前を教える 1 枚をあいだに置く。
 * 形は `skill-list.ts` の `SkillListIndex` にある。
 *
 * **表は版ごとに別ファイルにし、この 1 枚は小さく保つ。** 表は数 MB あるので、
 * 画面が版を知るためだけに毎回それを取りに行くのは無駄である。
 *
 * **このファイルは Node でしか動かない**（`node:fs` を読む）。画面から import してはならない。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSkillListIndex, type SkillListIndex } from './skill-list.ts';

export const SKILL_LIST_INDEX_NAME = 'index.json';

/**
 * 残す世代の数。
 *
 * 入れ替えの最中に古い画面が前の版を取りに来るので、1 世代前まで残す。
 * 配布のワークフロー（`.github/workflows/build-skill-list.yml`）の掃除も 2 世代である。
 */
export const KEEP_GENERATIONS = 2;

/**
 * 既にある 1 枚に新しい版を足した形を作る。**ファイルには触らない。**
 *
 * 同じ版をもう一度作ったときは、世代が二重に並ばないようにする
 * （材料が動いていなければ版は同じ文字列になるので、これは普通に起きる）。
 */
export function nextSkillListIndex(
  current: unknown,
  fileName: string,
  keep: number = KEEP_GENERATIONS,
): SkillListIndex {
  const previous = isSkillListIndex(current) ? current.generations : [];
  const generations = [fileName, ...previous.filter((name) => name !== fileName)].slice(
    0,
    Math.max(1, keep),
  );
  return { latest: fileName, generations };
}

/**
 * `index.json` を読んで書き直す。無ければ新しく作る。
 *
 * 置いてある版の一覧は**ディレクトリを見て作り直さない**。配布の側が古い版を
 * 掃除する作りになっており、こちらが勝手に消えたファイルを落とすと、
 * まだ配られている版を一覧から外してしまう。
 */
export function updateSkillListIndex(
  dir: string,
  fileName: string,
  keep: number = KEEP_GENERATIONS,
): SkillListIndex {
  const path = join(dir, SKILL_LIST_INDEX_NAME);
  let current: unknown = null;
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // 壊れていたら作り直す。読めない 1 枚を残すより、新しい版だけを指すほうが良い。
      current = null;
    }
  }
  const next = nextSkillListIndex(current, fileName, keep);
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
