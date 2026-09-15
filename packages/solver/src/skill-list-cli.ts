/**
 * スキル一覧の事前計算。全スキル × **コース** × 脚質 × 基準個体の単体評価を回して JSON にする。
 *
 *   pnpm skill-list --courses 10006-10606        # 東京 芝2400m を 1 本
 *   pnpm skill-list --location 10006 --surface 1 # 東京の芝を全部
 *   pnpm skill-list --shard 0/8                  # 全 137 コースを 8 等分した 0 番目
 *   pnpm skill-list --list                       # 何が測ってあって何が残っているかを出す
 *   pnpm skill-list --calibrate                  # 基準個体のスタミナをコースごとに測り直す
 *
 * **距離帯の代表は選ばない。** 同じ距離帯でもコースが違えば効くスキルが違うので、
 * コースごとに 1 枚ずつ測って 1 枚ずつ配る（`skill-list.ts` の注記）。
 * 全 137 コースは 20 時間を超えるので、**分けて回して足していく**のが普通の使い方である。
 *
 * 走らせる前に「N コース / M 組 / 見込み X 時間」を出す。Ctrl-C で止められる。
 * 止めたときは、**そこまでに終わったコースだけ**を書き出す（測りかけの 1 枚は捨てる）。
 *
 * 書き出し先は `apps/web/public/skill-list/<版>/<場>-<コース>.json` と `index.json`。
 * issue #83、docs/roadmap.md 3.9 節。
 */
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGameData } from '../../data/src/node.ts';
import type { Style } from '../../sim/src/data/constants.ts';
import { nodeWorkerFactory } from '../../sim/src/parallel/node.ts';
import { WorkerPool } from '../../sim/src/parallel/pool.ts';
import { defaultSystemSetting } from '../../sim/src/setting.ts';
import {
  SKILL_LIST_FORMAT,
  skillListCourseKey,
  type SkillListCategory,
  type SkillListCourse,
  type SkillListCourseFile,
  type SkillListDataset,
  type SkillListIndexEntry,
  type SkillListSettings,
} from './skill-list.ts';
import {
  SKILL_LIST_INDEX_NAME,
  readSkillListIndex,
  updateSkillListIndex,
  writeSkillListCourse,
} from './skill-list-index.ts';
import {
  SKILL_LIST_STYLES,
  SkillListInterrupted,
  allSkillListCourses,
  calibrateStamina,
  describePlan,
  planSkillList,
  runSkillListCourse,
  selectCourses,
  shardCourses,
  type SkillListOptions,
} from './skill-list-run.ts';
import {
  STAMINA_TABLE_PATH,
  baselinesFor,
  hasStamina,
  loadStaminaTable,
  saveStaminaTable,
  type StaminaEntry,
} from './skill-list-stamina.ts';
import { readSkillListDataset, skillListVersion } from './skill-list-version.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const list = (value: string): string[] =>
  value.split(',').map((x) => x.trim()).filter((x) => x !== '');
const numbers = (value: string): number[] => list(value).map(Number);

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const data = loadGameData();
const system = defaultSystemSetting();

const trials = Number(arg('trials', '200'));
const seed = Number(arg('seed', '1'));
const gateCount = Number(arg('gate', '9'));
const trackCondition = Number(arg('condition', '1'));
const samples = Number(arg('samples', '64'));
const useField = arg('field', 'on') !== 'off';
const stylesArg = arg('styles', '');
const baselinesArg = arg('baselines', '');
const maxSkillsArg = arg('max-skills', '');
const workersArg = arg('workers', '');
const outArg = arg('out', '');
const limitArg = arg('limit', '');
const shardArg = arg('shard', '');

const styles: Style[] = stylesArg === '' ? [...SKILL_LIST_STYLES] : (list(stylesArg) as Style[]);
const baselineIds = baselinesArg === '' ? undefined : list(baselinesArg);
const maxSkills = maxSkillsArg === '' ? undefined : Number(maxSkillsArg);
const outDir = outArg === '' ? join(root, 'apps/web/public/skill-list') : outArg;

const everyCourse = allSkillListCourses(data);
let courses = selectCourses(everyCourse, {
  surfaces: numbers(arg('surface', '')),
  categories: list(arg('category', '')) as SkillListCategory[],
  locations: numbers(arg('location', '')),
  distances: numbers(arg('distance', '')),
  keys: list(arg('courses', '')),
});

if (shardArg !== '') {
  const [indexPart, countPart] = shardArg.split('/');
  const shardIndex = Number(indexPart);
  const shardCount = Number(countPart);
  if (!Number.isInteger(shardIndex) || !Number.isInteger(shardCount) || shardCount < 1) {
    console.error(`--shard は「0/8」の形で書く（読めない: ${shardArg}）`);
    process.exit(1);
  }
  courses = shardCourses(courses, shardIndex, shardCount);
}

