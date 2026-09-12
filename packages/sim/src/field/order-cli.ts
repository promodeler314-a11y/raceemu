/**
 * 順位条件の判定が、相手の作り方でどう変わるかの実測。
 *   pnpm order-field [--trials 200] [--exp all|base|skills|together|mismatch|redraw|live] [--level weak|strong|both] [--skipstart]
 *
 * 脚質ごとに、代表的な順位条件が各フェーズで「1 フレームでも満たされた」試行の割合と、
 * 中盤末・終盤末・ゴールでの順位分布を出す。docs/order-field.md を参照。
 */
import { loadGameData } from '../../../data/src/node.ts';
import { RaceCalculator, goal, updateFrame } from '../calculator.ts';
import type { Style } from '../data/constants.ts';
import { runMultiRace, type MultiEntry } from '../multi/race.ts';
import { defaultSystemSetting, type RaceSetting, type UmaStatus } from '../setting.ts';
import type { SkillData } from '../skill/types.ts';
import type { RaceState } from '../state.ts';
import {
  RecordedField,
  defaultFieldProfile,
  opponentSettings,
  type FieldBundle,
  type FieldSample,
} from './field.ts';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1]! : fallback;
}
const trials = Number(arg('trials', '200'));
const which = arg('exp', 'all');
const levelArg = arg('level', 'both');
/** 出走前（まだ動いていない）フレームを判定から外す */
const skipStart = process.argv.includes('--skipstart');
const SAMPLES = 64;
const SEED = 4649;

const data = loadGameData();
const system = defaultSystemSetting();
const calculator = new RaceCalculator(system, data.trackData);
const track = {
  location: Number(arg('location', '10006')),
  course: Number(arg('course', '10606')),
  condition: 1,
  gateCount: 9,
} as const;
const courseLength = data.trackData[track.location]!.courses[track.course]!.distance;
const styles: Style[] = ['NIGE', 'SEN', 'SASI', 'OI'];
const label: Record<string, string> = { NIGE: '逃げ', SEN: '先行', SASI: '差し', OI: '追込' };

const umaOf = (style: Style, s: readonly number[], patch: Partial<UmaStatus> = {}): UmaStatus => ({
  charaName: '', speed: s[0]!, stamina: s[1]!, power: s[2]!, guts: s[3]!, wisdom: s[4]!,
  condition: 'BEST', style, distanceFit: 'A', surfaceFit: 'A', styleFit: 'A',
  popularity: 1, gateNumber: 0, uniqueLevel: 6, ...patch,
});
const settingOf = (
  uma: UmaStatus,
  skills: readonly SkillData[] = [],
  mode: RaceSetting['positionKeepMode'] = 'APPROXIMATE',
): RaceSetting => ({
  uma, track, skills: [...skills], skillActivateAdjustment: 'NONE', randomPosition: 'RANDOM',
  debuffCounts: {}, positionKeepMode: mode, positionKeepRate: 100,
});

/** 相手を 1 頭ずつ独立に走らせて束を作る。作り方 A である（いまの buildFieldBundle は C）。 */
function buildAlone(settings: readonly RaceSetting[], seed: number): FieldBundle {
  const styles = settings.map((setting) => setting.uma.style);
  const samples: FieldSample[] = [];
  for (let s = 0; s < SAMPLES; s++) {
    const runs = settings.map((setting, index) =>
      calculator.simulate(setting, { seed, trial: s * 1000 + index, recordFrames: true }),
    );
    const frames = Math.max(1, ...runs.map((r) => r.state.simulation.frames.length));
    const opponents = runs.length;
    const positions = new Float64Array(frames * opponents);
    for (let i = 0; i < opponents; i++) {
      const list = runs[i]!.state.simulation.frames;
      for (let f = 0; f < frames; f++) {
        positions[f * opponents + i] = list[f]?.startPosition ?? courseLength;
      }
    }
    samples.push({ opponents, frames, positions, styles });
  }
  return { samples, opponents: settings.length, courseLength };
}

