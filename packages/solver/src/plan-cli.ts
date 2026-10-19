/**
 * 育成計画の時点での組み合わせ探索。
 *   pnpm plan [--chara 育成ウマ娘名] [--cards 名前,名前,...] [--budget 600] [--style SEN]
 *             [--season 1] [--weather 1] [--time 1]
 *             [--opponent -100|0|100] [--selfconsistent on]
 *             [--location 10006] [--course 10606]
 *             [--inherit "名前,名前,..."] [--inherit-hint 0]
 *             [--opponents roster] [--sp-budget N] [--unique-level N] [--roster-file PATH]
 *
 * 季節と天候と時刻は 0 で指定なしになり、本家と同じく条件が無視される。
 *
 * 候補を手持ちのスキル表ではなく入手経路から組み立てる。
 * docs/solver-design.md 7 節を参照。
 *
 * `--inherit` は家系で決まった継承固有。取るかどうかを選べないので候補から外して必須で渡し、
 * その費用を `--budget` から先に払う（払い忘れると、買えない構成を推す）。進化させるものは
 * 名前のあとに `:進化` を付ける（`inherit-names.ts`）。
 *
 * `--opponents roster` は相手を実在の育成ウマ娘から組む（docs/order-field.md 4.7 節）。
 * 順位条件を判定するとき（`--field off` でないとき）に効き、順位表の無いコースでは典型スキルの
 * 相手に落とす。理由は標準エラーに出る。
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
import { createCostModel, dedupeByGroup } from './cost.ts';
import { inheritSettingsFromArgv, resolveInheritedNames } from './inherit-names.ts';
import { DEFAULT_INHERITED_UNIQUE_LIMIT, optimizeSkills, type OptimizeContext } from './optimize.ts';
import {
  rosterOpponentsLine,
  rosterSettingsFromArgv,
  searchFieldSpec,
  type RosterCliSettings,
} from './opponent-roster-setup.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : fallback;
}

const data = loadGameData();
const deck = loadDeckData();
const system = defaultSystemSetting();
const season = Number(arg('season', '1'));
const weather = Number(arg('weather', '1'));
const time = Number(arg('time', '1'));
const track = {
  location: Number(arg('location', '10006')),
  course: Number(arg('course', '10606')),
  condition: 1,
  gateCount: 9,
  season: season || undefined,
  weather: weather || undefined,
  time: time || undefined,
} as const;
const budget = Number(arg('budget', '600'));
const stamina = Number(arg('stamina', '1000'));
const style = arg('style', 'SEN') as 'NIGE' | 'SEN' | 'SASI' | 'OI';
const useField = arg('field', 'on') !== 'off';
/** 自己整合。相手にも同じ構成を配って測り直す（docs/order-field.md 4.6 節）。 */
const selfConsistent = arg('selfconsistent', 'off') === 'on';
/** 相手の強さを上下させる。幅を見るときに振る（4.5 節）。 */
const opponentOffset = Number(arg('opponent', '0'));
const charaQuery = arg('chara', 'スペシャルウィーク');
const cardQuery = arg('cards', '');

const trackLocation = data.trackData[track.location];
const trackCourse = trackLocation?.courses[track.course];
if (trackLocation === undefined || trackCourse === undefined) {
  console.error(`コースが見つからない: --location ${track.location} --course ${track.course}`);
  process.exit(1);
}
/** 既定のコースは今までの見出しのまま。 */
const trackLabel =
  track.location === 10006 && track.course === 10606 ? '東京芝2400' : `${trackLocation.name} ${trackCourse.name}`;

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
const plan = buildPlanCandidates(
  data.skills,
  data.skillsByName,
  deck,
  derived,
  { charaId: chara.id, cards: cards.map((card) => ({ id: card.id })) },
  { includeIgnoredOnly: arg('ignored', 'off') === 'on' },
);

const skillsById = data.skillsById;
const name = (id: string) => skillsById.get(id)?.name ?? id;

