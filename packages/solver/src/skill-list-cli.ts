/**
 * スキル一覧の事前計算。全スキル × 代表コース × 脚質 × 基準個体の単体評価を回して JSON にする。
 *
 *   pnpm skill-list                         # 既定（代表コース 8 本・試行 200）
 *   pnpm skill-list --surface 1 --category MIDDLE --trials 200
 *   pnpm skill-list --styles SEN --baselines normal --max-skills 20   # 動作の確認
 *   pnpm skill-list --calibrate             # 基準個体のスタミナを測り直す
 *
 * 走らせる前に「N 組 / 約 M レース / 見込み X 分」を出す。**そのまま走らせると数時間かかる。**
 * Ctrl-C で止められる。止めたときは、そこまでに測った行だけを書き出す。
 *
 * 書き出し先は `apps/web/public/skill-list/<版>.json`。配るのと週次で作り直すのは別の仕事で、
 * ここは「このパスに置く」ところまでを持つ。issue #83、docs/roadmap.md 3.9 節。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGameData } from '../../data/src/node.ts';
import type { Style } from '../../sim/src/data/constants.ts';
import { defaultFieldProfile } from '../../sim/src/field/field.ts';
import { nodeWorkerFactory } from '../../sim/src/parallel/node.ts';
import { WorkerPool } from '../../sim/src/parallel/pool.ts';
import { defaultSystemSetting } from '../../sim/src/setting.ts';
import type { SkillListDataset, SkillListFile } from './skill-list.ts';
import { SKILL_LIST_INDEX_NAME, updateSkillListIndex } from './skill-list-index.ts';
import {
  REPRESENTATIVE_COURSES,
  SKILL_LIST_STYLES,
  baselinesFor,
  calibrateStamina,
  describePlan,
  planSkillList,
  runSkillList,
  type RepresentativeCourse,
  type SkillListOptions,
} from './skill-list-run.ts';
import {
  fieldProfileFingerprint,
  gitBlobSha1,
  raceModelFingerprint,
  skillListVersion,
  type RaceManifest,
} from './skill-list-version.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const list = (value: string): string[] =>
  value.split(',').map((x) => x.trim()).filter((x) => x !== '');

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const data = loadGameData();
const system = defaultSystemSetting();

const trials = Number(arg('trials', '200'));
const seed = Number(arg('seed', '1'));
const gateCount = Number(arg('gate', '9'));
const trackCondition = Number(arg('condition', '1'));
const samples = Number(arg('samples', '64'));
const useField = arg('field', 'on') !== 'off';
const surfaceArg = arg('surface', '');
const categoryArg = arg('category', '');
const stylesArg = arg('styles', '');
const baselinesArg = arg('baselines', '');
const maxSkillsArg = arg('max-skills', '');
const workersArg = arg('workers', '');
const outArg = arg('out', '');

const courses: RepresentativeCourse[] = REPRESENTATIVE_COURSES.filter(
  (course) =>
    (surfaceArg === '' || course.surface === Number(surfaceArg)) &&
    (categoryArg === '' || list(categoryArg).includes(course.category)),
);
const styles: Style[] =
  stylesArg === '' ? [...SKILL_LIST_STYLES] : (list(stylesArg) as Style[]);
const baselineIds = baselinesArg === '' ? undefined : list(baselinesArg);
const maxSkills = maxSkillsArg === '' ? undefined : Number(maxSkillsArg);

if (courses.length === 0) {
  console.error('当たる代表コースが無い。--surface は 1 か 2、--category は SHORT/MILE/MIDDLE/LONG。');
  process.exit(1);
}

const pool = new WorkerPool(nodeWorkerFactory, workersArg === '' ? undefined : Number(workersArg));

/** Ctrl-C で止める。止めたときは、そこまでに測った行を書き出す。 */
const controller = new AbortController();
let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  console.log('\n中断する。走っている 1 組が終わったところで書き出す。もう一度 Ctrl-C で即座に終了。');
  controller.abort();
});

console.log(`利用可能な並列数: ${availableParallelism()}（Worker ${pool.concurrency} 本）`);
console.log('');

