/**
 * 組み合わせ探索の実行と実測。
 *   pnpm optimize [--budget 600] [--style SEN] [--stamina 1000]
 *                 [--opponent -100|0|100] [--selfconsistent on]
 */
import { loadGameData } from '../../data/src/node.ts';
import { defaultFieldProfile } from '../../sim/src/field/field.ts';
import { nodeWorkerFactory } from '../../sim/src/parallel/node.ts';
import { WorkerPool } from '../../sim/src/parallel/pool.ts';
import { toSerializable } from '../../sim/src/parallel/protocol.ts';
import { defaultSystemSetting, type RaceSetting } from '../../sim/src/setting.ts';
import { createCostModel } from './cost.ts';
import { optimizeSkills, pairedDiff, Evaluator, type OptimizeContext } from './optimize.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : fallback;
}

const data = loadGameData();
const system = defaultSystemSetting();
const track = { location: 10006, course: 10606, condition: 1, gateCount: 9 } as const;
const budget = Number(arg('budget', '600'));
const stamina = Number(arg('stamina', '1000'));
const style = arg('style', 'SEN') as 'NIGE' | 'SEN' | 'SASI' | 'OI';
const useField = arg('field', 'on') !== 'off';
/** 自己整合。相手にも同じ構成を配って測り直す（docs/order-field.md 4.6 節）。 */
const selfConsistent = arg('selfconsistent', 'off') === 'on';
/** 相手の強さを上下させる。幅を見るときに振る（4.5 節）。 */
const opponentOffset = Number(arg('opponent', '0'));

// 順位条件を持つものと持たないものを混ぜる。
// 順位条件つきのスキルは、フィールドの有無で評価が変わるはずである。
const candidateNames = [
  '弧線のプロフェッサー', '円弧のマエストロ', '正攻法', '真骨頂', '順風満帆',
  '好転一息', 'コーナー加速○', 'コーナー回復○', '直線加速', '直線回復',
  '末脚', '先行のコツ○', '中距離コーナー○', '中距離直線○', '善後策',
  'スリップストリーム', '負けん気', '深呼吸', '一匹狼', '危険回避',
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
  track, skills: candidates,
  skillActivateAdjustment: 'NONE', randomPosition: 'RANDOM',
  debuffCounts: {}, positionKeepMode: 'APPROXIMATE', positionKeepRate: 100,
};

const pool = new WorkerPool(nodeWorkerFactory);
const cost = createCostModel(data.skillsById);
const context: OptimizeContext = {
  pool, system, cost, seed: 20260904,
  base: toSerializable({ ...setting, skills: [] }),
  field: useField
    ? {
        profile: { ...defaultFieldProfile(9), offset: opponentOffset },
        track,
        seed: 9001,
        samples: 64,
      }
    : null,
};
const name = (id: string) => data.skillsById.get(id)?.name ?? id;

console.log(`東京芝2400 / 脚質 ${style} / スタミナ ${stamina} / 予算 ${budget} pt / 順位条件 ${useField ? '判定する' : '無視'} / 相手 ${opponentOffset >= 0 ? '+' : ''}${opponentOffset} / 自己整合 ${selfConsistent ? 'あり' : 'なし'}`);
console.log(`候補 ${candidates.length} 個: ` + candidates.map((s) => `${s.name}(${s.sp})`).join(', '));
console.log('');

// 共通乱数の効きを測る
const evaluator = new Evaluator(context);
const a = await evaluator.evaluate([], 4000);
const b = await evaluator.evaluate([candidates[0]!.id], 4000);
const paired = pairedDiff(a, b);
const sd = (xs: Float64Array) => {
  const m = [...xs].reduce((x, y) => x + y, 0) / xs.length;
  return Math.sqrt([...xs].reduce((s, t) => s + (t - m) ** 2, 0) / (xs.length - 1));
};
const unpaired = Math.sqrt((sd(a.times) ** 2 + sd(b.times) ** 2) / a.times.length);
console.log(`共通乱数の効き（4000 試行、${candidates[0]!.name} を 1 つ足した差）:`);
console.log(`  ペアで取った差の標準誤差 ${paired.stdError.toFixed(5)} 秒`);
console.log(`  別々に平均した場合の標準誤差 ${unpaired.toFixed(5)} 秒`);
console.log(`  標準誤差の縮み ${(unpaired / paired.stdError).toFixed(2)} 倍（必要な試行数では ${((unpaired / paired.stdError) ** 2).toFixed(1)} 倍）`);
console.log(`  差が厳密に 0 だった試行 ${(100 * paired.zeroRate).toFixed(1)} %、最大スパートの成否が入れ替わった試行 ${paired.spurtFlips} 本`);
console.log('');

const result = await optimizeSkills(context, {
  candidates: candidates.map((s) => s.id),
  budget,
  selfConsistent,
  onProgress: (m) => console.log('  ' + m),
});

console.log('');
console.log('単体で足したときの効き（200 試行）:');
for (const single of result.singles) {
  console.log(
    `  ${name(single.skillId).padEnd(12, '　')} ${single.diff.mean.toFixed(4)} 秒 / ${single.cost} pt` +
      ` = ${(1000 * single.efficiency).toFixed(3)} ミリ秒/pt`,
  );
}
if (result.positionCompetition !== null) {
  const { averageCount, diff } = result.positionCompetition;
  console.log('');
  console.log('位置取り調整（買えないので候補には入れない）:');
  console.log(
    `  平均 ${averageCount.toFixed(2)} 回、調整が起きない場合との差 ` +
      `${diff.mean >= 0 ? '+' : ''}${diff.mean.toFixed(4)} 秒（誤差 ${(2 * diff.stdError).toFixed(4)}）`,
  );
  console.log('  正なら払えている。大きく負なら、スキルより先にスタミナか回復を足したほうがよい。');
}

console.log('');
console.log(`最良の構成（${result.cost} pt / 予算 ${budget} pt）:`);
for (const id of result.best) console.log(`  ${name(id)} (${cost.cost(id)} pt)`);
console.log(
  `  短縮 ${result.bestDiff.mean.toFixed(4)} 秒 ± ${(2 * result.bestDiff.stdError).toFixed(4)}` +
    `（最大スパート ${(100 * result.bestDiff.spurtRateDelta).toFixed(2)} ポイント、入れ替わり ${result.bestDiff.spurtFlips} 本）`,
);
console.log('');
console.log('上位の構成:');
for (const entry of result.top.slice(0, 6)) {
  console.log(
    `  ${entry.diff.mean.toFixed(4)} ± ${(2 * entry.diff.stdError).toFixed(4)} 秒 (${String(entry.cost).padStart(3)} pt) ` +
      entry.skillIds.map(name).join(', '),
  );
}
console.log('');
console.log(
  `レース ${result.races.toLocaleString()} 本、構成の評価 ${result.evaluations} 回、` +
    `${(result.elapsedMs / 1000).toFixed(1)} 秒、${result.rounds} 巡`,
);
await pool.dispose();
