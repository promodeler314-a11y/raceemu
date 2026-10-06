/**
 * 全頭同時に走らせたときの挙動の実測。
 *   pnpm run multi [--trials 500] [--location 10006] [--course 10606]
 *   pnpm run multi --trials 30 --opponents roster --location 10008 --course 10808
 *
 * `--opponents roster` は 2 と 4 の相手を、実在のカードから組んだものに替える
 * （docs/order-field.md 4.7 節）。試行ごとに相手を組み直す。相手は試行番号だけで決まるので、
 * 4 のようにスキルを足す前後を比べるときも同じ相手になる。
 * ほかに `--sp-budget`、`--unique-level`、`--roster-file`。1 と 3 は相手を使わない。
 */
import { loadGameData } from '../../../data/src/node.ts';
import {
  prepareRoster,
  ROSTER_FALLBACK_NOTE,
  rosterFieldProfile,
  rosterSettingsFromArgv,
  type RosterCliSettings,
} from '../../../solver/src/opponent-roster-setup.ts';
import { RaceCalculator } from '../calculator.ts';
import { defaultFieldProfile, opponentSettings, type FieldProfile } from '../field/field.ts';
import { opponentSkillPool } from '../field/opponent-skills.ts';
import { defaultSystemSetting, type RaceSetting } from '../setting.ts';
import type { Style } from '../data/constants.ts';
import { runMultiRace, type MultiEntry } from './race.ts';
import { OrderTally } from './summary.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : fallback;
}

