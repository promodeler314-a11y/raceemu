/**
 * 近似確率の感度分析。確率を半分と倍に振って、平均タイムとスキルごとの短縮量の幅を出す。
 *   pnpm sensitivity [--trials 600] [--style SEN] [--stamina 1000]
 *                    [--field on|off] [--scales 0.5,1,2] [--workers 3]
 *
 * docs/roadmap.md 3.7 節と docs/solver-design.md 4 節を参照。
 */
import { loadGameData } from '../../data/src/node.ts';
import { defaultFieldProfile } from '../../sim/src/field/field.ts';
import { nodeWorkerFactory } from '../../sim/src/parallel/node.ts';
import { WorkerPool } from '../../sim/src/parallel/pool.ts';
import { toSerializable } from '../../sim/src/parallel/protocol.ts';
import { defaultSystemSetting, type RaceSetting } from '../../sim/src/setting.ts';
import { createCostModel } from './cost.ts';
import type { OptimizeContext } from './optimize.ts';
import { dependsOnApproximate, measureSensitivity } from './sensitivity.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : fallback;
}

const data = loadGameData();
const system = defaultSystemSetting();
const track = { location: 10006, course: 10606, condition: 1, gateCount: 9 } as const;
const trials = Number(arg('trials', '600'));
const stamina = Number(arg('stamina', '1000'));
const style = arg('style', 'SEN') as 'NIGE' | 'SEN' | 'SASI' | 'OI';
const useField = arg('field', 'on') !== 'off';
const scales = arg('scales', '0.5,1,2')
  .split(',')
  .map((x) => Number(x.trim()))
  .filter((x) => Number.isFinite(x));

/**
 * 候補。近似条件を見るものと見ないものを混ぜる。
 *
 * 近似を見ないものは対照である。そちらまで幅が出るなら、幅は近似条件そのものではなく
 * 走りが変わったことの間接の影響（レーン移動や追い抜きモードが速度に効く）を拾っている。
 */
const candidateNames = [
  // 近似条件を見るもの（東京芝2400 で発動しうるものを選んである。
  // 短距離限定や逃げ限定のスキルは、近似を振っても一度も発動せず幅が 0 になる）
  '鋼の意志', 'どこ吹く風', 'ノンストップガール', '勝利への執念', 'アガッてきた！',
  '不屈の心', '神業ステップ', 'ウマ好み', 'スリップストリーム', '気炎万丈',
  // 対照（近似条件を見ない）
  '弧線のプロフェッサー', 'コーナー加速○', '直線加速', '末脚', '中距離コーナー○',
  '好転一息',
];
const candidates = candidateNames
  .map((name) => data.skillsByName.get(name)?.[0])
  .filter((s): s is NonNullable<typeof s> => s !== undefined);
const missing = candidateNames.filter((name) => data.skillsByName.get(name) === undefined);
if (missing.length > 0) console.log(`（見つからなかった候補: ${missing.join(', ')}）`);

const setting: RaceSetting = {
  uma: {
    charaName: '', speed: 1200, stamina, power: 900, guts: 600, wisdom: 900,
    condition: 'BEST', style, distanceFit: 'A', surfaceFit: 'A', styleFit: 'A',
    popularity: 1, gateNumber: 5, uniqueLevel: 6,
  },
  track, skills: [],
  skillActivateAdjustment: 'NONE', randomPosition: 'RANDOM',
  debuffCounts: {}, positionKeepMode: 'APPROXIMATE', positionKeepRate: 100,
};

/** 並列数。省くと Worker の既定（コア数 − 1）に任せる。 */
const workers = arg('workers', '');
const pool = new WorkerPool(nodeWorkerFactory, workers === '' ? undefined : Number(workers));
const context: OptimizeContext = {
  pool,
  system,
  cost: createCostModel(data.skillsById),
  seed: 20260904,
  base: toSerializable(setting),
  field: useField ? { profile: defaultFieldProfile(9), track, seed: 9001, samples: 64 } : null,
};
const name = (id: string) => data.skillsById.get(id)?.name ?? id;

console.log(
  `東京芝2400 / 脚質 ${style} / スタミナ ${stamina} / 順位条件 ${useField ? '判定する' : '無視'} / ` +
    `倍率 ${scales.join(', ')} / ${trials} 試行`,
);
console.log(
  `候補 ${candidates.length} 個（近似条件を見るもの ` +
    `${candidates.filter(dependsOnApproximate).length} 個）`,
);
console.log('');

const result = await measureSensitivity(context, {
  candidates: candidates.map((s) => s.id),
  trials,
  scales,
  skillsById: data.skillsById,
  onProgress: (m) => console.log('  ' + m),
});

console.log('');
console.log('近似確率を振ったときの平均タイム（候補を 1 つも取らない構成）:');
console.log('| 倍率 | 平均タイム | 既定との差 | 最大スパート率 |');
console.log('| ---: | ---: | ---: | ---: |');
for (const summary of result.scales) {
  console.log(
    `| ${summary.scale.toFixed(2)} | ${summary.meanTime.toFixed(4)} 秒 | ` +
      `${summary.shift.mean >= 0 ? '+' : ''}${summary.shift.mean.toFixed(4)} ± ` +
      `${(2 * summary.shift.stdError).toFixed(4)} 秒 | ` +
      `${(100 * summary.maxSpurtRate).toFixed(1)} % |`,
  );
}
const times = result.scales.map((s) => s.meanTime);
console.log('');
console.log(
  `平均タイムの幅は ${(Math.max(...times) - Math.min(...times)).toFixed(4)} 秒。` +
    'これが「近似の置き方だけで動く量」である。',
);

console.log('');
console.log('スキルごとの短縮量（幅の広い順）:');
const header = ['| スキル | 近似 |', ...result.scales.map((s) => ` 倍率 ${s.scale.toFixed(2)} |`)];
console.log(header.join('') + ' 幅 | 幅 ÷ 誤差 |');
console.log('| --- | :-: |' + result.scales.map(() => ' ---: |').join('') + ' ---: | ---: |');
const sorted = [...result.skills].sort((a, b) => b.width - a.width);
for (const entry of sorted) {
  const cells = entry.byScale.map((x) => ` ${x.diff.mean.toFixed(4)} |`).join('');
  console.log(
    `| ${name(entry.skillId)} | ${entry.approximate ? '○' : '−'} |${cells}` +
      ` ${entry.width.toFixed(4)} | ${entry.widthPerError.toFixed(2)} |`,
  );
}

console.log('');
console.log(
  '幅 ÷ 誤差が 1 を超えるスキルは、短縮量が試行の揺れではなく近似の置き方で動いている。',
);
console.log('その差は近似の中に消えるものとして読む。');
console.log('');
console.log(
  `レース ${result.races.toLocaleString()} 本、${(result.elapsedMs / 1000).toFixed(1)} 秒`,
);
await pool.dispose();