/** 相手同士を一緒に走らせて（先頭に対して位置取りしながら）束を作る */
function buildTogether(settingsOf: (sample: number) => readonly RaceSetting[], seed: number): FieldBundle {
  const samples: FieldSample[] = [];
  let opponents = 0;
  for (let s = 0; s < SAMPLES; s++) {
    const settings = settingsOf(s);
    opponents = settings.length;
    const styles = settings.map((setting) => setting.uma.style);
    const entries: MultiEntry[] = settings.map((setting) => ({ setting: { ...setting, positionKeepMode: 'VIRTUAL' } }));
    const rows: number[][] = [];
    runMultiRace(calculator, entries, {
      seed, trial: s,
      onFrame: (_frame, states) => {
        rows.push(states.map((st) => Math.min(st.simulation.startPosition, courseLength)));
      },
    });
    const frames = rows.length;
    const positions = new Float64Array(frames * opponents);
    for (let f = 0; f < frames; f++) for (let i = 0; i < opponents; i++) positions[f * opponents + i] = rows[f]![i]!;
    samples.push({ opponents, frames, positions, styles });
  }
  return { samples, opponents, courseLength };
}

interface Trace { readonly orders: readonly number[]; readonly positions: readonly number[] }

function traceOf(frames: readonly { startPosition: number }[], sample: FieldSample): Trace {
  const orders: number[] = [];
  const positions: number[] = [];
  frames.forEach((fr, f) => {
    const frame = Math.min(f, sample.frames - 1);
    let ahead = 0;
    for (let i = 0; i < sample.opponents; i++) {
      if (sample.positions[frame * sample.opponents + i]! > fr.startPosition) ahead++;
    }
    orders.push(ahead + 1);
    positions.push(fr.startPosition);
  });
  return { orders, positions };
}

/** 自分は従来どおり（固定区間でペースダウンする近似）で走る */
function runAlone(self: UmaStatus, bundle: FieldBundle, selfSkills: readonly SkillData[]): Trace[] {
  const traces: Trace[] = [];
  for (let t = 0; t < trials; t++) {
    const { state } = calculator.simulate(settingOf(self, selfSkills), {
      // 相手の位置は読むが、自分の位置取りは近似のまま。これが作り方 A である。
      seed: SEED, trial: t, recordFrames: true, field: bundle, pacedByField: false,
    });
    traces.push(traceOf(state.simulation.frames, bundle.samples[t % bundle.samples.length]!));
  }
  return traces;
}

/** 自分も、記録した束の先頭に対して位置取りする */
function runPaced(
  self: UmaStatus,
  bundle: FieldBundle,
  selfSkills: readonly SkillData[],
): Trace[] {
  const traces: Trace[] = [];
  for (let t = 0; t < trials; t++) {
    const index = t % bundle.samples.length;
    const sample = bundle.samples[index]!;
    // 先頭の取り出しは RecordedField が持つので、ここで組む必要は無い。
    const state = calculator.createState(settingOf(self, selfSkills, 'VIRTUAL'), {
      seed: SEED, trial: t, recordFrames: true, field: new RecordedField(bundle, t),
    });
    for (let guard = 0; guard < 6000; guard++) {
      if (updateFrame(state) || state.simulation.position >= courseLength) break;
    }
    goal(state);
    traces.push(traceOf(state.simulation.frames, sample));
  }
  return traces;
}

/** 全頭同時（勝率の面と同じ駆動） */
function runLive(self: UmaStatus, opponents: readonly RaceSetting[], selfSkills: readonly SkillData[]): Trace[] {
  const traces: Trace[] = [];
  const entries: MultiEntry[] = [
    { setting: settingOf(self, selfSkills, 'VIRTUAL') },
    ...opponents.map((setting) => ({ setting })),
  ];
  for (let t = 0; t < trials; t++) {
    const orders: number[] = [];
    const positions: number[] = [];
    runMultiRace(calculator, entries, {
      seed: SEED, trial: t,
      onFrame: (_frame, states) => {
        const me = states[0]!.simulation.startPosition;
        if (me >= courseLength) return;
        let ahead = 0;
        for (let i = 1; i < states.length; i++) if (states[i]!.simulation.startPosition > me) ahead++;
        orders.push(ahead + 1);
        positions.push(me);
      },
    });
    traces.push({ orders, positions });
  }
  return traces;
}

const conditions: readonly [string, (order: number) => boolean][] = [
  ['1 位', (o) => o === 1],
  ['3 位以内', (o) => o <= 3],
  ['5 位以内（順位率 ≦ 50）', (o) => o <= 5],
  ['2 位以降', (o) => o >= 2],
  ['4 位以降（順位率 ≧ 40）', (o) => o >= 4],
  ['6 位以降（順位率 > 50）', (o) => o >= 6],
];
const phaseNames = ['序盤', '中盤', '終盤', 'ラスト'];

