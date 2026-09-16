/**
 * スキル一覧を作り直す要があるかを、**走らせずに**調べる。
 *
 *   pnpm skill-list-check --out apps/web/public/skill-list
 *
 * `.github/workflows/build-skill-list.yml` が matrix の**前**に呼ぶ。
 *
 * ## なぜ要るか
 *
 * 表を作り直すのは 24 分片で 50 ジョブ時間ほどかかる。**それを全部回してから
 * 「版は変わらなかった」と気付くのでは遅い。** 起動条件の 4 パスのうち
 * `packages/sim/src/field/field.ts` は普通の開発で動く一方、版を決めるのは
 * `defaultFieldProfile` の**中身**の指紋なので、触っても版が変わらない回が多い。
 *
 * 版はリポジトリの中の材料だけから決まる（`readSkillListDataset`）ので、
 * 数秒で分かる。生成と取りまとめとまったく同じ関数を使う。**ここだけ別に
 * 計算すると、関所が「変わっていない」と言ったのに実は違う版だった、という
 * 取り違えが起きる。**
 *
 * ## 何を出すか
 *
 * GitHub Actions の `$GITHUB_OUTPUT` にそのまま流せる `鍵=値` の行を出す。
 * **判断はしない。** `force` を見て回すかどうかを決めるのはワークフローの仕事である。
 *
 *   version=v2-xxxxxxxxxxxx   いまの材料から決まる版
 *   courses=137               その版で置いてあるコースの数
 *   total=137                 データにあるコースの数
 *   complete=true             全部そろっているか
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGameData } from '../../data/src/node.ts';
import { readSkillListIndex } from './skill-list-index.ts';
import { allSkillListCourses } from './skill-list-run.ts';
import { readSkillListDataset, skillListVersion } from './skill-list-version.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : fallback;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const outDir = arg('out', join(root, 'apps/web/public/skill-list'));
const gateCount = Number(arg('gate', '9'));

const version = skillListVersion(readSkillListDataset(root, gateCount));
const total = allSkillListCourses(loadGameData()).length;

// 版が違えば、置いてあるコースは別の材料で測ったものなので数えない。
const index = readSkillListIndex(outDir);
const courses = index?.version === version ? index.courses.length : 0;

console.log(`version=${version}`);
console.log(`courses=${courses}`);
console.log(`total=${total}`);
console.log(`complete=${courses >= total ? 'true' : 'false'}`);
