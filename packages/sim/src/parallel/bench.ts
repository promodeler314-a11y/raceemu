/**
 * 並列実行の実測。
 *   pnpm bench --count 10000 --course 10606
 */
import { availableParallelism } from 'node:os';
import { loadGameData } from '../../../data/src/node.ts';
import { defaultSystemSetting, type RaceSetting } from '../setting.ts';
import { runSimulations, toSummaryEntry } from '../summary.ts';
import { nodeWorkerFactory } from './node.ts';
import { WorkerPool } from './pool.ts';
import { toSerializable } from './protocol.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : fallback;
}

const data = loadGameData();
const location = Number(arg('location', '10006'));
const course = Number(arg('course', '10606'));
const count = Number(arg('count', '10000'));

const setting: RaceSetting = {
  uma: {
    charaName: 'ベンチ',
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
    gateNumber: 5,
    uniqueLevel: 6,
  },
  track: { location, course, condition: 1, gateCount: 9 },
  skills: [],
  skillActivateAdjustment: 'NONE',
  randomPosition: 'RANDOM',
  debuffCounts: {},
  positionKeepMode: 'APPROXIMATE',
  positionKeepRate: 100,
};

const system = defaultSystemSetting();
const trackDetail = data.trackData[location]!.courses[course]!;
console.log(`コース: ${data.trackData[location]!.name} ${trackDetail.name} (${trackDetail.distance} m)`);
console.log(`試行回数: ${count}`);
console.log(`利用可能な並列数: ${availableParallelism()}`);
console.log('');

const single = runSimulations(setting, system, data.trackData, { count, seed: 1 });
console.log(
  `単一スレッド: ${(single.summary.elapsedMs / 1000).toFixed(2)} 秒 ` +
    `(1試行 ${(single.summary.elapsedMs / count).toFixed(3)} ms) 平均 ${single.summary.all.averageTime.toFixed(3)} 秒`,
);

const serializable = toSerializable(setting);
const levels = [...new Set([2, 4, nodeWorkerFactory.defaultConcurrency])].sort((a, b) => a - b);
for (const concurrency of levels) {
  const pool = new WorkerPool(nodeWorkerFactory, concurrency);
  try {
    const coldStart = performance.now();
    const first = await pool.run(serializable, system, { count, seed: 1 });
    const cold = performance.now() - coldStart;

    const warmStart = performance.now();
    const second = await pool.run(serializable, system, { count, seed: 1 });
    const warm = performance.now() - warmStart;

    const summary = toSummaryEntry(first);
    const same = toSummaryEntry(second).averageTime === summary.averageTime;
    console.log(
      `${String(concurrency).padStart(2)} 並列: ` +
        `初回 ${(cold / 1000).toFixed(2)} 秒 (${(single.summary.elapsedMs / cold).toFixed(2)} 倍) / ` +
        `2回目 ${(warm / 1000).toFixed(2)} 秒 (${(single.summary.elapsedMs / warm).toFixed(2)} 倍) ` +
        `平均 ${summary.averageTime.toFixed(3)} 秒${same ? '' : ' [!] 結果が一致しない'}`,
    );
  } finally {
    await pool.dispose();
  }
}