function report(title: string, traces: readonly Trace[]): void {
  const p1 = courseLength / 6;
  const p2 = (courseLength * 2) / 3;
  const p3 = (courseLength * 5) / 6;
  const phaseOf = (x: number) => (x < p1 ? 0 : x < p2 ? 1 : x < p3 ? 2 : 3);
  console.log(`\n### ${title}`);
  console.log(`| 条件 | ${phaseNames.join(' | ')} |`);
  console.log('| --- | ---: | ---: | ---: | ---: |');
  for (const [name, holds] of conditions) {
    const cells = [0, 1, 2, 3].map((phase) => {
      let hit = 0;
      for (const t of traces) {
        for (let i = 0; i < t.orders.length; i++) {
          if (skipStart && t.positions[i]! <= t.positions[0]!) continue;
          if (phaseOf(t.positions[i]!) === phase && holds(t.orders[i]!)) { hit++; break; }
        }
      }
      return `${((100 * hit) / traces.length).toFixed(0)} %`;
    });
    console.log(`| ${name} | ${cells.join(' | ')} |`);
  }
  const distribution = (mark: number) => {
    const hist = new Array<number>(track.gateCount + 1).fill(0);
    for (const t of traces) {
      let idx = t.positions.findIndex((x) => x >= mark);
      if (idx < 0) idx = t.positions.length - 1;
      hist[t.orders[idx]!]!++;
    }
    return hist.slice(1).map((c) => ((100 * c) / traces.length).toFixed(0)).join(' ');
  };
  console.log(
    `順位分布（1 位から ${track.gateCount} 位、%） 中盤末: ${distribution(p2)} / 終盤末: ${distribution(p3)} / ゴール: ${distribution(courseLength - 1)}`,
  );
}

/** 決定的なゆらぎ。相手の添字ごとに違う値を返し、同じ添字なら同じ値になる。 */
function jitter(index: number, k: number, sigma: number): number {
  let h = (index * 7919 + k * 104729 + 12345) >>> 0;
  const u = () => {
    h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return (h >>> 8) / 0x1000000;
  };
  // 一様 3 つの和で正規に近づける
  return Math.round((u() + u() + u() - 1.5) * sigma * 1.63);
}
function jitterUma(uma: UmaStatus, index: number, sigma: number): UmaStatus {
  return {
    ...uma,
    speed: uma.speed + jitter(index, 1, sigma),
    stamina: uma.stamina + jitter(index, 2, sigma),
    power: uma.power + jitter(index, 3, sigma),
    guts: uma.guts + jitter(index, 4, sigma),
    wisdom: uma.wisdom + jitter(index, 5, sigma),
  };
}

const byName = (names: readonly string[]): SkillData[] =>
  names.flatMap((n) => {
    const s = data.skillsByName.get(n);
    return s === undefined ? [] : [s[0]!];
  });
/** 相手に持たせる典型スキル。脚質共通の通常スキルと、脚質ごとのもの。 */
const genericSkills = byName(['末脚', 'コーナー巧者○', '直線巧者', '好位追走', 'ペースアップ', '集中力', '中距離直線○', '中距離コーナー○']);
const styleSkills: Record<Style, SkillData[]> = {
  NIGE: byName(['先駆け', '脱出術', '先手必勝', '急ぎ足', 'スピードスター', 'トップランナー', 'ペースキープ', '逃げ直線○']),
  SEN: byName(['抜け出し準備', '積極策', '真っ向勝負', '粘り腰', 'レースプランナー', '先行直線○', '先行コーナー○']),
  SASI: byName(['豪脚', '仕掛け抜群', '食い下がり', '垂れウマ回避', '位置取り押し上げ', '差し直線○', '差しコーナー○']),
  OI: byName(['直線一気', '迫る影', 'ノンストップガール', '二の矢', '追込直線○', '追込コーナー○']),
  OONIGE: [],
};
/** 自分にも同じ量のスキルを持たせて、相手だけがスキルを持つ偏りを避ける */
const selfSkillsFor = (style: Style): SkillData[] => [...genericSkills.slice(0, 4), ...styleSkills[style].slice(0, 4)];