const stamina = loadStaminaTable();

/* ------------------------------------------------------------------ */
/* --list：走らせずに、何が測ってあるかだけを出す                     */
/* ------------------------------------------------------------------ */

if (flag('list')) {
  const index = readSkillListIndex(outDir);
  const done = new Set(
    (index?.courses ?? []).map((entry) =>
      skillListCourseKey(entry.course.location, entry.course.course),
    ),
  );
  console.log(`置き場: ${outDir}`);
  console.log(
    index === null
      ? `${SKILL_LIST_INDEX_NAME} が無い。まだ 1 コースも測っていない。`
      : `版 ${index.version} ・ 測ってあるコース ${index.courses.length} / ${everyCourse.length}`,
  );
  console.log(
    `基準個体のスタミナ: ${Object.keys(stamina?.courses ?? {}).length}` +
      ` / ${everyCourse.length} コース（${STAMINA_TABLE_PATH}）`,
  );
  console.log('');
  for (const course of courses) {
    const key = skillListCourseKey(course.location, course.course);
    const measured = stamina?.courses[key];
    console.log(
      `  ${done.has(key) ? '済' : '未'} ${key} ${course.locationName} ${course.courseName}` +
        `（${course.category}）` +
        (measured === undefined
          ? ' ・ スタミナ未測定'
          : ` ・ スタミナ ${measured.normal}/${measured.strong}`),
    );
  }
  process.exit(0);
}

if (courses.length === 0) {
  console.error(
    '当たるコースが無い。--surface は 1 か 2、--category は SHORT/MILE/MIDDLE/LONG、' +
      '--courses は 10006-10606 の形。--list で一覧が出る。',
  );
  process.exit(1);
}

const pool = new WorkerPool(nodeWorkerFactory, workersArg === '' ? undefined : Number(workersArg));

/** Ctrl-C で止める。止めたときは、そこまでに**終わったコース**を書き出す。 */
const controller = new AbortController();
let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  console.log('\n中断する。測りかけの 1 コースは捨て、終わったコースまでを書き出す。もう一度 Ctrl-C で即座に終了。');
  controller.abort();
});

console.log(`利用可能な並列数: ${availableParallelism()}（Worker ${pool.concurrency} 本）`);
console.log('');

