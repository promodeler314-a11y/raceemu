import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { gateNumberRange, RaceCalculator } from '../src/calculator.ts';
import type { Style } from '../src/data/constants.ts';
import { runMultiRace, type MultiEntry } from '../src/multi/race.ts';
import { replayMultiRace } from '../src/multi/replay.ts';
import { OrderTally } from '../src/multi/summary.ts';
import { nodeWorkerFactory } from '../src/parallel/node.ts';
import { WorkerPool } from '../src/parallel/pool.ts';
import { MULTI_FIELDS, toSerializable, unpackMultiEntry } from '../src/parallel/protocol.ts';
import { defaultSystemSetting, type RaceSetting } from '../src/setting.ts';

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

  describe('内枠と外枠の指定', () => {
    const gatesOf = (list: readonly MultiEntry[], trial: number, gateCount = 9) => {
      const withCount = list.map((entry) => ({
        ...entry,
        setting: { ...entry.setting, track: { ...track, gateCount } },
      }));
      return runMultiRace(calculator, withCount, { seed: 7, trial }).states
        .map((s) => s.setting.base.uma.gateNumber);
    };

    it('抽選の範囲が本家（maxBy は条件を満たす最初の枠を返す）と同じになる', () => {
      expect(gateNumberRange(-1, 9)).toEqual([1, 3]);
      expect(gateNumberRange(-2, 9)).toEqual([6, 9]);
      expect(gateNumberRange(-1, 12)).toEqual([1, 3]);
      expect(gateNumberRange(-2, 12)).toEqual([7, 12]);
      expect(gateNumberRange(-2, 18)).toEqual([11, 18]);
      expect(gateNumberRange(0, 9)).toEqual([1, 9]);
      expect(gateNumberRange(4, 9)).toBeNull();
    });

    it('9 頭では内枠が 1〜3、外枠が 6〜9 に入り、重ならない', () => {
      // 固定の 2 番と 7 番が範囲の枠を 1 つずつ塞いでいても、残りの範囲から配る
      const wishes = [-1, -1, -2, -2, 0, 0, 2, 7, 0];
      const list = lineup.map((style, i) => ({ setting: make(style, { gateNumber: wishes[i]! }) }));
      for (let trial = 0; trial < 8; trial++) {
        const gates = gatesOf(list, trial);
        expect(new Set(gates).size).toBe(gates.length);
        expect(gates[6]).toBe(2);
        expect(gates[7]).toBe(7);
        for (const i of [0, 1]) expect(gates[i]).toBeLessThanOrEqual(3);
        for (const i of [2, 3]) expect(gates[i]).toBeGreaterThanOrEqual(6);
      }
    });

    it('12 頭では外枠が 7〜12 に入る', () => {
      const list: MultiEntry[] = Array.from({ length: 12 }, (_, i) => ({
        setting: make(lineup[i % lineup.length]!, { gateNumber: i < 4 ? -2 : 0 }),
      }));
      for (let trial = 0; trial < 4; trial++) {
        const gates = gatesOf(list, trial, 12);
        expect(new Set(gates).size).toBe(12);
        for (let i = 0; i < 4; i++) {
          expect(gates[i]).toBeGreaterThanOrEqual(7);
          expect(gates[i]).toBeLessThanOrEqual(12);
        }
      }
    });

    it('範囲の枠が足りなければ、あふれた頭は範囲外の空き枠に回り重ならない', () => {
      const list = lineup.map((style, i) => ({ setting: make(style, { gateNumber: i < 4 ? -1 : 0 }) }));
      const gates = gatesOf(list, 1);
      expect(new Set(gates).size).toBe(gates.length);
      expect(gates.slice(0, 4).filter((g) => g <= 3)).toHaveLength(3);
    });
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
