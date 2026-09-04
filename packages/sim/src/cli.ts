/**
 * 動作確認用のコマンドライン。
 *   node --experimental-strip-types packages/sim/src/cli.ts [--count 1000] [--course 10101]
 */
import { loadGameData } from '../../data/src/index.ts';
import { defaultSystemSetting, type RaceSetting } from './setting.ts';
import { runSimulations } from './summary.ts';
import { unsupportedConditions } from './skill/condition.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : fallback;
}

const data = loadGameData();
const location = Number(arg('location', '10006'));
const course = Number(arg('course', '10606'));
const count = Number(arg('count', '1000'));
const skillNames = arg('skills', '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

const skills = skillNames.flatMap((name) => {
  const found = data.skillsByName.get(name);
  if (found === undefined) {
    console.error(`スキルが見つからない: ${name}`);
    return [];
  }
  return [found[0]!];
});

const setting: RaceSetting = {
  uma: {
    charaName: 'テスト',
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
  track: { location, course, condition: 1, gateCount: 9 },
  skills,
  skillActivateAdjustment: 'NONE',
  randomPosition: 'RANDOM',
  debuffCounts: {},
  positionKeepMode: 'APPROXIMATE',
  positionKeepRate: 100,
};

const trackDetail = data.trackData[location]!.courses[course]!;
const { summary } = runSimulations(setting, defaultSystemSetting(), data.trackData, { count, seed: 1 });

console.log(`コース: ${data.trackData[location]!.name} ${trackDetail.name}`);
console.log(`基準タイム: ${trackDetail.finishTimeMin} - ${trackDetail.finishTimeMax} 秒`);
console.log(`所持スキル: ${skills.length === 0 ? 'なし' : skills.map((s) => s.name).join(', ')}`);
console.log('');
console.log(`試行回数: ${summary.all.count}`);
console.log(`平均タイム: ${summary.all.averageTime.toFixed(3)} 秒`);
console.log(`最速タイム: ${summary.all.bestTime.toFixed(3)} 秒`);
console.log(`最遅タイム: ${summary.all.worstTime.toFixed(3)} 秒`);
console.log(`最大スパート率: ${(summary.spurtRate * 100).toFixed(1)} %`);
console.log(`完走率: ${(summary.finishRate * 100).toFixed(1)} %`);
console.log(`平均残り体力: ${summary.all.averageGoalSp.toFixed(1)}`);
console.log('');
console.log(
  `所要時間: ${summary.elapsedMs.toFixed(0)} ms (1試行あたり ${(summary.elapsedMs / count).toFixed(3)} ms)`,
);
if (unsupportedConditions.size > 0) {
  console.log(`未対応の条件: ${[...unsupportedConditions].join(', ')}`);
}