let rosterSettings: RosterCliSettings;
try {
  rosterSettings = rosterSettingsFromArgv(process.argv);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const data = loadGameData();
const system = defaultSystemSetting();
const calculator = new RaceCalculator(system, data.trackData);
const track = {
  location: Number(arg('location', '10006')),
  course: Number(arg('course', '10606')),
  condition: 1,
  gateCount: 9,
} as const;
const trials = Number(arg('trials', '500'));
const styles: Style[] = ['NIGE', 'SEN', 'SASI', 'OI'];
const styleLabel: Record<string, string> = { NIGE: '逃げ', SEN: '先行', SASI: '差し', OI: '追込' };

const base = (style: Style, patch: Partial<RaceSetting['uma']> = {}): RaceSetting => ({
  uma: {
    charaName: '', speed: 1200, stamina: 1000, power: 900, guts: 600, wisdom: 900,
    condition: 'BEST', style, distanceFit: 'A', surfaceFit: 'A', styleFit: 'A',
    popularity: 1, gateNumber: 0, uniqueLevel: 6, ...patch,
  },
  track, skills: [],
  skillActivateAdjustment: 'NONE', randomPosition: 'RANDOM',
  debuffCounts: {}, positionKeepMode: 'VIRTUAL', positionKeepRate: 100,
});

const pct = (x: number) => `${(100 * x).toFixed(1)} %`;

/** 名簿の相手は、そのコースの順位表と名簿が作れたときだけ使う。作れなければ典型スキルで回す。 */
const prepared =
  rosterSettings.model === 'roster'
    ? prepareRoster(data, rosterSettings, track)
    : { roster: null, notes: [] };
for (const note of prepared.notes) console.error(note);
if (rosterSettings.model === 'roster' && prepared.roster === null) console.error(ROSTER_FALLBACK_NOTE);
const useRoster = rosterSettings.model === 'roster' && prepared.roster !== null;
const skillPool = opponentSkillPool(data.skillsById);

/**
 * 試行番号から相手 8 頭を返す口。
 *
 * 名簿のときは試行ごとに組み直す。`self` を渡すと自分と同格の強さになる
 * （渡さなければ `profile.uma` が基準）。相手は試行番号だけで決まる。
 * 典型のときは今までどおり、引き直さない固定の相手を 1 度だけ作って使い回す。
 */
function opponentsFor(profile: FieldProfile, self?: RaceSetting['uma']): (trial: number) => MultiEntry[] {
  if (!useRoster) {
    const fixed: MultiEntry[] = opponentSettings(profile, track).map((setting) => ({ setting }));
    return () => fixed;
  }
  const withRoster = rosterFieldProfile(profile, rosterSettings, prepared.roster);
  return (trial) =>
    opponentSettings(withRoster, track, {
      sample: trial,
      roster: prepared.roster,
      skillsById: data.skillsById,
      trackData: data.trackData,
      skillPool,
      self: self ?? null,
    }).map((setting) => ({ setting }));
}

// 名簿のときは、引いた相手の例を先に出す。強さは自分（先行 1200-1000-900-600-900）に揃える。
if (useRoster) {
  const example = opponentsFor(defaultFieldProfile(9), base('SEN').uma)(0);
  console.log('名簿の相手の例（試行 0、強さは自分に揃えてある）');
  console.log('');
  console.log('| 枠 | キャラ | 脚質 | スキル数 | 固有 Lv |');
  console.log('| --- | --- | --- | ---: | ---: |');
  example.forEach(({ setting }, slot) => {
    const uma = setting.uma;
    console.log(
      `| ${slot + 1} | ${uma.charaName === '' ? '（典型スキル）' : uma.charaName} | ${styleLabel[uma.style]}` +
        ` | ${setting.skills.length} | ${uma.uniqueLevel} |`,
    );
  });
  console.log('');
}

// 1. 全頭同じステータスで、脚質だけを変える。
// M6 の 4 節と同じ問いに答える表になる。
{
  const lineup: Style[] = ['NIGE', 'NIGE', 'SEN', 'SEN', 'SEN', 'SASI', 'SASI', 'OI', 'OI'];
  const entries: MultiEntry[] = lineup.map((style) => ({ setting: base(style) }));
  const tally = new OrderTally(entries.length);
  const started = performance.now();
  for (let t = 0; t < trials; t++) tally.add(runMultiRace(calculator, entries, { seed: 4649, trial: t }));
  const elapsed = performance.now() - started;

  const detail = data.trackData[track.location]?.courses[track.course];
  console.log(
    `${data.trackData[track.location]?.name ?? track.location} ${detail?.name ?? track.course}` +
      ` / 9 頭 / 全頭 1200-1000-900-600-900 / ${trials} 試行`,
  );
  console.log('');
  console.log('| 出走 | 脚質 | 1 着 | 2 着 | 3 着 | 4 着 | 5 着以下 | 平均着順 | 平均タイム |');
  console.log('| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const s of tally.summarizeAll()) {
    const at = (order: number) => pct(s.counts[order]! / s.trials);
    let rest = 0;
    for (let order = 5; order <= entries.length; order++) rest += s.counts[order]!;
    console.log(
      `| ${s.index} | ${styleLabel[lineup[s.index]!]} | ${at(1)} | ${at(2)} | ${at(3)} | ${at(4)}` +
        ` | ${pct(rest / s.trials)} | ${s.meanOrder.toFixed(2)} | ${s.meanTime.toFixed(3)} |`,
    );
  }
  console.log('');
  console.log(`1 試行あたり ${(elapsed / trials).toFixed(1)} ms`);
  console.log('');
}

// 2. 相手を強くすると勝率が下がるか。
{
  console.log('相手のスピードを動かしたときの、自分（先行 1200-1000）の成績');
  console.log('');
  console.log('| 相手のスピード | 勝率 | 連対率 | 複勝率 | 平均着順 |');
  console.log('| --- | ---: | ---: | ---: | ---: |');
  for (const speed of [900, 1000, 1100, 1200, 1300, 1400]) {
    const profile = defaultFieldProfile(9);
    // スピードを振る表なので、名簿のときも self は渡さない（渡すと自分に揃って振れなくなる）。
    const lineupAt = opponentsFor({ ...profile, uma: { ...profile.uma, speed } });
    const tally = new OrderTally(track.gateCount);
    for (let t = 0; t < trials; t++) {
      const entries: MultiEntry[] = [{ setting: base('SEN') }, ...lineupAt(t)];
      tally.add(runMultiRace(calculator, entries, { seed: 4649, trial: t }));
    }
    const me = tally.summarize(0);
    console.log(
      `| ${speed} | ${pct(me.winRate)} | ${pct(me.quinellaRate)} | ${pct(me.showRate)} | ${me.meanOrder.toFixed(2)} |`,
    );
  }
  console.log('');
}

// 3. 位置取りが働いているか。脚質ごとに、途中の順位と入った位置取りを見る。
{
  const lineup: Style[] = ['NIGE', 'NIGE', 'SEN', 'SEN', 'SEN', 'SASI', 'SASI', 'OI', 'OI'];
  const entries: MultiEntry[] = lineup.map((style) => ({ setting: base(style) }));
  const races = Math.min(100, trials);
  const orderSum = lineup.map(() => 0);
  let samples = 0;
  const keep = lineup.map(() => ({}) as Record<string, number>);
  const prev = lineup.map(() => 'NONE');
  for (let t = 0; t < races; t++) {
    runMultiRace(calculator, entries, {
      seed: 4649, trial: t,
      onFrame: (frame, states) => {
        for (let i = 0; i < states.length; i++) {
          const now = states[i]!.simulation.positionKeepState;
          if (now !== prev[i] && now !== 'NONE') keep[i]![now] = (keep[i]![now] ?? 0) + 1;
          prev[i] = now;
        }
        if (frame % 150 !== 0) return;
        const sorted = [...states.keys()].sort(
          (a, b) => states[b]!.simulation.position - states[a]!.simulation.position,
        );
        sorted.forEach((index, rank) => { orderSum[index]! += rank + 1; });
        samples++;
      },
    });
  }
  console.log(`位置取り（${races} レース、全頭同じステータス）`);
  console.log('');
  console.log('| 出走 | 脚質 | レース途中の平均順位 | 入った位置取り |');
  console.log('| --- | --- | ---: | --- |');
  for (let i = 0; i < lineup.length; i++) {
    const entered = Object.entries(keep[i]!)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join('、');
    console.log(
      `| ${i} | ${styleLabel[lineup[i]!]} | ${(orderSum[i]! / samples).toFixed(2)} | ${entered || 'なし'} |`,
    );
  }
  console.log('');
}

// 4. 共通乱数の効き。相手を固定したまま、自分にスキルを 1 つ足す。
// 名簿のときは試行ごとに相手が変わるが、試行番号で決まるので足す前後で同じ相手になる。
{
  const skill = data.skillsByName.get('円弧のマエストロ')?.[0];
  if (skill !== undefined) {
    const profile = defaultFieldProfile(9);
    const self = base('SEN');
    // 名簿の相手は自分と同格に揃える（profile の既定が matchSelf）。
    const lineupAt = opponentsFor(profile, self.uma);
    const run = (skills: typeof skill[]) => {
      const times: number[] = [];
      const orders: number[] = [];
      for (let t = 0; t < trials; t++) {
        const entries: MultiEntry[] = [{ setting: { ...self, skills } }, ...lineupAt(t)];
        const out = runMultiRace(calculator, entries, { seed: 4649, trial: t });
        const me = out.entries[0]!;
        times.push(me.result.raceTime);
        orders.push(me.order);
      }
      return { times, orders };
    };
    const before = run([]);
    const after = run([skill]);
    const diffs = before.times.map((x, i) => x - after.times[i]!);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = (xs: number[]) => {
      const m = mean(xs);
      return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
    };
    const paired = sd(diffs) / Math.sqrt(diffs.length);
    const unpaired = Math.sqrt((sd(before.times) ** 2 + sd(after.times) ** 2) / trials);
    const zero = diffs.filter((d) => Math.abs(d) < 1e-9).length;
    console.log(`${skill.name} を 1 つ足したときの差（${trials} 試行）`);
    console.log('');
    console.log(`- 短縮 ${mean(diffs).toFixed(4)} 秒`);
    console.log(`- ペアで取った差の標準誤差 ${paired.toFixed(5)} 秒`);
    console.log(`- 別々に平均した場合の標準誤差 ${unpaired.toFixed(5)} 秒`);
    console.log(`- 標準誤差の縮み ${(unpaired / paired).toFixed(2)} 倍`);
    console.log(`- 差が厳密に 0 だった試行 ${pct(zero / trials)}`);
    const winBefore = before.orders.filter((o) => o === 1).length / trials;
    const winAfter = after.orders.filter((o) => o === 1).length / trials;
    console.log(`- 勝率 ${pct(winBefore)} から ${pct(winAfter)} へ`);
  }
}
