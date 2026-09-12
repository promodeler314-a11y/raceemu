import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { RaceCalculator } from '../src/calculator.ts';
import {
  buildFieldBundle,
  defaultFieldProfile,
  fixedFieldProfile,
  opponentSettings,
  RecordedField,
} from '../src/field/field.ts';
import { opponentSkillPool } from '../src/field/opponent-skills.ts';
import { defaultSystemSetting, type RaceSetting, type UmaStatus } from '../src/setting.ts';

/**
 * 相手の想定（docs/order-field.md 4.3 節）の検査。
 *
 * 見るのは「相手の分布として振る舞っているか」である。
 * 個々の値が本家と一致するかは、そもそも本家に相手の想定が無いので問えない。
 */

const data = loadGameData();
const system = defaultSystemSetting();
const track = { location: 10006, course: 10606, condition: 1, gateCount: 9 } as const;
const pool = opponentSkillPool(data.skillsById);

const self: UmaStatus = {
  charaName: '',
  speed: 1400,
  stamina: 1100,
  power: 1100,
  guts: 900,
  wisdom: 1100,
  condition: 'BEST',
  style: 'SEN',
  distanceFit: 'A',
  surfaceFit: 'A',
  styleFit: 'A',
  popularity: 1,
  gateNumber: 5,
  uniqueLevel: 6,
};

const settingOf = (uma: UmaStatus): RaceSetting => ({
  uma,
  track,
  skills: [],
  skillActivateAdjustment: 'NONE',
  randomPosition: 'RANDOM',
  debuffCounts: {},
  positionKeepMode: 'APPROXIMATE',
  positionKeepRate: 100,
});