const levels: Record<string, readonly number[]> = {
  weak: [1100, 900, 900, 600, 900],
  strong: [1400, 1100, 1100, 900, 1100],
};
const profile = defaultFieldProfile(track.gateCount);
const lineup: Style[] = [];
for (const st of styles) for (let i = 0; i < profile.counts[st]; i++) lineup.push(st);
console.log(`${data.trackData[track.location]!.name} ${data.trackData[track.location]!.courses[track.course]!.name} / ${track.gateCount} 頭 / ${trials} 試行`);
console.log(`相手の脚質構成（既定）: ${lineup.map((s) => label[s]).join(' ')}`);
console.log(`相手のスキル: ${genericSkills.map((s) => s.name).join(', ')} ＋ 脚質ごとのもの`);
if (skipStart) console.log('出走前のフレームは判定から外している');

const enabled = (name: string) => (which === 'all' ? name !== 'mismatch' : which === name);

for (const [level, stats] of Object.entries(levels)) {
  if (levelArg !== 'both' && levelArg !== level) continue;
  for (const style of styles) {
    const self = umaOf(style, stats);
    const selfSkills = selfSkillsFor(style);
    const head = `自分=${label[style]} ${stats.join('-')}`;

    if (enabled('base')) {
      const bundle = buildAlone(opponentSettings(profile, track, []), SEED);
      report(`【A 既定】相手は 1100-900-900-600-900 で同一、スキル無し、1 頭ずつ独立に走らせる / ${head}`, runAlone(self, bundle, selfSkills));
    }
    const sameLevel = lineup.map((st, i) => settingOf(jitterUma(umaOf(st, stats), i, 80), [...genericSkills, ...styleSkills[st].slice(0, 3)]));
    if (enabled('skills')) {
      const bundle = buildAlone(sameLevel, SEED);
      report(`【B 同格】相手は自分と同格（σ80）でスキルあり、1 頭ずつ独立に走らせる / ${head}`, runAlone(self, bundle, selfSkills));
    }
    if (enabled('together')) {
      const bundle = buildTogether(() => sameLevel, SEED);
      report(`【C 一緒に走らせる】B の相手を一緒に走らせ、自分も先頭に対して位置取りする / ${head}`, runPaced(self, bundle, selfSkills));
    }
    if (enabled('mismatch')) {
      // 相手は一緒に走らせた束、自分は従来どおり固定区間でペースダウンするだけ。位置取りの規則が食い違うとどうなるか。
      const bundle = buildTogether(() => sameLevel, SEED);
      report(`【C' 食い違い】B の相手を一緒に走らせた束に、自分は従来どおり（APPROXIMATE）で走る / ${head}`, runAlone(self, bundle, selfSkills));
    }
    if (enabled('redraw')) {
      // 束の 1 本ごとに、脚質構成・強さ・やる気・スキルを引き直す
      const compositions: readonly (readonly number[])[] = [
        [2, 3, 3, 0], [1, 3, 3, 1], [2, 2, 3, 1], [3, 3, 2, 0], [1, 4, 2, 1], [2, 3, 2, 1], [2, 2, 2, 2], [1, 2, 3, 2],
      ];
      const settingsOf = (sample: number): RaceSetting[] => {
        const comp = compositions[sample % compositions.length]!;
        const settings: RaceSetting[] = [];
        let idx = 0;
        styles.forEach((st, k) => {
          for (let i = 0; i < comp[k]!; i++, idx++) {
            const key = sample * 16 + idx;
            const uma = jitterUma(umaOf(st, stats), key, 120);
            const condition = (['BEST', 'GOOD', 'NORMAL'] as const)[Math.abs(jitter(key, 9, 100)) % 3]!;
            const pool = [...genericSkills, ...styleSkills[st]];
            const n = 5 + (Math.abs(jitter(key, 7, 100)) % 4);
            const start = Math.abs(jitter(key, 8, 100)) % pool.length;
            const skills = Array.from({ length: n }, (_, j) => pool[(start + j) % pool.length]!);
            settings.push(settingOf({ ...uma, condition }, skills, 'VIRTUAL'));
          }
        });
        return settings;
      };
      const bundle = buildTogether(settingsOf, SEED);
      report(`【D 引き直し】束ごとに構成・強さ・やる気・スキルを引き直して一緒に走らせ、自分も位置取りする / ${head}`, runPaced(self, bundle, selfSkills));
    }
    if (enabled('live')) {
      const opponents = sameLevel.map((s) => ({ ...s, positionKeepMode: 'VIRTUAL' as const }));
      report(`【E 全頭同時】B の相手と自分を同時に走らせる（勝率の面と同じ） / ${head}`, runLive(self, opponents, selfSkills));
    }
  }
}
