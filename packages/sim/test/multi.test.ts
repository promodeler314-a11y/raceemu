import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { RaceCalculator } from '../src/calculator.ts';
import type { Style } from '../src/data/constants.ts';
import { runMultiRace, type MultiEntry } from '../src/multi/race.ts';
import { replayMultiRace } from '../src/multi/replay.ts';
import { OrderTally } from '../src/multi/summary.ts';
import { nodeWorkerFactory } from '../src/parallel/node.ts';
import { WorkerPool } from '../src/parallel/pool.ts';
import { MULTI_FIELDS, toSerializable, unpackMultiEntry } from '../src/parallel/protocol.ts';
import { RngSet } from '../src/rng.ts';
import { defaultSystemSetting, type RaceSetting } from '../src/setting.ts';
import { compileConditions, newSkillScratch } from '../src/skill/condition.ts';
import { SkillCondition } from '../src/skill/types.ts';

const data = loadGameData();
const system = defaultSystemSetting();
const calculator = new RaceCalculator(system, data.trackData);
const track = { location: 10006, course: 10606, condition: 1, gateCount: 9 } as const;

function make(style: Style, patch: Partial<RaceSetting['uma']> = {}): RaceSetting {
  return {
    uma: {
      charaName: '', speed: 1200, stamina: 1000, power: 900, guts: 600, wisdom: 900,
      condition: 'BEST', style, distanceFit: 'A', surfaceFit: 'A', styleFit: 'A',
      popularity: 1, gateNumber: 0, uniqueLevel: 6, ...patch,
    },
    track, skills: [],
    skillActivateAdjustment: 'NONE', randomPosition: 'RANDOM',
    debuffCounts: {}, positionKeepMode: 'VIRTUAL', positionKeepRate: 100,
  };
}

const lineup: Style[] = ['NIGE', 'NIGE', 'SEN', 'SEN', 'SEN', 'SASI', 'SASI', 'OI', 'OI'];
const entries: MultiEntry[] = lineup.map((style) => ({ setting: make(style) }));

