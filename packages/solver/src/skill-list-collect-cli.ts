/**
 * 分けて回したスキル一覧の成果をまとめ、版とコースの一覧（`index.json`）を作り直す。
 *
 *   pnpm skill-list-collect                       # 既定の置き場を数え直す
 *   pnpm skill-list-collect --from a --from b     # 分片の出力を取り込んでから数え直す
 *
 * **全 137 コースは 1 ジョブでは回りきらない。** GitHub Actions の 1 ジョブは 6 時間で
 * 切られるので、`--shard i/N` で分けて回す（`.github/workflows/build-skill-list.yml`）。
 * 分片はそれぞれ自分が測ったコースしか知らないから、最後にここで**置いてあるものを
 * 数え直して**一覧を書く。
 *
 * 版は生成側とまったく同じ計算（`readSkillListDataset`）で出す。ここだけ別に計算すると、
 * 置いてあるコースを 1 本も見つけられず、画面からは「表が無い」と区別が付かない。
 */
import { cpSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGameData } from '../../data/src/node.ts';
import {
  SKILL_LIST_INDEX_NAME,
  collectSkillListCourses,
  updateSkillListIndex,
} from './skill-list-index.ts';
import { allSkillListCourses } from './skill-list-run.ts';
import { readSkillListDataset, skillListVersion } from './skill-list-version.ts';
import type { SkillListSettings } from './skill-list.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : fallback;
}
/** 同じ名前を何度でも書ける引数。分片の数だけ `--from` を並べる。 */
function args(name: string): string[] {
  const out: string[] = [];
  for (const [i, value] of process.argv.entries()) {
    if (value === `--${name}` && i + 1 < process.argv.length) out.push(process.argv[i + 1]!);
  }
  return out;
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const outDir = arg('out', join(root, 'apps/web/public/skill-list'));
const gateCount = Number(arg('gate', '9'));
const trials = Number(arg('trials', '100'));
const seed = Number(arg('seed', '1'));
const trackCondition = Number(arg('condition', '1'));
const useField = arg('field', 'on') !== 'off';

const dataset = readSkillListDataset(root, gateCount);
const version = skillListVersion(dataset);

// 分片の出力を取り込む。**版のディレクトリごと**なので、同じ版のコースが並ぶだけである。
// 同じコースが 2 つの分片に出ることは無い（`shardCourses` が重ならないように分ける）。
for (const from of args('from')) {
  if (!existsSync(from)) {
    console.error(`::error::取り込み元が無い: ${from}`);
    process.exit(1);
  }
  for (const name of readdirSync(from)) {
    if (name === SKILL_LIST_INDEX_NAME) continue; // 分片の一覧は使わない。数え直す。
    cpSync(join(from, name), join(outDir, name), { recursive: true });
  }
}

const entries = collectSkillListCourses(outDir, version);
if (entries.length === 0) {
  // 1 本も見つからないのは、分片が全部こけたか、版の計算が食い違っているかである。
  // どちらも「表が無い」まま緑で終わってはならない。
  console.error(`::error::${outDir}/${version} に測ったコースが 1 本も無い`);
  process.exit(1);
}

const settings: SkillListSettings = { trials, useField, gateCount, seed, trackCondition };
const index = updateSkillListIndex(outDir, { version, dataset, settings, entries });
const total = allSkillListCourses(loadGameData()).length;

console.log(`版: ${version}`);
console.log(`コース ${index.courses.length} / ${total}`);
console.log(`行 ${index.courses.reduce((sum, entry) => sum + entry.rows, 0)}`);
console.log(`置いてある版: ${index.generations.join(', ')}`);
