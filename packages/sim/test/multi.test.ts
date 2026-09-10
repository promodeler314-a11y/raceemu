import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { RaceCalculator } from '../src/calculator.ts';
import type { Style } from '../src/data/constants.ts';
import { runMultiRace, type MultiEntry } from '../src/multi/race.ts';
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

  it('相互作用があるぶん、単独で走らせたときとは違う結果になる', () => {
    const alone = calculator.simulate(make('SEN'), { seed: 41, trial: 0 });
    const together = runMultiRace(calculator, [{ setting: make('SEN'), seed: 41 }, ...entries.slice(1)], {
      seed: 41, trial: 0,
    });
    expect(together.entries[0]!.result.raceTime).not.toBeCloseTo(alone.result.raceTime, 3);
  });
});