describe('全頭同時', () => {
  it('着順が 1 から頭数まで重複なく付く', () => {
    const out = runMultiRace(calculator, entries, { seed: 7, trial: 0 });
    const orders = out.entries.map((e) => e.order).sort((a, b) => a - b);
    expect(orders).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // 着順はタイムの順である
    const byOrder = [...out.entries].sort((a, b) => a.order - b.order);
    for (let i = 1; i < byOrder.length; i++) {
      expect(byOrder[i]!.result.raceTime).toBeGreaterThanOrEqual(byOrder[i - 1]!.result.raceTime);
    }
  });

  it('枠番が重ならない', () => {
    const out = runMultiRace(calculator, entries, { seed: 7, trial: 3 });
    const gates = out.states.map((s) => s.setting.base.uma.gateNumber);
    expect(new Set(gates).size).toBe(gates.length);
  });

  it('同じ入力なら同じ結果になる', () => {
    const a = runMultiRace(calculator, entries, { seed: 7, trial: 5 });
    const b = runMultiRace(calculator, entries, { seed: 7, trial: 5 });
    expect(b.entries.map((e) => e.result.raceTime)).toEqual(a.entries.map((e) => e.result.raceTime));
  });

  it('出走順を入れ替えても各頭の走りは変わらない', () => {
    // 種と枠を固定すれば、並び順は結果に効いてはならない。
    // フレームの頭で全頭の位置を揃えてから進めていることの検査である。
    const pinned: MultiEntry[] = lineup.map((style, i) => ({
      setting: make(style, { gateNumber: i + 1 }),
      seed: 1000 + i,
    }));
    const forward = runMultiRace(calculator, pinned, { seed: 7, trial: 2 });
    const reversed = runMultiRace(calculator, [...pinned].reverse(), { seed: 7, trial: 2 });
    for (let i = 0; i < pinned.length; i++) {
      const mine = forward.entries[i]!;
      const same = reversed.entries[pinned.length - 1 - i]!;
      expect(same.result.raceTime).toBeCloseTo(mine.result.raceTime, 9);
      expect(same.order).toBe(mine.order);
    }
  });

  it('逃げが前を走り、追込が後ろを走る', () => {
    // 全頭同じステータスなので、隊列の違いは脚質だけから来る
    const meanOrder: number[] = new Array(lineup.length).fill(0);
    let samples = 0;
    for (let t = 0; t < 5; t++) {
      runMultiRace(calculator, entries, {
        seed: 11, trial: t,
        onFrame: (frame, states) => {
          if (frame % 150 !== 0) return;
          const sorted = [...states.keys()].sort(
            (a, b) => states[b]!.simulation.position - states[a]!.simulation.position,
          );
          sorted.forEach((index, rank) => { meanOrder[index]! += rank + 1; });
          samples++;
        },
      });
    }
    // samples は「観測したフレーム数」であり、各頭がその回数ぶん寄与している
    const per = meanOrder.map((sum) => sum / samples);
    const nige = (per[0]! + per[1]!) / 2;
    const oi = (per[7]! + per[8]!) / 2;
    expect(nige).toBeLessThan(3);
    expect(oi).toBeGreaterThan(6);
  });

  it('相手を強くすると勝率が下がる', () => {
    const measure = (opponentSpeed: number) => {
      const field: MultiEntry[] = [
        { setting: make('SEN') },
        ...lineup.slice(1).map((style) => ({ setting: make(style, { speed: opponentSpeed }) })),
      ];
      const tally = new OrderTally(field.length);
      for (let t = 0; t < 60; t++) tally.add(runMultiRace(calculator, field, { seed: 21, trial: t }));
      return tally.summarize(0).winRate;
    };
    expect(measure(1400)).toBeLessThan(measure(1000));
  });

  it('Worker で回しても単一スレッドと一致する', async () => {
    const trials = 24;
    const serializable = entries.map((e) => toSerializable(e.setting));
    const pool = new WorkerPool(nodeWorkerFactory, 3);
    try {
      const out = await pool.runMulti(serializable, system, { count: trials, seed: 31, chunkSize: 5 });
      expect(out.entries).toBe(entries.length);
      for (let t = 0; t < trials; t++) {
        const expected = runMultiRace(calculator, entries, { seed: 31, trial: t });
        for (const entry of expected.entries) {
          const offset = (t * entries.length + entry.index) * MULTI_FIELDS;
          const actual = unpackMultiEntry(out.packed, offset);
          expect(actual.order).toBe(entry.order);
          expect(actual.result.raceTime).toBeCloseTo(entry.result.raceTime, 9);
        }
      }
    } finally {
      await pool.dispose();
    }
  }, 120000);

  /**
   * 1 試行を開く機能（#57）の芯。
   *
   * 勝率はフレーム列を捨てて集計だけを残す。開きたい 1 本は、そのときの種と
   * 試行番号でもう一度走らせ直して作る。走らせ直したレースが元と違えば、
   * 画面に出る図は「その試行の中身」ではなくなり、機能全体が嘘になる。
   */
  describe('1 試行の走らせ直し', () => {
    it('走らせ直しても、元の実行と着順とタイムが厳密に一致する', () => {
      // 勝率を出すときと同じように、続けて何試行も回す。
      const batch = [...Array(8).keys()].map((trial) =>
        runMultiRace(calculator, entries, { seed: 57, trial }),
      );
      // そのうちの 1 本だけを、あとから開く。
      for (const trial of [0, 3, 7]) {
        const replay = replayMultiRace(calculator, entries, { seed: 57, trial });
        const expected = batch[trial]!;
        for (const entry of expected.entries) {
          const horse = replay.horses.find((h) => h.index === entry.index)!;
          expect(horse.order).toBe(entry.order);
          // 小数第 9 位までではなく、ビット単位で同じであることを見る。
          expect(horse.raceTime).toBe(entry.result.raceTime);
        }
      }
    });

    it('Worker で集計した結果とも、着順とタイムが一致する', async () => {
      // 画面が通る経路は Worker である。集計は Worker、開くのは主スレッドなので、
      // 両方で同じレースになっていなければならない。
      const trials = 12;
      const serializable = entries.map((e) => toSerializable(e.setting));
      const pool = new WorkerPool(nodeWorkerFactory, 2);
      try {
        const out = await pool.runMulti(serializable, system, { count: trials, seed: 57, chunkSize: 5 });
        for (const trial of [1, 6, 11]) {
          const replay = replayMultiRace(calculator, entries, { seed: 57, trial });
          for (const horse of replay.horses) {
            const offset = (trial * entries.length + horse.index) * MULTI_FIELDS;
            const actual = unpackMultiEntry(out.packed, offset);
            expect(horse.order).toBe(actual.order);
            expect(horse.raceTime).toBeCloseTo(actual.result.raceTime, 9);
          }
        }
      } finally {
        await pool.dispose();
      }
    }, 120000);

    it('全頭ぶんの位置と速度が揃い、自分のスキルの発動を拾える', () => {
      const skill = data.skillsByName.get('コーナー加速○')?.[0];
      expect(skill).toBeDefined();
      const withSkill: MultiEntry[] = [
        { setting: { ...make('SEN'), skills: [skill!] } },
        ...entries.slice(1),
      ];
      const replay = replayMultiRace(calculator, withSkill, { seed: 57, trial: 2 });

      expect(replay.horses).toHaveLength(entries.length);
      expect(replay.times.length).toBe(replay.frames);
      for (const horse of replay.horses) {
        expect(horse.positions.length).toBe(horse.speeds.length);
        expect(horse.positions.length).toBeGreaterThan(0);
        expect(horse.positions.length).toBeLessThanOrEqual(replay.frames);
        // 位置は戻らない。
        for (let i = 1; i < horse.positions.length; i++) {
          expect(horse.positions[i]!).toBeGreaterThanOrEqual(horse.positions[i - 1]!);
        }
        // 記録しているのはフレームの頭の位置なので、最後の 1 フレームぶん
        // （1/15 秒で 2 m 少々）だけゴール線の手前で終わる。
        expect(horse.positions[horse.positions.length - 1]!).toBeGreaterThan(
          replay.courseLength - 4,
        );
      }
      // 自分のフレーム列にスキルの発動が入っている（図の縦線の元になる）
      const triggered = replay.focusFrames
        .slice(1)
        .flatMap((frame) => frame.triggeredSkills.map((t) => t.invoke.skill.name));
      expect(triggered).toContain('コーナー加速○');
    });
  });

  it('相互作用があるぶん、単独で走らせたときとは違う結果になる', () => {
    const alone = calculator.simulate(make('SEN'), { seed: 41, trial: 0 });
    const together = runMultiRace(calculator, [{ setting: make('SEN'), seed: 41 }, ...entries.slice(1)], {
      seed: 41, trial: 0,
    });
    expect(together.entries[0]!.result.raceTime).not.toBeCloseTo(alone.result.raceTime, 3);
  });
});