describe('相手の想定', () => {
  it('自分と同格にすると、自分のステータスが相手にも写る', () => {
    const profile = { ...defaultFieldProfile(9), sigma: 0, redrawComposition: false };
    const settings = opponentSettings(profile, track, { self, sample: 0 });
    expect(settings).toHaveLength(8);
    for (const setting of settings) {
      expect(setting.uma.speed).toBe(self.speed);
      expect(setting.uma.stamina).toBe(self.stamina);
      expect(setting.uma.wisdom).toBe(self.wisdom);
    }
  });

  it('強さの上下は基準にそのまま足される', () => {
    const profile = { ...defaultFieldProfile(9), sigma: 0, redrawComposition: false, offset: -100 };
    const settings = opponentSettings(profile, track, { self, sample: 0 });
    expect(settings[0]!.uma.speed).toBe(self.speed - 100);
    expect(settings[0]!.uma.guts).toBe(self.guts - 100);
  });

  it('自分が渡らなければ基準のステータスのままになる', () => {
    const profile = defaultFieldProfile(9);
    const settings = opponentSettings(profile, track, { sample: 0 });
    // 引き直しは効くので、基準からのずれは σ の範囲に収まっていればよい。
    for (const setting of settings) {
      expect(Math.abs(setting.uma.speed - profile.uma.speed)).toBeLessThan(4 * profile.sigma!);
    }
  });

  it('ばらつきを入れると相手が同一でなくなる', () => {
    const settings = opponentSettings(defaultFieldProfile(9), track, { self, sample: 0 });
    const speeds = new Set(settings.map((setting) => setting.uma.speed));
    expect(speeds.size).toBeGreaterThan(1);
  });

  it('固定の想定は引き直さず、全頭が同じになる', () => {
    const settings = opponentSettings(fixedFieldProfile(9), track, { self, sample: 3 });
    const speeds = new Set(settings.map((setting) => setting.uma.speed));
    expect(speeds.size).toBe(1);
    expect(settings[0]!.uma.speed).toBe(1100);
    expect(settings[0]!.skills).toHaveLength(0);
  });

  it('束の 1 本ごとに脚質構成が変わる', () => {
    const profile = defaultFieldProfile(9);
    const shapes = new Set<string>();
    for (let sample = 0; sample < 16; sample++) {
      const settings = opponentSettings(profile, track, { self, sample });
      expect(settings).toHaveLength(8);
      shapes.add(settings.map((setting) => setting.uma.style).join(','));
    }
    expect(shapes.size).toBeGreaterThan(1);
  });

  it('相手に持たせるスキルは 5 個から 8 個で、脚質に噛み合ったものが混じる', () => {
    const settings = opponentSettings(defaultFieldProfile(9), track, { self, sample: 0, skillPool: pool });
    for (const setting of settings) {
      expect(setting.skills.length).toBeGreaterThanOrEqual(5);
      expect(setting.skills.length).toBeLessThanOrEqual(8);
    }
    const nige = settings.find((setting) => setting.uma.style === 'NIGE');
    if (nige !== undefined) {
      const names = new Set(pool.NIGE.map((skill) => skill.name));
      for (const skill of nige.skills) expect(names.has(skill.name)).toBe(true);
    }
  });

  it('引き当て表を渡さなければスキルは持たない', () => {
    const settings = opponentSettings(defaultFieldProfile(9), track, { self, sample: 0 });
    for (const setting of settings) expect(setting.skills).toHaveLength(0);
  });

  it('自己整合は、一部の相手にだけ自分の構成を配る', () => {
    const mix = ['200331', '200332'].filter((id) => data.skillsById.has(id));
    const ids = mix.length >= 2 ? mix : [...data.skillsById.keys()].slice(0, 2);
    const profile = { ...defaultFieldProfile(9), mixSkillIds: ids, mixRate: 0.3 };
    const settings = opponentSettings(profile, track, {
      self,
      sample: 0,
      skillPool: pool,
      skillsById: data.skillsById,
    });
    const carriers = settings.filter((setting) =>
      ids.every((id) => setting.skills.some((skill) => skill.id === id)),
    );
    // 全員に配ると相手が一様に強くなるだけなので、一部で止まっていることを見る。
    expect(carriers.length).toBeGreaterThan(0);
    expect(carriers.length).toBeLessThan(settings.length);
  });

  it('配る割合が 0 なら誰にも配らない', () => {
    const ids = [...data.skillsById.keys()].slice(0, 2);
    const profile = { ...defaultFieldProfile(9), mixSkillIds: ids, mixRate: 0 };
    const settings = opponentSettings(profile, track, {
      self,
      sample: 0,
      skillPool: pool,
      skillsById: data.skillsById,
    });
    for (const setting of settings) {
      for (const id of ids) expect(setting.skills.some((skill) => skill.id === id)).toBe(false);
    }
  });

  it('引き当て表を渡さなければ自己整合は効かない', () => {
    const ids = [...data.skillsById.keys()].slice(0, 2);
    const profile = { ...defaultFieldProfile(9), mixSkillIds: ids, mixRate: 1 };
    const settings = opponentSettings(profile, track, { self, sample: 0, skillPool: pool });
    for (const setting of settings) {
      for (const id of ids) expect(setting.skills.some((skill) => skill.id === id)).toBe(false);
    }
  });

  it('同じ指定なら同じ束になる', () => {
    const build = () =>
      buildFieldBundle(defaultFieldProfile(9), track, system, data.trackData, {
        samples: 2,
        seed: 99,
        self,
        skillPool: pool,
      });
    const a = build();
    const b = build();
    expect(a.samples[0]!.frames).toBe(b.samples[0]!.frames);
    expect([...a.samples[0]!.positions]).toEqual([...b.samples[0]!.positions]);
    expect(a.samples[1]!.styles).toEqual(b.samples[1]!.styles);
  });

  it('自分を強くすると相手も強くなり、順位は張り付かない', () => {
    // 相手を固定したままでは、強い自分は最初から最後まで先頭にいる。
    // 同格にすれば、同じ自分でも順位が散る。docs/order-field.md 2.1 節。
    const calculator = new RaceCalculator(system, data.trackData);
    const courseLength = data.trackData[track.location]!.courses[track.course]!.distance;
    const ordersFor = (profile: ReturnType<typeof defaultFieldProfile>): number[] => {
      const bundle = buildFieldBundle(profile, track, system, data.trackData, {
        samples: 8,
        seed: 99,
        self,
        skillPool: pool,
      });
      const orders: number[] = [];
      for (let trial = 0; trial < 24; trial++) {
        const { state } = calculator.simulate(settingOf(self), {
          seed: 7,
          trial,
          recordFrames: true,
          field: bundle,
        });
        const view = new RecordedField(bundle, trial);
        const mark = (courseLength * 2) / 3;
        const at = state.simulation.frames.findIndex((frame) => frame.startPosition >= mark);
        const frame = state.simulation.frames[at < 0 ? state.simulation.frames.length - 1 : at]!;
        orders.push(view.order(at < 0 ? state.simulation.frames.length - 1 : at, frame.startPosition));
      }
      return orders;
    };
    const fixed = new Set(ordersFor(fixedFieldProfile(9)));
    const drawn = new Set(ordersFor(defaultFieldProfile(9)));
    expect(fixed.size).toBeLessThanOrEqual(drawn.size);
    expect(drawn.size).toBeGreaterThanOrEqual(3);
  });
});
