import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { canTrigger } from '../../solver/src/screen.ts';
import { RaceCalculator } from '../src/calculator.ts';
import type { Style } from '../src/data/constants.ts';
import { runMultiRace, type MultiEntry } from '../src/multi/race.ts';
import {
  DerivedSetting,
  defaultSystemSetting,
  emptyPassiveBonus,
  type RaceSetting,
} from '../src/setting.ts';
import { Invoke, SkillCondition, SkillData, SkillEffect } from '../src/skill/types.ts';

/**
 * 全頭同時のレースで、共通乱数が厳密に成り立つことの検査。
 *
 * 単騎の側は optimize.test.ts の「効かないスキルを足しても差は厳密に 0 になる」が
 * 見ている。勝率の対比較（自分にスキルを足した案と足さない案を、同じ相手・同じ種で
 * 並べて試行ごとの差を取る）は全頭同時の側で行うので、同じ性質がここでも成り立たないと
 * 差の標準誤差が見かけだけ小さくなる（または差が 0 にならない）。
 *
 * 見ているのは「発動しようがないスキルを自分に足しても、全頭の着順とタイムが
 * 1 ビットも変わらない」ことである。乱数がスキルの本数に依って消費されていれば、
 * 足した瞬間に以降の出目が全頭でずれる。
 */

const data = loadGameData();
const system = defaultSystemSetting();
const calculator = new RaceCalculator(system, data.trackData);
const track = { location: 10006, course: 10606, condition: 1, gateCount: 5, season: 1, weather: 1, time: 1 } as const;

const styles: Style[] = ['SEN', 'NIGE', 'SASI', 'OI', 'SEN'];

function make(style: Style, skills: readonly SkillData[] = []): RaceSetting {
  return {
    uma: {
      charaName: '', speed: 1200, stamina: 1000, power: 900, guts: 600, wisdom: 900,
      condition: 'BEST', style, distanceFit: 'A', surfaceFit: 'A', styleFit: 'A',
      popularity: 1, gateNumber: 0, uniqueLevel: 6,
    },
    track, skills,
    skillActivateAdjustment: 'NONE', randomPosition: 'RANDOM',
    debuffCounts: {}, positionKeepMode: 'VIRTUAL', positionKeepRate: 100,
  };
}

const derived = new DerivedSetting(make('SEN'), emptyPassiveBonus(), data.trackData);

const real = (name: string): SkillData => {
  const found = data.skillsByName.get(name)?.find((s) => s.sp > 0);
  if (found === undefined) throw new Error(`買えるスキルが見つからない: ${name}`);
  return found;
};

/**
 * 発動の条件を track_id だけにしたスキルを作る。
 * 条件が真なら確かに発動して走りを変え、偽なら出走前に偽と決まる。
 */
function trackSkill(
  id: string,
  trackId: number,
  effects: SkillEffect[],
  duration: number,
  activateLot: number,
): SkillData {
  const invoke = new Invoke(id, 1, [[new SkillCondition('track_id', '==', trackId)]], [], effects, 500, duration, 1);
  return new SkillData(id, `track_id が ${trackId} のとき`, 'normal', 99999, 'speed', 100, activateLot, [invoke], [], null);
}

const raceTrackId = derived.trackDetail.raceTrackId;
// 別の競馬場の条件を持つ。出走前の条件で偽になる。発動率の抽選は普通のスキルと同じ 1 にして、
// 抽選に通ったときも通らなかったときも見る。
const otherTrack = trackSkill('990000001', raceTrackId + 1, [new SkillEffect('targetSpeed', 5000)], 30, 1);
// 季節が違う（春に走るので、夏と秋と冬のスキルは発動しない）。
const otherSeasons = ['夏ウマ娘○', '秋ウマ娘○', '冬ウマ娘○'].map(real);
// 同じ効果で、条件を今の競馬場に合わせたもの。確かに発動して速くなる（対照）。
// 発動率の抽選（activateLot）は外し、足したら必ず発動するようにしておく。
const sameTrack = trackSkill('990000002', raceTrackId, [new SkillEffect('targetSpeed', 5000)], 30, 0);
// 自分の枠に元から入れておく実在のスキル。
const owned = ['コーナー加速○', '中距離直線○'].map(real);