try {
  if (flag('calibrate')) {
    /* -------------------------------------------------------------- */
    /* --calibrate：基準個体のスタミナをコースごとに測る               */
    /* -------------------------------------------------------------- */
    console.log(
      `基準個体のスタミナを測る（${courses.length} コース ・ 脚質をまとめて ${trials} 試行 × ${styles.length} 脚質）`,
    );
    console.log(`書き出し先: ${STAMINA_TABLE_PATH}`);
    console.log('');
    const measured: Record<string, StaminaEntry> = {};
    const round25 = (x: number) => (Number.isFinite(x) ? Math.round(x / 25) * 25 : 0);
    const settings = { trials, seed, gateCount, trackCondition, from: 200, to: 1600, step: 5 };
    try {
      await calibrateStamina(pool, data, system, courses, {
        trials, seed, gateCount, trackCondition, styles,
        signal: controller.signal,
        onProgress: (row, done, total) => {
          const key = skillListCourseKey(row.course.location, row.course.course);
          measured[key] = {
            normal: round25(row.p50),
            strong: round25(row.p90),
            unreached: Math.round(row.unreachedRate * 1000) / 1000,
          };
          console.log(
            `  [${done}/${total}] ${key} ${row.course.locationName} ${row.course.courseName}` +
              `: ${measured[key]!.normal} / ${measured[key]!.strong}` +
              ` ・ 届かなかった試行 ${(row.unreachedRate * 100).toFixed(1)} %`,
          );
        },
      });
    } finally {
      // 中断しても、そこまでに測ったぶんは書く。測り直しは高くない。
      const table = saveStaminaTable(measured, settings);
      console.log('');
      console.log(
        `書き出した: ${Object.keys(measured).length} コースを足して` +
          ` 合計 ${Object.keys(table.courses).length} / ${everyCourse.length} コース`,
      );
    }
  } else {
    /* -------------------------------------------------------------- */
    /* 本番：コースごとに測って 1 枚ずつ書く                            */
    /* -------------------------------------------------------------- */
    const missing = courses.filter((course) => !hasStamina(course, stamina));
    if (missing.length > 0) {
      // 当て推量のスタミナで測った表は「どの個体の話か」に答えられない。
      // 黙って当て推量に落ちるより、測ってから来いと言うほうがよい。
      console.error(
        `基準個体のスタミナを測っていないコースが ${missing.length} 本ある。` +
          `先に pnpm skill-list --calibrate を回すこと。`,
      );
      for (const course of missing.slice(0, 10)) {
        console.error(
          `  ${skillListCourseKey(course.location, course.course)} ${course.locationName} ${course.courseName}`,
        );
      }
      if (missing.length > 10) console.error(`  ほか ${missing.length - 10} 本`);
      process.exit(1);
    }

    const options: SkillListOptions = {
      trials, seed, gateCount, trackCondition, useField, samples,
      styles, baselineIds, maxSkills, stamina,
      signal: controller.signal,
      onProgress: (message) => console.log(message),
    };

    const index = readSkillListIndex(outDir);
    if (limitArg !== '') {
      // 既に測ってあるコースは飛ばしてから頭を取る。回すたびに先が進む。
      const done = new Set(
        (index?.courses ?? []).map((entry) =>
          skillListCourseKey(entry.course.location, entry.course.course),
        ),
      );
      courses = courses
        .filter((course) => !done.has(skillListCourseKey(course.location, course.course)))
        .slice(0, Number(limitArg));
    }

    const plan = planSkillList(data, courses, options);
    // 1 秒あたりに流せるレース数の見当。Worker 1 本で毎秒 300 レースとして数える。
    // 実測は 1200m で 600 前後、2400m で 260 前後なので、真ん中あたりの値である。
    // **長距離ばかりを引いた分片は見込みより延びる。**
    console.log(describePlan(plan, courses.length, 300 * pool.concurrency));
    console.log(
      `設定: 試行 ${trials} ・ 順位条件 ${useField ? 'あり' : 'なし'}` +
        ` ・ ${gateCount} 頭立て ・ バ場 ${trackCondition} ・ 種 ${seed}` +
        (maxSkills === undefined ? '' : ` ・ 候補を ${maxSkills} 個で打ち切り`),
    );
    console.log('');

    const dataset: SkillListDataset = readSkillListDataset(root, gateCount);
    const version = skillListVersion(dataset);
    console.log(`版: ${version}`);
    console.log(`  skills.json      ${dataset.skills}`);
    console.log(`  courses.json     ${dataset.courses}`);
    console.log(`  race-manifest    ${dataset.raceModel}`);
    console.log(`  相手の分布       ${dataset.fieldProfile}`);
    console.log('');

    const settings: SkillListSettings = { trials, useField, gateCount, seed, trackCondition };
    const written: SkillListIndexEntry[] = [];
    const startedAll = performance.now();

    for (const [i, course] of courses.entries()) {
      const baselines = baselinesFor(course, stamina);
      console.log(
        `[${i + 1}/${courses.length}] ${course.locationName} ${course.courseName}` +
          `（${course.category} ・ スタミナ ${baselines.map((b) => `${b.label} ${b.stamina}`).join(' / ')}）`,
      );
      let body;
      try {
        body = await runSkillListCourse(pool, data, system, course, options);
      } catch (error) {
        if (error instanceof SkillListInterrupted) break;
        throw error;
      }
      const file: SkillListCourseFile = {
        format: SKILL_LIST_FORMAT,
        version,
        generatedAt: new Date().toISOString(),
        dataset,
        ...body,
      };
      const entry = writeSkillListCourse(outDir, file);
      written.push(entry);
      console.log(
        `  → ${entry.file} ・ 行 ${entry.rows} ・ ${file.races} レース` +
          ` ・ ${(file.elapsedMs / 1000 / 60).toFixed(1)} 分`,
      );
    }

    // 1 枚も書けていなくても一覧は書き直す（版が変わっていれば、前の版の
    // コースが残っているように見えるのを止められる）。
    const next = updateSkillListIndex(outDir, { version, dataset, settings, entries: written });

    console.log('');
    console.log(
      `今回 ${written.length} コース ・ 全部で ${next.courses.length} / ${everyCourse.length} コース` +
        ` ・ ${((performance.now() - startedAll) / 1000 / 60).toFixed(1)} 分`,
    );
    console.log(`${SKILL_LIST_INDEX_NAME}: 版 ${version} ・ 置いてある版 ${next.generations.join(', ')}`);
    if (interrupted) console.log('※ 中断したので、残りのコースは測っていない。');
    const rest = everyCourse.length - next.courses.length;
    if (rest > 0) console.log(`※ まだ ${rest} コースが残っている。--list で何が残っているか出る。`);
  }
} finally {
  await pool.dispose();
}
