import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { courseDistances, matchCourses } from '../src/data/track.ts';
import { defaultFieldProfile } from '../src/field/field.ts';
import { runCrossCourse } from '../src/parallel/cross.ts';
import { nodeWorkerFactory } from '../src/parallel/node.ts';
import { WorkerPool } from '../src/parallel/pool.ts';
import { toSerializable } from '../src/parallel/protocol.ts';
import { defaultSystemSetting, type RaceSetting } from '../src/setting.ts';

const data = loadGameData();
const system = defaultSystemSetting();

const setting: RaceSetting = {
  uma: {
    charaName: 'T',
    speed: 1200,
    stamina: 1000,
    power: 900,
    guts: 600,
    wisdom: 900,
    condition: 'BEST',
    style: 'SEN',
    distanceFit: 'A',
    surfaceFit: 'A',
    styleFit: 'A',
    popularity: 1,
    gateNumber: 0,
    uniqueLevel: 6,
  },
  track: { location: 10006, course: 10606, condition: 1, gateCount: 9 },
  skills: [],
  skillActivateAdjustment: 'NONE',
  randomPosition: 'RANDOM',
  debuffCounts: {},
  positionKeepMode: 'APPROXIMATE',
  positionKeepRate: 100,
};

describe('コースの絞り込み', () => {
  it('距離とバ場でコースを引ける', () => {
    const courses = matchCourses(data.trackData, { surface: 1, distance: 2000 });
    expect(courses.length).toBeGreaterThan(1);
    for (const course of courses) {
      expect(course.detail.surface).toBe(1);
      expect(course.detail.distance).toBe(2000);
    }
    // 同じレース場の内回りと外回りは別のコースとして並ぶ。
    const niigata = courses.filter((course) => course.locationName === '新潟');
    expect(niigata.length).toBe(2);
  });

  it('距離帯で引くと複数の距離が混ざる', () => {
    const courses = matchCourses(data.trackData, { surface: 1, distanceCategory: 'MIDDLE' });
    const distances = new Set(courses.map((course) => course.detail.distance));
    expect(distances.size).toBeGreaterThan(1);
    for (const course of courses) expect(course.detail.distanceCategory).toBe('MIDDLE');
  });

  it('ぴったりの距離を指定したら距離帯は見ない', () => {
    const courses = matchCourses(data.trackData, {
      surface: 1,
      distance: 1200,
      distanceCategory: 'LONG',
    });
    expect(courses.length).toBeGreaterThan(0);
    for (const course of courses) expect(course.detail.distance).toBe(1200);
  });

  /**
   * 並びが動くと、走らせ直すたびに表の行が入れ替わって読めなくなる。
   */
  it('並びは距離、レース場、コースの順に決まる', () => {
    const courses = matchCourses(data.trackData, { surface: 2, distanceCategory: 'MILE' });
    const keys = courses.map((course) => [course.detail.distance, course.location, course.course]);
    const sorted = [...keys].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!);
    expect(keys).toEqual(sorted);
  });

  it('当たるコースが無ければ空になる', () => {
    expect(matchCourses(data.trackData, { surface: 2, distance: 3600 })).toEqual([]);
  });

  it('バ場ごとの距離の一覧は昇順で重複しない', () => {
    const distances = courseDistances(data.trackData, 1);
    expect(distances).toEqual([...new Set(distances)].sort((a, b) => a - b));
    expect(distances).toContain(2400);
    // ダートにしか無い距離は芝の一覧に出ない。
    expect(courseDistances(data.trackData, 2)).toContain(1150);
    expect(distances).not.toContain(1150);
  });
});

describe('コース横断の評価', () => {
  it('当たるコースのぶんだけ行が返り、並びは絞り込みと同じ', async () => {
    const courses = matchCourses(data.trackData, { surface: 1, distance: 3000 });
    const pool = new WorkerPool(nodeWorkerFactory, 2);
    try {
      const { rows, cancelled } = await runCrossCourse(
        pool,
        toSerializable(setting),
        system,
        courses,
        { count: 40, seed: 1 },
      );
      expect(cancelled).toBe(false);
      expect(rows.length).toBe(courses.length);
      expect(rows.map((row) => row.course)).toEqual(courses.map((course) => course.course));
      for (const row of rows) {
        expect(row.distance).toBe(3000);
        expect(row.summary.all.count).toBe(40);
        expect(row.summary.all.averageTime).toBeGreaterThan(0);
      }
    } finally {
      await pool.dispose();
    }
  });

  /**
   * 走らせ直したときに行が動かないことは、この面の前提である。
   * 束はコースごとに作り直すが、鍵から決まるので同じ指定なら同じ束になる。
   */
  it('同じ指定なら何度走らせても同じ値になる', async () => {
    const courses = matchCourses(data.trackData, { surface: 1, distance: 3200 });
    const pool = new WorkerPool(nodeWorkerFactory, 2);
    try {
      const options = { count: 30, seed: 7 };
      const first = await runCrossCourse(pool, toSerializable(setting), system, courses, options);
      const second = await runCrossCourse(pool, toSerializable(setting), system, courses, options);
      expect(second.rows.map((row) => row.summary.all.averageTime)).toEqual(
        first.rows.map((row) => row.summary.all.averageTime),
      );
    } finally {
      await pool.dispose();
    }
  });

  it('走らせる前に止めたら 1 行も返さない', async () => {
    const courses = matchCourses(data.trackData, { surface: 1, distance: 3200 });
    const pool = new WorkerPool(nodeWorkerFactory, 2);
    const controller = new AbortController();
    controller.abort();
    try {
      const { rows, cancelled } = await runCrossCourse(
        pool,
        toSerializable(setting),
        system,
        courses,
        { count: 30, seed: 1, signal: controller.signal },
      );
      expect(cancelled).toBe(true);
      expect(rows).toEqual([]);
    } finally {
      await pool.dispose();
    }
  });

  /**
   * 順位条件ありでも走ること。束はコースごとに作り直すので、
   * コースを差し替えたときに束の指定も一緒に動いていないと、
   * 別のコースの位置の時系列で順位を判定してしまう。
   */
  it('順位条件を判定しても、コースごとの束で走る', async () => {
    const courses = matchCourses(data.trackData, { surface: 1, distance: 3000 });
    const pool = new WorkerPool(nodeWorkerFactory, 2);
    try {
      const { rows } = await runCrossCourse(pool, toSerializable(setting), system, courses, {
        count: 20,
        seed: 1,
        field: {
          profile: defaultFieldProfile(9),
          seed: 9001,
          samples: 4,
        },
      });
      expect(rows.length).toBe(courses.length);
      for (const row of rows) expect(row.summary.all.averageTime).toBeGreaterThan(0);
    } finally {
      await pool.dispose();
    }
  });
});