try {
  if (flag('calibrate')) {
    // 基準個体のスタミナの測り直し。結果は skill-list-run.ts の CALIBRATED_STAMINA に手で写す。
    console.log(`基準個体のスタミナを測る（脚質をまとめて ${trials} 試行 × ${styles.length} 脚質）`);
    console.log('');
    const rows = await calibrateStamina(pool, data, system, {
      trials, seed, gateCount, trackCondition, styles, courses,
      onProgress: (message) => console.log(`  ${message}`),
    });
    console.log('');
    console.log('CALIBRATED_STAMINA に写す値（25 の倍数に丸めたもの）:');
    for (const row of rows) {
      const round25 = (x: number) => (Number.isFinite(x) ? Math.round(x / 25) * 25 : 0);
      console.log(
        `  '${row.course.surface}:${row.course.category}': ` +
          `{ normal: ${round25(row.p50)}, strong: ${round25(row.p90)} },` +
          ` // ${row.locationName} ${row.courseName}`,
      );
    }
  } else {
    const options: SkillListOptions = {
      trials, seed, gateCount, trackCondition, useField, samples,
      courses, styles, baselineIds, maxSkills,
      signal: controller.signal,
      onProgress: (message) => console.log(message),
    };

    console.log('代表コース:');
    for (const course of courses) {
      const baselines = baselinesFor(course);
      console.log(
        `  ${course.category} ${course.surface === 1 ? '芝' : 'ダ'} ${course.reason}` +
          `（スタミナ ${baselines.map((b) => `${b.label} ${b.stamina}`).join(' / ')}）`,
      );
    }
    console.log('');

    const plan = planSkillList(data, options);
    // 1 秒あたりに流せるレース数の見当。Worker 1 本で毎秒 300 レースとして数える。
    // 実測は 1200m で 600 前後、2400m で 260 前後なので、真ん中あたりの値である。
    // **長距離ばかりを指定したときは見込みより延びる。**
    const racesPerSecond = 300 * pool.concurrency;
    console.log(describePlan(plan, racesPerSecond));
    console.log(
      `設定: 試行 ${trials} ・ 順位条件 ${useField ? 'あり' : 'なし'}` +
        ` ・ ${gateCount} 頭立て ・ バ場 ${trackCondition} ・ 種 ${seed}` +
        (maxSkills === undefined ? '' : ` ・ 候補を ${maxSkills} 個で打ち切り`),
    );
    console.log('');

    const body = await runSkillList(pool, data, system, options);

    const dataset: SkillListDataset = {
      skills: gitBlobSha1(readFileSync(join(root, 'packages/data/assets/skills.json'))),
      courses: gitBlobSha1(readFileSync(join(root, 'packages/data/assets/courses.json'))),
      raceModel: raceModelFingerprint(
        JSON.parse(
          readFileSync(join(root, 'packages/sim/upstream/race-manifest.json'), 'utf8'),
        ) as RaceManifest,
      ),
      fieldProfile: fieldProfileFingerprint(defaultFieldProfile(gateCount)),
    };
    const version = skillListVersion(dataset);
    const file: SkillListFile = {
      format: 1,
      version,
      generatedAt: new Date().toISOString(),
      dataset,
      ...body,
    };

    const outDir = outArg === '' ? join(root, 'apps/web/public/skill-list') : outArg;
    mkdirSync(outDir, { recursive: true });
    const path = join(outDir, `${version}.json`);
    writeFileSync(path, JSON.stringify(file));
    const bytes = readFileSync(path).length;
    // 版を教える 1 枚。画面はまずこれを取り、`latest` の名前を隣から取りに行く。
    const index = updateSkillListIndex(outDir, `${version}.json`);

    console.log('');
    console.log(`版: ${version}`);
    console.log(`  skills.json      ${dataset.skills}`);
    console.log(`  courses.json     ${dataset.courses}`);
    console.log(`  race-manifest    ${dataset.raceModel}`);
    console.log(`  相手の分布       ${dataset.fieldProfile}`);
    console.log(
      `行 ${file.columns.length} ・ 走らせずに落とした組み合わせ ${file.screenedOut}` +
        ` ・ ${file.races} レース ・ ${(file.elapsedMs / 1000 / 60).toFixed(1)} 分`,
    );
    console.log(`書き出した: ${path}（${(bytes / 1024 / 1024).toFixed(2)} MB）`);
    console.log(
      `${SKILL_LIST_INDEX_NAME}: latest ${index.latest}` +
        ` ・ 置いてある版 ${index.generations.join(', ')}`,
    );
    if (interrupted) console.log('※ 中断したので、表は途中までである。');
  }
} finally {
  await pool.dispose();
}
