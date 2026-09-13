/**
 * 単調性の検査を、いくつかの設定について走らせて表にする。
 *   pnpm monotonicity [--trials 200]
 */
import { loadGameData } from '../../data/src/node.ts';
import { buildFieldBundle, defaultFieldProfile } from '../../sim/src/field/field.ts';
import { opponentSkillPool } from '../../sim/src/field/opponent-skills.ts';
import { defaultSystemSetting, type RaceSetting, type UmaStatus } from '../../sim/src/setting.ts';
import { checkMonotonicity } from './monotonicity.ts';
import type { Goal } from './target.ts';

const data = loadGameData();
const system = defaultSystemSetting();

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : fallback;
}
const trials = Number(arg('trials', '200'));
/**
 * 順位条件を判定するか。既定は判定する（アプリの既定に合わせる）。
 *   pnpm monotonicity --field off
 *
 * 束は設定ごとに 1 つだけ作って使い回す。逆算と同じ前提である。
 * 判定を入れると、速くなった結果として順位が上がり、後ろ寄りの条件を外す経路ができる。
 * 反転が増えるならそれは二分探索を使えなくする要因なので、ここで見える必要がある。
 */
const useField = arg('field', 'on') !== 'off';

const baseUma: UmaStatus = {
  charaName: '',
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
};

function setting(patch: Partial<UmaStatus>, location: number, course: number): RaceSetting {
  return {
    uma: { ...baseUma, ...patch },
    track: { location, course, condition: 1, gateCount: 9 },
    skills: [],
    skillActivateAdjustment: 'NONE',
    randomPosition: 'RANDOM',
    debuffCounts: {},
    positionKeepMode: 'APPROXIMATE',
    positionKeepRate: 100,
  };
}

/** 設定ごとの束。コースと相手の想定が同じなら作り直さない。 */
const bundles = new Map<string, ReturnType<typeof buildFieldBundle>>();
function fieldFor(setting: RaceSetting) {
  if (!useField) return null;
  const { track } = setting;
  const key = `${track.location}/${track.course}/${track.gateCount}/${JSON.stringify(setting.uma)}`;
  let bundle = bundles.get(key);
  if (bundle === undefined) {
    bundle = buildFieldBundle(defaultFieldProfile(track.gateCount), track, system, data.trackData, {
      samples: 64,
      seed: 9001,
      self: setting.uma,
      skillPool: opponentSkillPool(data.skillsById),
      skillsById: data.skillsById,
    });
    bundles.set(key, bundle);
  }
  return bundle;
}

const profiles: { label: string; setting: RaceSetting }[] = [
  { label: '東京芝2400 先行', setting: setting({ style: 'SEN' }, 10006, 10606) },
  { label: '東京芝2400 逃げ', setting: setting({ style: 'NIGE' }, 10006, 10606) },
  { label: '東京芝2400 差し', setting: setting({ style: 'SASI' }, 10006, 10606) },
  { label: '東京芝2400 追込', setting: setting({ style: 'OI' }, 10006, 10606) },
  { label: '中山芝2500 先行', setting: setting({ style: 'SEN' }, 10005, 10511) },
  { label: '阪神芝1800外 先行', setting: setting({ style: 'SEN' }, 10009, 10904) },
  { label: '札幌芝1200 逃げ', setting: setting({ style: 'NIGE' }, 10001, 10101) },
  { label: '東京芝2400 賢さ低', setting: setting({ wisdom: 400 }, 10006, 10606) },
  { label: '東京芝2400 根性高', setting: setting({ guts: 1200 }, 10006, 10606) },
];

const goals: { label: string; goal: Goal }[] = [
  { label: '最大スパート', goal: { kind: 'maxSpurt' } },
  { label: '完走', goal: { kind: 'finish' } },
];

console.log(`スタミナを 200 から 1600 まで 10 刻みで動かし、${trials} 試行ずつ調べる`);
console.log(`順位条件: ${useField ? '判定する' : '無視する'}`);
console.log('');
console.log('| 設定 | 目標 | 反転を含む試行 | 反転の総数 | 反転の最大幅 | 常に達成 | 一度も達成せず |');
console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: |');

let totalTrials = 0;
let totalWithInversion = 0;
let widest = 0;
const started = performance.now();

for (const profile of profiles) {
  for (const { label: goalLabel, goal } of goals) {
    const report = checkMonotonicity(profile.setting, system, data.trackData, {
      status: 'stamina',
      goal,
      from: 200,
      to: 1600,
      step: 10,
      trials,
      seed: 20260904,
      field: fieldFor(profile.setting),
    });
    totalTrials += report.trials;
    totalWithInversion += report.trialsWithInversion;
    widest = Math.max(widest, report.widestInversion);
    console.log(
      `| ${profile.label} | ${goalLabel} | ${report.trialsWithInversion} | ${report.inversions} | ` +
        `${report.widestInversion} | ${report.alwaysAchieved} | ${report.neverAchieved} |`,
    );
  }
}

console.log('');
console.log(
  `合計 ${totalTrials} 試行のうち反転を含むのは ${totalWithInversion} 件` +
    `（${((totalWithInversion / totalTrials) * 100).toFixed(2)} パーセント）、反転の最大幅は ${widest}`,
);
console.log(`所要時間 ${((performance.now() - started) / 1000).toFixed(1)} 秒`);
