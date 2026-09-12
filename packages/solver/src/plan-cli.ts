/**
 * 育成計画の時点での組み合わせ探索。
 *   pnpm plan [--chara 育成ウマ娘名] [--cards 名前,名前,...] [--budget 600] [--style SEN]
 *
 * 候補を手持ちのスキル表ではなく入手経路から組み立てる。
 * docs/solver-design.md 7 節を参照。
 */
import { loadDeckData } from '../../data/src/deck-node.ts';
import { loadGameData } from '../../data/src/node.ts';
import { defaultFieldProfile } from '../../sim/src/field/field.ts';
import { nodeWorkerFactory } from '../../sim/src/parallel/node.ts';
import { WorkerPool } from '../../sim/src/parallel/pool.ts';
import { toSerializable } from '../../sim/src/parallel/protocol.ts';
import {
  DerivedSetting,
  defaultSystemSetting,
  emptyPassiveBonus,
  type RaceSetting,
} from '../../sim/src/setting.ts';
import { buildPlanCandidates, type Route } from './candidates.ts';
import { createCostModel } from './cost.ts';
import { optimizeSkills, type OptimizeContext } from './optimize.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : fallback;
}

const data = loadGameData();
const deck = loadDeckData();
const system = defaultSystemSetting();
const track = { location: 10006, course: 10606, condition: 1, gateCount: 9 } as const;
const budget = Number(arg('budget', '600'));
const stamina = Number(arg('stamina', '1000'));
const style = arg('style', 'SEN') as 'NIGE' | 'SEN' | 'SASI' | 'OI';
const useField = arg('field', 'on') !== 'off';
const charaQuery = arg('chara', 'スペシャルウィーク');
const cardQuery = arg('cards', '');

const chara =
  deck.charas.find((c) => c.name === charaQuery) ??
  deck.charas.find((c) => c.name.includes(charaQuery) || c.charaName.includes(charaQuery));
if (chara === undefined) {
  console.error(`育成ウマ娘が見つからない: ${charaQuery}`);
  process.exit(1);
}

const cards = cardQuery
  .split(',')
  .map((q) => q.trim())
  .filter((q) => q.length > 0)
  .map((q) => {
    const card =
      deck.supports.find((c) => c.name === q) ??
      deck.supports.find((c) => c.name.includes(q) || c.chara.includes(q));
    if (card === undefined) console.error(`（サポートカードが見つからない: ${q}）`);
    return card;
  })
  .filter((card): card is NonNullable<typeof card> => card !== undefined);

const setting: RaceSetting = {
  uma: {
    charaName: chara.charaName, speed: 1200, stamina, power: 900, guts: 600, wisdom: 900,
    condition: 'BEST', style, distanceFit: 'A', surfaceFit: 'A', styleFit: 'A',
    popularity: 1, gateNumber: 5, uniqueLevel: 6,
  },
  track, skills: [],
  skillActivateAdjustment: 'NONE', randomPosition: 'RANDOM',
  debuffCounts: {}, positionKeepMode: 'APPROXIMATE', positionKeepRate: 100,
};

const derived = new DerivedSetting(setting, emptyPassiveBonus(), data.trackData);
const plan = buildPlanCandidates(data.skills, data.skillsByName, deck, derived, {
  charaId: chara.id,
  cards: cards.map((card) => ({ id: card.id })),
});

const routeLabel: Record<Route, string> = {
  chara: 'ウマ娘',
  hint: 'ヒント',
  inherit: '継承（白）',
  inheritedUnique: '継承（固有）',
};

console.log(`東京芝2400 / 脚質 ${style} / スタミナ ${stamina} / 予算 ${budget} pt / 順位条件 ${useField ? '判定する' : '無視'}`);
console.log(`育成ウマ娘 ${chara.name}`);
if (cards.length > 0) console.log(`デッキ ${cards.map((c) => c.name).join('、')}`);
console.log(
  '候補 ' +
    (['chara', 'hint', 'inherit', 'inheritedUnique'] as Route[])
      .map((route) => `${routeLabel[route]} ${plan.countByRoute[route]}`)
      .join(' / ') +
    ` = ${plan.skillIds.length} 個`,
);
console.log('');

const skillsById = data.skillsById;
const alwaysSkills = plan.alwaysSkillIds
  .map((id) => skillsById.get(id))
  .filter((skill): skill is NonNullable<typeof skill> => skill !== undefined);
if (alwaysSkills.length > 0) console.log(`固有 ${alwaysSkills.map((s) => s.name).join('、')}`);

const pool = new WorkerPool(nodeWorkerFactory);
const cost = createCostModel(skillsById, { hintLevels: plan.hintLevels });
const context: OptimizeContext = {
  pool, system, cost, seed: 20260911,
  base: toSerializable({ ...setting, skills: alwaysSkills }),
  field: useField ? { profile: defaultFieldProfile(9), track, seed: 9001, samples: 64 } : null,
};
const name = (id: string) => skillsById.get(id)?.name ?? id;

const result = await optimizeSkills(context, {
  candidates: plan.skillIds,
  budget,
  onProgress: (m) => console.log('  ' + m),
});

console.log('');
console.log('限界貢献度の上位（初期解に 1 つ足したときの短縮量）:');
for (const marginal of result.marginals.slice(0, 12)) {
  const entry = plan.entries.find((e) => e.skillId === marginal.skillId);
  const single = result.singles.find((s) => s.skillId === marginal.skillId);
  console.log(
    `  ${name(marginal.skillId).padEnd(12, '　')} ${marginal.diff.mean.toFixed(4)} 秒 / ${marginal.cost} pt` +
      ` = ${(1000 * marginal.efficiency).toFixed(3)} ミリ秒/pt` +
      (single === undefined ? '' : `（単体 ${single.diff.mean.toFixed(4)} 秒）`) +
      (entry === undefined ? '' : `  ${routeLabel[entry.route]}`),
  );
}

console.log('');
console.log(`最良の構成（${result.cost} pt / 予算 ${budget} pt）:`);
let inherited = 0;
for (const id of result.best) {
  const entry = plan.entries.find((e) => e.skillId === id);
  if (entry?.route === 'inheritedUnique') inherited++;
  console.log(`  ${name(id)} (${cost.cost(id)} pt, ${entry === undefined ? '?' : routeLabel[entry.route]})`);
}
console.log(`  固有の継承版 ${inherited} / 6`);
console.log(
  `  短縮 ${result.bestDiff.mean.toFixed(4)} 秒 ± ${(2 * result.bestDiff.stdError).toFixed(4)}`,
);
console.log('');
console.log(
  `レース ${result.races.toLocaleString()} 本、構成の評価 ${result.evaluations} 回、` +
    `${(result.elapsedMs / 1000).toFixed(1)} 秒、${result.rounds} 巡`,
);
await pool.dispose();