// 家系で決まった継承固有。育成の前に決まっていて、取るかどうかを探索が選ぶものではないので、
// 候補から外して必須（`OptimizeOptions.required`）で渡す。その SP は `--budget` から先に払う。
// 払い忘れると、買えない構成を推すことになる。
let inheritPicks: ReturnType<typeof resolveInheritedNames>;
let inheritHint: number;
try {
  const inherit = inheritSettingsFromArgv(process.argv);
  inheritHint = inherit.hint;
  inheritPicks = resolveInheritedNames(data.skills, inherit.names);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
const hintLevels: Record<string, number> = { ...plan.hintLevels };
if (inheritHint > 0) for (const pick of inheritPicks) hintLevels[pick.skillId] = inheritHint;
const cost = createCostModel(skillsById, { hintLevels });
// 同じグループは上位の 1 つに絞る（探索も同じ絞り方をする）。
const required = dedupeByGroup(
  inheritPicks.map((pick) => pick.skillId),
  cost,
);
const requiredCost = cost.totalCost(required);
/** 継承進化は名前が継承版と同じなので、見分けのために印を付ける。 */
const requiredLabel = (id: string) =>
  name(id) + (inheritPicks.find((pick) => pick.skillId === id)?.evolved === true ? '（進化）' : '');
if (required.length > DEFAULT_INHERITED_UNIQUE_LIMIT) {
  console.error(`継承固有は ${DEFAULT_INHERITED_UNIQUE_LIMIT} つまで（${required.length} 個が指定された）`);
  process.exit(1);
}
if (requiredCost > budget) {
  console.error(`継承固有の費用（${requiredCost} pt）が予算（${budget} pt）を超えている`);
  process.exit(1);
}
const requiredGroups = new Set(required.map((id) => cost.group(id)));
const candidateIds =
  required.length === 0 ? plan.skillIds : plan.skillIds.filter((id) => !requiredGroups.has(cost.group(id)));
const candidateIdSet = new Set(candidateIds);

// 名簿の相手の SP 予算は、省いたら自分が白・金・緑に使える SP に揃える。
// 相手の強さは SP の予算に敏感で、自分と食い違えば比べる意味が薄れる。相手の束は基準の設定から
// 1 度だけ作り、全候補で使い回す（束の鍵に自分の持ち物は入らない）ので、探索の途中で
// 自分が何を取ったかからは決められない。走らせる前に決まる `--budget` を使う。
// 家系の継承固有は白・金・緑ではない（相手の予算に数えない）ので、その費用は引く。
// 探索が選ぶ継承固有と、ヒントの割引は見込まない。目安である。
let rosterSettings: RosterCliSettings;
try {
  rosterSettings = rosterSettingsFromArgv(process.argv, { spBudget: budget - requiredCost });
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
const field = searchFieldSpec({
  settings: rosterSettings,
  data,
  useField,
  profile: { ...defaultFieldProfile(9), offset: opponentOffset },
  track,
  seed: 9001,
  samples: 64,
});

const routeLabel: Record<Route, string> = {
  chara: 'ウマ娘',
  hint: 'ヒント',
  inherit: '継承（白）',
  inheritedUnique: '継承（固有）',
  any: '経路不問',
};

const label = (value: number, names: readonly string[]) => (value ? (names[value - 1] ?? String(value)) : '指定なし');
console.log(`${trackLabel} / 脚質 ${style} / スタミナ ${stamina} / 予算 ${budget} pt / 順位条件 ${useField ? '判定する' : '無視'} / 相手 ${opponentOffset >= 0 ? '+' : ''}${opponentOffset} / 自己整合 ${selfConsistent ? 'あり' : 'なし'}`);
console.log(
  `季節 ${label(season, ['春', '夏', '秋', '冬'])} / 天候 ${label(weather, ['晴', '曇', '雨', '雪'])} / ` +
    `時刻 ${time === 4 ? 'ナイター' : label(time, ['昼'])}`,
);
console.log(`育成ウマ娘 ${chara.name}`);
if (cards.length > 0) console.log(`デッキ ${cards.map((c) => c.name).join('、')}`);
if (required.length > 0) {
  console.log(
    `家系の継承固有 ${required.length} 個（${requiredCost} pt を予算から先に払う。残り ${budget - requiredCost} pt）: ` +
      required.map(requiredLabel).join('、') +
      (inheritHint > 0 ? ` / ヒント Lv${inheritHint}` : ''),
  );
}
if (field?.roster !== undefined) console.log(rosterOpponentsLine(rosterSettings));
// 継承固有を必須にしたぶん、候補から外れた数を経路の内訳からも引く
const countByRoute =
  required.length === 0
    ? plan.countByRoute
    : plan.entries.reduce(
        (counts, entry) => (candidateIdSet.has(entry.skillId) ? { ...counts, [entry.route]: counts[entry.route] + 1 } : counts),
        { chara: 0, hint: 0, inherit: 0, inheritedUnique: 0, any: 0 } as Record<Route, number>,
      );
console.log(
  '候補 ' +
    (['chara', 'hint', 'inherit', 'inheritedUnique'] as Route[])
      .map((route) => `${routeLabel[route]} ${countByRoute[route]}`)
      .join(' / ') +
    ` = ${candidateIds.length} 個`,
);
if (plan.droppedByIgnored.length > 0) {
  console.log(
    `判定できない条件しか持たないため外した ${plan.droppedByIgnored.length} 個: ` +
      plan.droppedByIgnored.map((id) => data.skillsById.get(id)?.name ?? id).join('、'),
  );
}
console.log('');

const alwaysSkills = plan.alwaysSkillIds
  .map((id) => skillsById.get(id))
  .filter((skill): skill is NonNullable<typeof skill> => skill !== undefined);
if (alwaysSkills.length > 0) console.log(`固有 ${alwaysSkills.map((s) => s.name).join('、')}`);

const pool = new WorkerPool(nodeWorkerFactory);
const context: OptimizeContext = {
  pool, system, cost, seed: 20260911,
  base: toSerializable({ ...setting, skills: alwaysSkills }),
  field,
};

const result = await optimizeSkills(context, {
  candidates: candidateIds,
  budget,
  selfConsistent,
  // 指定が無いときは渡さない（以前と同じ呼び出しにする）
  ...(required.length > 0 ? { required } : {}),
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
// 必須の費用は予算に先に数えてあり、`result.cost` は候補から選んだぶんだけである。
console.log(`最良の構成（${result.cost + result.requiredCost} pt / 予算 ${budget} pt）:`);
for (const id of result.required) console.log(`  ${requiredLabel(id)} (${cost.cost(id)} pt, 家系の継承固有)`);
let inherited = result.required.length;
for (const id of result.best) {
  const entry = plan.entries.find((e) => e.skillId === id);
  if (entry?.route === 'inheritedUnique') inherited++;
  console.log(`  ${name(id)} (${cost.cost(id)} pt, ${entry === undefined ? '?' : routeLabel[entry.route]})`);
}
console.log(`  固有の継承版 ${inherited} / ${DEFAULT_INHERITED_UNIQUE_LIMIT}`);
console.log(
  `  短縮 ${result.bestDiff.mean.toFixed(4)} 秒 ± ${(2 * result.bestDiff.stdError).toFixed(4)}`,
);
if (result.requiredDiff !== null) {
  console.log(
    `  （上の短縮は家系の継承固有を持った構成から見た値。継承固有を足したぶんは ` +
      `${result.requiredDiff.mean.toFixed(4)} 秒 ± ${(2 * result.requiredDiff.stdError).toFixed(4)}）`,
  );
}
console.log('');
console.log(
  `レース ${result.races.toLocaleString()} 本、構成の評価 ${result.evaluations} 回、` +
    `${(result.elapsedMs / 1000).toFixed(1)} 秒、${result.rounds} 巡`,
);
await pool.dispose();
