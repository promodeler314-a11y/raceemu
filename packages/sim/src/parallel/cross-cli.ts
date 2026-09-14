/**
 * コース横断の評価の実測。
 *   pnpm cross --surface 1 --distance 2000 --count 2000
 *   pnpm cross --surface 1 --category MIDDLE --count 500 --field
 */
import { availableParallelism } from 'node:os';
import { loadGameData } from '../../../data/src/node.ts';
import type { Distance } from '../data/constants.ts';
import { courseDistances, matchCourses } from '../data/track.ts';
import { defaultFieldProfile } from '../field/field.ts';
import { defaultSystemSetting, type RaceSetting } from '../setting.ts';
import { runCrossCourse } from './cross.ts';
import { nodeWorkerFactory } from './node.ts';
import { WorkerPool } from './pool.ts';
import { toSerializable } from './protocol.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const data = loadGameData();
const surface = Number(arg('surface', '1'));
const distanceArg = arg('distance', '');
const categoryArg = arg('category', '');
const count = Number(arg('count', '2000'));
const gateCount = Number(arg('gate', '9'));
const useField = flag('field');
const samples = Number(arg('samples', '64'));

if (distanceArg === '' && categoryArg === '') {
  console.error(
    `--distance か --category のどちらかを指定する。` +
      `この面の距離: ${courseDistances(data.trackData, surface).join(', ')}`,
  );
  process.exit(1);
}

const courses = matchCourses(data.trackData, {
  surface,
  distance: distanceArg === '' ? undefined : Number(distanceArg),
  distanceCategory: categoryArg === '' ? undefined : (categoryArg as Distance),
});

const setting: RaceSetting = {
  uma: {
    charaName: 'コース横断',
    speed: 1200,
    stamina: 1000,
    power: 900,
    guts: 600,
    wisdom: 900,
    condition: 'BEST',
    style: 'SEN',
    distanceFit: 'A',
    surfaceFit: 'A',
    styleFit: 'A',
    popularity: 1,
    gateNumber: 0,
    uniqueLevel: 6,
  },
  // コースは走らせるたびに差し替わる。ここに入れた値は使われない。
  track: { location: 10006, course: 10606, condition: 1, gateCount, season: 1, weather: 1, time: 1 },
  skills: [],
  skillActivateAdjustment: 'NONE',
  randomPosition: 'RANDOM',
  debuffCounts: {},
  positionKeepMode: 'APPROXIMATE',
  positionKeepRate: 100,
};

const system = defaultSystemSetting();
console.log(
  `${surface === 1 ? '芝' : 'ダート'} ` +
    `${distanceArg === '' ? categoryArg : `${distanceArg}m`}: ${courses.length} コース`,
);
console.log(`試行回数: ${count} / コース ・ 順位条件: ${useField ? 'あり' : 'なし'}`);
console.log(`利用可能な並列数: ${availableParallelism()}（Worker ${nodeWorkerFactory.defaultConcurrency} 本）`);
console.log('');

const pool = new WorkerPool(nodeWorkerFactory);
const started = performance.now();
try {
  const { rows } = await runCrossCourse(pool, toSerializable(setting), system, courses, {
    count,
    seed: 1,
    field: useField
      ? { profile: defaultFieldProfile(gateCount), seed: 9001, samples }
      : null,
    onCourse: (done, total, row) => {
      console.log(
        `${String(done).padStart(2)}/${total} ${row.locationName} ${row.courseName}` +
          ` 平均 ${row.summary.all.averageTime.toFixed(3)} 秒` +
          ` ・ 最大スパート ${(row.summary.spurtRate * 100).toFixed(1)} %` +
          ` ・ 完走 ${(row.summary.finishRate * 100).toFixed(1)} %` +
          ` ・ ${(row.summary.elapsedMs / 1000).toFixed(2)} 秒`,
      );
    },
  });
  const elapsed = performance.now() - started;
  console.log('');
  console.log(
    `合計 ${(elapsed / 1000).toFixed(2)} 秒` +
      `（1 コースあたり ${(elapsed / Math.max(1, rows.length) / 1000).toFixed(2)} 秒、` +
      `1 試行あたり ${(elapsed / Math.max(1, rows.length * count)).toFixed(3)} ms）`,
  );
  // Worker はスレッドなので、束のぶんも同じプロセスの RSS に乗る。
  // コースごとに束を作り直すため、ここが伸びすぎないかを見る。
  const memory = process.memoryUsage();
  console.log(
    `メモリ: ヒープ ${(memory.heapUsed / 1024 / 1024).toFixed(0)} MB ・ ` +
      `RSS ${(memory.rss / 1024 / 1024).toFixed(0)} MB`,
  );
} finally {
  await pool.dispose();
}
