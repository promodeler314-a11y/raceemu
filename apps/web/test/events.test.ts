import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../../packages/data/src/node.ts';
import { RaceCalculator } from '../../../packages/sim/src/calculator.ts';
import { defaultSystemSetting, type RaceSetting } from '../../../packages/sim/src/setting.ts';
import { buildEvents } from '../src/events.ts';

const data = loadGameData();
const system = defaultSystemSetting();
const track = { location: 10006, course: 10606, condition: 1, gateCount: 9 } as const;

function run(skillNames: readonly string[]) {
  const setting: RaceSetting = {
    uma: {
      charaName: '', speed: 1200, stamina: 1000, power: 900, guts: 600, wisdom: 900,
      condition: 'BEST', style: 'SEN', distanceFit: 'A', surfaceFit: 'A', styleFit: 'A',
      popularity: 1, gateNumber: 5, uniqueLevel: 6,
    },
    track,
    skills: skillNames
      .map((name) => data.skillsByName.get(name)?.[0])
      .filter((s): s is NonNullable<typeof s> => s !== undefined),
    skillActivateAdjustment: 'NONE',
    randomPosition: 'RANDOM',
    debuffCounts: {},
    positionKeepMode: 'APPROXIMATE',
    positionKeepRate: 100,
  };
  const calculator = new RaceCalculator(system, data.trackData);
  const { result, state } = calculator.simulate(setting, {
    seed: 1,
    trial: 3,
    recordFrames: true,
  });
  const detail = data.trackData[track.location]!.courses[track.course]!;
  return {
    events: buildEvents(state.simulation.frames, detail, {
      raceTime: result.raceTime,
      goalSp: result.goalSp,
      spMax: state.setting.spMax,
    }),
    detail,
  };
}

describe('レースの出来事', () => {
  it('フェーズ境界が 3 つ、位置の順に出る', () => {
    const { events, detail } = run([]);
    const phases = events.filter((e) => e.kind === 'phase');
    expect(phases.map((e) => e.label)).toEqual(['中盤へ', '終盤へ', 'ラストへ']);
    expect(phases[0]!.position).toBeGreaterThanOrEqual(detail.distance / 6);
    expect(phases[0]!.position).toBeLessThan(detail.distance / 3);
  });

  it('コーナーの数だけ進入が出る', () => {
    const { events, detail } = run([]);
    expect(events.filter((e) => e.kind === 'corner')).toHaveLength(detail.corners.length);
  });

  it('最後は必ずゴールで、レースタイムと一致する', () => {
    const { events } = run([]);
    const last = events[events.length - 1]!;
    expect(last.kind).toBe('end');
    expect(last.detail).toContain('残り体力');
  });

  it('時刻が単調に増える', () => {
    const { events } = run(['弧線のプロフェッサー', '円弧のマエストロ']);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.time).toBeGreaterThanOrEqual(events[i - 1]!.time);
    }
  });

  it('持たせたスキルの発動が出る', () => {
    const { events } = run(['弧線のプロフェッサー']);
    const skills = events.filter((e) => e.kind === 'skill');
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.map((e) => e.label)).toContain('弧線のプロフェッサー');
  });

  it('スキルを持たせなければスキルの行は出ない', () => {
    const { events } = run([]);
    expect(events.filter((e) => e.kind === 'skill')).toHaveLength(0);
  });

  it('状態は立ち上がりと終わりだけを拾う（毎フレームは出さない）', () => {
    const { events } = run([]);
    const states = events.filter((e) => e.kind === 'state');
    // 数百フレームあるので、素通しなら数百行になる。
    expect(states.length).toBeLessThan(60);
    for (const event of states) {
      expect(['始まり', '終わり']).toContain(event.detail);
    }
  });
});