/**
 * 勝率の面で出走頭数を 2〜18 から選べるようにしたときの芯。
 * 9 頭と 12 頭以外では、順位率の境界は式で延ばした近似になる（docs/order-condition.md 2.2 節）。
 */
describe('全頭同時の頭数と枠番', () => {
  const styles: Style[] = ['NIGE', 'SEN', 'SASI', 'OI'];
  const lineupOf = (heads: number, patch: (i: number) => Partial<RaceSetting['uma']> = () => ({})) => {
    const trackN = { ...track, gateCount: heads };
    return Array.from({ length: heads }, (_, i) => ({
      setting: { ...make(styles[i % 4]!, patch(i)), track: trackN },
    }));
  };
  const gatesOf = (out: ReturnType<typeof runMultiRace>) =>
    out.states.map((s) => s.setting.base.uma.gateNumber);

  for (const heads of [2, 18]) {
    it(`${heads} 頭でも、枠番が重ならず、着順が 1 から頭数まで揃う`, () => {
      const field = lineupOf(heads);
      for (const trial of [0, 1, 2]) {
        const out = runMultiRace(calculator, field, { seed: 7, trial });
        expect([...gatesOf(out)].sort((a, b) => a - b)).toEqual(
          Array.from({ length: heads }, (_, i) => i + 1),
        );
        expect(out.entries.map((e) => e.order).sort((a, b) => a - b)).toEqual(
          Array.from({ length: heads }, (_, i) => i + 1),
        );
      }
    });
  }

  it('明示した枠番が重なっても、後の頭を空き枠に回して重ねない', () => {
    // 個体から選んだ相手が、自分と同じ固定枠を持っている場合にあたる。
    const field = lineupOf(9, (i) => ({ gateNumber: i === 0 || i === 4 || i === 7 ? 3 : 0 }));
    for (const trial of [0, 1, 2, 3]) {
      const out = runMultiRace(calculator, field, { seed: 7, trial });
      const gates = gatesOf(out);
      expect(new Set(gates).size).toBe(gates.length);
      expect(gates.every((g) => g >= 1 && g <= 9)).toBe(true);
      // 先の頭が枠を取る。
      expect(gates[0]).toBe(3);
    }
  });

  it('明示した枠番が重ならなければ、そのまま使う', () => {
    const field = lineupOf(9, (i) => ({ gateNumber: i === 2 ? 5 : i === 6 ? 1 : 0 }));
    const out = runMultiRace(calculator, field, { seed: 7, trial: 0 });
    const gates = gatesOf(out);
    expect(gates[2]).toBe(5);
    expect(gates[6]).toBe(1);
    expect(new Set(gates).size).toBe(9);
  });

  it('出走頭数が枠の数を超えると、同じ枠に入れずに止める', () => {
    const field = lineupOf(4).map((entry) => ({
      setting: { ...entry.setting, track: { ...track, gateCount: 3 } },
    }));
    expect(() => runMultiRace(calculator, field, { seed: 7, trial: 0 })).toThrow('枠の数');
  });

  it('18 頭では、順位率の条件を常に真とせず順位で判定する', () => {
    const field = lineupOf(18);
    const anySkill = data.skillsByName.get('末脚')![0]!;
    type Predicate = ReturnType<typeof compileConditions>;
    let front: Predicate[] = [];
    let checked = 0;
    let outside = 0;
    const out = runMultiRace(calculator, field, {
      seed: 7,
      trial: 0,
      onFrame: (frame, states) => {
        if (frame === 1) {
          front = states.map((state) =>
            compileConditions(
              anySkill,
              [[new SkillCondition('order_rate', '<=', 50)]],
              state.setting,
              new RngSet(7, 0),
              newSkillScratch(),
            ),
          );
        }
        if (frame % 60 !== 0) return;
        for (let i = 0; i < states.length; i++) {
          const state = states[i]!;
          if (state.beforeStart || state.simulation.position >= state.setting.courseLength) continue;
          // 18 頭では、順位率 50 以下は 9 位以内である。
          expect(front[i]!(state)).toBe(state.order! <= 9);
          checked++;
          if (state.order! > 9) outside++;
        }
      },
    });
    expect(checked).toBeGreaterThan(0);
    expect(outside).toBeGreaterThan(0);
    // 帯の維持も落ちる。後ろから進む追込は、順位率 20 以前を維持できない。
    const oi = out.states.find((state) => state.setting.base.uma.style === 'OI')!;
    expect(oi.simulation.specialState['order_rate_in20_continue']).toBe(0);
  });
});