const never = [otherTrack, ...otherSeasons];

/** 全頭の着順とタイムを、後で厳密に比べられる形にする。 */
function run(entries: readonly MultiEntry[], seed: number, trial: number) {
  const out = runMultiRace(calculator, entries, { seed, trial });
  return {
    order: out.entries.map((e) => e.order),
    time: out.entries.map((e) => e.result.raceTime),
    frames: out.frames,
    triggered: out.states.map((s) => s.simulation.skillTriggerCount.total),
  };
}

/** 自分（0 番）の持ち物だけを変えた出走表。相手は同じ。 */
function lineup(mine: readonly SkillData[], seeded: boolean, others: readonly SkillData[] = []): MultiEntry[] {
  return styles.map((style, i) => ({
    setting: make(style, i === 0 ? mine : i === 2 ? others : []),
    ...(seeded ? { seed: 5000 + i } : {}),
  }));
}

const trials = [0, 1, 2, 3, 4, 5];

describe('全頭同時の共通乱数', () => {
  it('足すスキルが、この設定で発動しようがないものである（前提）', () => {
    for (const skill of never) expect(canTrigger(skill, derived)).toBe(false);
    expect(canTrigger(sameTrack, derived)).toBe(true);
  });

  for (const seeded of [false, true]) {
    const label = seeded ? '各エントリーに seed を渡す' : 'seed を渡さない（出走順から導く）';

    describe(label, () => {
      it('発動しないスキルを自分に足しても、全頭の着順とタイムが 1 つも変わらない', () => {
        for (const trial of trials) {
          const before = run(lineup([], seeded), 17, trial);
          const after = run(lineup(never, seeded), 17, trial);
          expect(after.time).toEqual(before.time);
          expect(after.order).toEqual(before.order);
          expect(after.frames).toBe(before.frames);
          // 足したスキルは本当に発動していない
          expect(after.triggered).toEqual(before.triggered);
        }
      });

      it('すでにスキルを持っていても、発動しないスキルを足して変わらない', () => {
        for (const trial of trials) {
          const before = run(lineup(owned, seeded), 17, trial);
          for (const extra of never) {
            const after = run(lineup([...owned, extra], seeded), 17, trial);
            expect(after.time).toEqual(before.time);
            expect(after.order).toEqual(before.order);
          }
          // 足す位置にも依らない（先頭に足しても同じ）
          const front = run(lineup([...never, ...owned], seeded), 17, trial);
          expect(front.time).toEqual(before.time);
        }
      });

      it('相手に足したときも、自分と他の相手は変わらない', () => {
        for (const trial of trials) {
          const before = run(lineup(owned, seeded), 17, trial);
          const after = run(lineup(owned, seeded, never), 17, trial);
          // 2 番に足しただけなので、全頭が同じになる
          expect(after.time).toEqual(before.time);
          expect(after.order).toEqual(before.order);
        }
      });

      it('対照：発動するスキルを足すと自分の走りが変わる（検査が空振りしていない）', () => {
        let changed = 0;
        for (const trial of trials) {
          const before = run(lineup(owned, seeded), 17, trial);
          const after = run(lineup([...owned, sameTrack], seeded), 17, trial);
          expect(after.triggered[0]!).toBeGreaterThan(before.triggered[0]!);
          if (after.time[0] !== before.time[0]) changed++;
        }
        expect(changed).toBe(trials.length);
      });
    });
  }

  it('試行番号が違えば出目が違う（同じ結果を返しているだけではない）', () => {
    const a = run(lineup(owned, false), 17, 0);
    const b = run(lineup(owned, false), 17, 1);
    expect(b.time).not.toEqual(a.time);
  });
});
