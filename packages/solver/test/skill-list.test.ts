import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { nodeWorkerFactory } from '../../sim/src/parallel/node.ts';
import { WorkerPool } from '../../sim/src/parallel/pool.ts';
import { DerivedSetting, defaultSystemSetting, emptyPassiveBonus } from '../../sim/src/setting.ts';
import { canTrigger } from '../src/screen.ts';
import {
  SKILL_LIST_FORMAT,
  STAMINA_CAP,
  STAMINA_MARGIN,
  isSkillListCourseFile,
  isSkillListIndex,
  skillListCourseKey,
  skillListRowAt,
  type SkillListCourseFile,
  type SkillListDataset,
  type SkillListIndexEntry,
  type SkillListSettings,
} from '../src/skill-list.ts';
import {
  SKILL_LIST_INDEX_NAME,
  collectSkillListCourses,
  nextSkillListIndex,
  readSkillListIndex,
  updateSkillListIndex,
  writeSkillListCourse,
} from '../src/skill-list-index.ts';
import {
  allSkillListCourses,
  buildRaceSetting,
  planSkillListCourse,
  purchasableSkills,
  runSkillListCourse,
  selectCourses,
  shardCourses,
  type SkillListOptions,
} from '../src/skill-list-run.ts';
import {
  baselinePolicy,
  baselinesFor,
  hasStamina,
  loadStaminaTable,
  saveStaminaTable,
  staminaDemandFor,
} from '../src/skill-list-stamina.ts';
import {
  fieldProfileFingerprint,
  gitBlobSha1,
  raceModelFingerprint,
  skillListVersion,
  stableStringify,
} from '../src/skill-list-version.ts';

const data = loadGameData();
const system = defaultSystemSetting();
const pool = new WorkerPool(nodeWorkerFactory, 2);

afterAll(async () => {
  await pool.dispose();
});

describe('版の識別子', () => {
  it('git の blob SHA-1 と同じ値になる', () => {
    // `git hash-object` が返す値。空のファイルと "hello\n" は広く知られた定数である。
    expect(gitBlobSha1('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(gitBlobSha1('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('同じ入力なら同じ版になる', () => {
    const dataset = {
      skills: 'a'.repeat(40),
      courses: 'b'.repeat(40),
      raceModel: 'c'.repeat(40),
      fieldProfile: 'd'.repeat(40),
      baseline: 'e'.repeat(40),
    };
    expect(skillListVersion(dataset)).toBe(skillListVersion({ ...dataset }));
    // 鍵の並びが違っても同じ
    const reordered = {
      baseline: dataset.baseline,
      fieldProfile: dataset.fieldProfile,
      raceModel: dataset.raceModel,
      courses: dataset.courses,
      skills: dataset.skills,
    };
    expect(skillListVersion(reordered)).toBe(skillListVersion(dataset));
  });

  it('材料が 1 つでも動けば版が変わる', () => {
    const dataset = {
      skills: 'a'.repeat(40),
      courses: 'b'.repeat(40),
      raceModel: 'c'.repeat(40),
      fieldProfile: 'd'.repeat(40),
      baseline: 'e'.repeat(40),
    };
    const base = skillListVersion(dataset);
    for (const key of ['skills', 'courses', 'raceModel', 'fieldProfile', 'baseline'] as const) {
      // 置き換える値は見本のどれとも違うものにする（同じだと差し替えにならない）。
      expect(skillListVersion({ ...dataset, [key]: 'z'.repeat(40) })).not.toBe(base);
    }
  });

  it('形の版が変われば版の文字列も変わる。古い版と並べても取り違えない', () => {
    const dataset = {
      skills: 'a'.repeat(40),
      courses: 'b'.repeat(40),
      raceModel: 'c'.repeat(40),
      fieldProfile: 'd'.repeat(40),
      baseline: 'e'.repeat(40),
    };
    expect(skillListVersion(dataset)).toMatch(new RegExp(`^v${SKILL_LIST_FORMAT}-`));
    expect(skillListVersion(dataset, 1)).not.toBe(skillListVersion(dataset, 2));
  });

  it('計算に関わらないファイルが動いても計算側の指紋は変わらない', () => {
    const files = {
      'race/build.gradle.kts': '1'.repeat(40),
      'race/src/commonMain/kotlin/io/github/mee1080/umasim/race/data/rawData.kt': '2'.repeat(40),
      'race/src/commonMain/kotlin/io/github/mee1080/umasim/race/calc2/RaceCalculator.kt': '3'.repeat(40),
    };
    const before = raceModelFingerprint({ files });
    expect(
      raceModelFingerprint({
        files: { ...files, 'race/build.gradle.kts': '9'.repeat(40) },
      }),
    ).toBe(before);
    expect(
      raceModelFingerprint({
        files: {
          ...files,
          'race/src/commonMain/kotlin/io/github/mee1080/umasim/race/calc2/RaceCalculator.kt':
            '9'.repeat(40),
        },
      }),
    ).not.toBe(before);
  });

  it('相手の分布の指紋は鍵の並びに依らない', () => {
    const profile = { a: 1, b: { d: 2, c: 3 } } as unknown as Parameters<
      typeof fieldProfileFingerprint
    >[0];
    const reordered = { b: { c: 3, d: 2 }, a: 1 } as unknown as typeof profile;
    expect(stableStringify(profile)).toBe(stableStringify(reordered));
    expect(fieldProfileFingerprint(profile)).toBe(fieldProfileFingerprint(reordered));
  });
});

describe('対象のコース', () => {
  const courses = allSkillListCourses(data);

  it('距離帯の代表ではなく全コースを数え上げる', () => {
    // 芝とダートで 137 本ある。距離帯 4 × バ場 2 の 8 本ではない。
    expect(courses.length).toBe(137);
    expect(new Set(courses.map((c) => c.location)).size).toBeGreaterThan(1);
    // 同じ距離帯に複数のコースが並ぶことが、この表の存在理由である。
    const turfMiddle = courses.filter((c) => c.surface === 1 && c.category === 'MIDDLE');
    expect(turfMiddle.length).toBeGreaterThan(8);
  });

  it('並びは場 → バ場 → 距離で、呼ぶたびに変わらない', () => {
    // 選択欄の並びがここで決まり、分割（shardCourses）もこの並びに乗る。
    expect(allSkillListCourses(data)).toEqual(courses);
    const rank = (c: (typeof courses)[number]) => [c.location, c.surface, c.distance, c.course];
    for (let i = 1; i < courses.length; i++) {
      const a = rank(courses[i - 1]!);
      const b = rank(courses[i]!);
      const first = a.findIndex((value, k) => value !== b[k]);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(a[first]!).toBeLessThan(b[first]!);
    }
  });

  it('鍵で 1 本だけ指せる', () => {
    const picked = selectCourses(courses, { keys: ['10006-10606'] });
    expect(picked.length).toBe(1);
    expect(picked[0]!.locationName).toBe('東京');
    expect(picked[0]!.distance).toBe(2400);
  });

  it('絞り込みは重ねると狭くなる', () => {
    const turf = selectCourses(courses, { surfaces: [1] });
    const turfMiddle = selectCourses(courses, { surfaces: [1], categories: ['MIDDLE'] });
    expect(turf.length).toBeLessThan(courses.length);
    expect(turfMiddle.length).toBeLessThan(turf.length);
    expect(turfMiddle.every((c) => c.surface === 1 && c.category === 'MIDDLE')).toBe(true);
    // 指定しない軸は素通しにする（空配列と undefined を同じに扱う）
    expect(selectCourses(courses, { surfaces: [] })).toEqual(courses);
  });

  it('分割は重なりも漏れも無く、どの分片もほぼ同じ本数になる', () => {
    const count = 8;
    const shards = Array.from({ length: count }, (_, i) => shardCourses(courses, i, count));
    const all = shards.flat();
    expect(all.length).toBe(courses.length);
    expect(new Set(all.map((c) => skillListCourseKey(c.location, c.course))).size).toBe(
      courses.length,
    );
    const sizes = shards.map((shard) => shard.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    // 飛ばし飛ばしに取るので、1 つの分片が長距離に偏らない
    for (const shard of shards) {
      expect(new Set(shard.map((c) => c.location)).size).toBeGreaterThan(1);
    }
  });
});

describe('基準個体', () => {
  const courses = allSkillListCourses(data);
  const tokyo2400 = selectCourses(courses, { keys: ['10006-10606'] })[0]!;

  it('リポジトリに置いてある表が全コースぶんそろっている', () => {
    const table = loadStaminaTable();
    expect(table).not.toBeNull();
    const missing = courses.filter((course) => !hasStamina(course, table));
    expect(missing.map((c) => skillListCourseKey(c.location, c.course))).toEqual([]);
  });

  it('段は normal と strong の 2 つだけで、強いほうが速さ・パワー・根性・賢さで上回る', () => {
    const [normal, strong] = baselinesFor(tokyo2400);
    expect([normal!.id, strong!.id]).toEqual(['normal', 'strong']);
    expect(strong!.speed).toBeGreaterThan(normal!.speed);
    expect(strong!.power).toBeGreaterThan(normal!.power);
    expect(strong!.guts).toBeGreaterThan(normal!.guts);
    expect(strong!.wisdom).toBeGreaterThan(normal!.wisdom);
  });

  it('スタミナはどのコースでも両段とも上限である', () => {
    // **ここが表の読み方を決める。** ぎりぎり最大スパートに届く個体にすると、
    // スタミナ 1 点の値打ちが他のどの効果より大きくなり、上位が回復スキルで埋まる
    // （実測で芝中距離 99.8 %）。いまのゲームではスタミナは足りるものなので、
    // 上限に置いて「足りている個体」の話にする。
    for (const course of [tokyo2400, ...courses.slice(0, 20)]) {
      for (const baseline of baselinesFor(course)) {
        expect(baseline.stamina, `${skillListCourseKey(course.location, course.course)}`).toBe(
          STAMINA_CAP,
        );
      }
    }
  });

  it('段はスタミナで分かれない（強さの軸だけを持つ）', () => {
    const [normal, strong] = baselinesFor(tokyo2400);
    expect(strong!.stamina).toBe(normal!.stamina);
  });

  it('コースが要るスタミナは、基準個体とは別に読める', () => {
    const table = loadStaminaTable();
    // 京都 芝3000m(外) は上限でも五分に届かない。そこで回復が上位に来るのは
    // モデルの都合ではなくコースの性質である、と画面が言えるようにしておく。
    const kyoto3000 = selectCourses(courses, { keys: ['10008-10810'] })[0]!;
    const long = staminaDemandFor(kyoto3000, table)!;
    expect(long.p50).toBeGreaterThan(STAMINA_CAP);

    const middle = staminaDemandFor(tokyo2400, table)!;
    expect(middle.p50).toBeLessThan(STAMINA_CAP);
    // 上限との余裕で「縛りになっているか」が決まる。上限を超えるかどうかではない
    // （札幌 芝2600m は p90 が 1150 で上限内だが、余裕は 50 しかなく回復が上位に来る）。
    expect(STAMINA_CAP - long.p90).toBeLessThan(STAMINA_MARGIN);
    expect(STAMINA_CAP - middle.p90).toBeGreaterThanOrEqual(STAMINA_MARGIN);

    // 測っていないコースでは無い、と言えること。
    expect(staminaDemandFor(tokyo2400, null)).toBeNull();
  });

  it('基準個体の決め方が版に混ざっている', () => {
    // **混ぜないと、基準を変えても版が同じままになる。** 表の値は全部変わるのに
    // スキルデータもコースデータも計算式も動いていないので、取り違えに気付けない。
    const dataset = {
      skills: 'a', courses: 'b', raceModel: 'c', fieldProfile: 'd', baseline: 'e',
    };
    expect(skillListVersion(dataset)).not.toBe(skillListVersion({ ...dataset, baseline: 'f' }));
    expect(baselinePolicy()).toContain(String(STAMINA_CAP));
  });

  it('書き足しても、前に測ったコースは消えない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-list-stamina-'));
    const path = join(dir, 'stamina.json');
    const settings = {
      trials: 200, seed: 1, gateCount: 9, trackCondition: 1, from: 200, to: 1600, step: 5,
    };
    try {
      saveStaminaTable({ 'a-1': { normal: 300, strong: 400, unreached: 0 } }, settings, path);
      const second = saveStaminaTable(
        { 'b-2': { normal: 500, strong: 600, unreached: 0 } },
        settings,
        path,
      );
      expect(Object.keys(second.courses)).toEqual(['a-1', 'b-2']);
      expect(loadStaminaTable(path)?.courses['a-1']?.normal).toBe(300);
      // 同じ鍵をもう一度測ったら上書きする
      const third = saveStaminaTable(
        { 'a-1': { normal: 999, strong: 999, unreached: 0 } },
        settings,
        path,
      );
      expect(third.courses['a-1']!.normal).toBe(999);
      expect(Object.keys(third.courses)).toEqual(['a-1', 'b-2']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('無い・壊れている 1 枚は null として読む', () => {
    expect(loadStaminaTable(join(tmpdir(), 'ありえないパス.json'))).toBeNull();
  });
});

describe('事前計算', () => {
  const stamina = loadStaminaTable();
  const course = selectCourses(allSkillListCourses(data), { keys: ['10005-10501'] })[0]!;
  const options: SkillListOptions = {
    trials: 20,
    seed: 1,
    gateCount: 9,
    trackCondition: 1,
    useField: false,
    samples: 16,
    styles: ['SEN'],
    baselineIds: ['normal'],
    maxSkills: 4,
    stamina,
  };

  it('走らせずに落とした数が screen.ts の判定と合う', async () => {
    const baseline = baselinesFor(course)[0]!;
    const setting = buildRaceSetting(course, 'SEN', baseline, options);
    const derived = new DerivedSetting(setting, emptyPassiveBonus(), data.trackData);
    const expected = purchasableSkills(data).filter((skill) => !canTrigger(skill, derived)).length;

    // 数え上げだけの口と、実際に走らせた結果の両方が同じ数を返すこと。
    expect(planSkillListCourse(data, course, options).screenedOut).toBe(expected);
    const body = await runSkillListCourse(pool, data, system, course, options);
    expect(body.screenedOut).toBe(expected);
    // 打ち切りは「測っていない」であって「発動しない」ではないので、落とした数には入らない。
    expect(body.columns.length).toBe(4);
  });

  it('列の形から行に戻せる', async () => {
    const body = await runSkillListCourse(pool, data, system, course, options);
    const file: SkillListCourseFile = {
      format: SKILL_LIST_FORMAT,
      version: 'test',
      generatedAt: new Date(0).toISOString(),
      dataset: { skills: '', courses: '', raceModel: '', fieldProfile: '', baseline: '' },
      ...body,
    };
    expect(isSkillListCourseFile(file)).toBe(true);
    expect(file.columns.length).toBeGreaterThan(0);
    // 1 枚が 1 コースなので、コースは列ではなく 1 か所に持つ
    expect(file.course.course).toBe(course.course);
    expect('course' in file.columns).toBe(false);
    // すべての列が同じ長さである
    for (const column of [
      file.columns.skill, file.columns.baseline, file.columns.style,
      file.columns.mean, file.columns.stdError, file.columns.triggerRate,
      file.columns.meanWhenTriggered, file.columns.cost, file.columns.fidelity,
    ]) {
      expect(column.length).toBe(file.columns.length);
    }

    const skills = purchasableSkills(data);
    for (let i = 0; i < file.columns.length; i++) {
      const row = skillListRowAt(file, i);
      const skill = skills.find((s) => s.id === row.skillId);
      expect(skill).toBeDefined();
      expect(row.baseline).toBe('normal');
      expect(row.style).toBe('SEN');
      expect(['exact', 'approximate', 'dropped']).toContain(row.fidelity);
      // 費用は表示どおりの総額。割引は当てていない。
      expect(row.cost).toBe(skill!.sp);
      expect(row.efficiency).toBeCloseTo(row.cost === 0 ? 0 : row.mean / row.cost, 9);
      expect(row.triggerRate).toBeGreaterThanOrEqual(0);
      expect(row.triggerRate).toBeLessThanOrEqual(1);
      // 発動しない行は、共通乱数により差も厳密に 0 になる。
      if (row.triggerRate === 0) {
        expect(row.mean).toBe(0);
        expect(row.meanWhenTriggered).toBe(0);
      }
    }
  });

  it('同じ指定なら同じ表になる', async () => {
    const first = await runSkillListCourse(pool, data, system, course, options);
    const second = await runSkillListCourse(pool, data, system, course, options);
    expect(second.columns.mean).toEqual(first.columns.mean);
    expect(second.columns.triggerRate).toEqual(first.columns.triggerRate);
  });

  it('コースが違えば値も違う。距離帯で畳んではならない', async () => {
    // 同じ距離帯（芝中距離）の別のコース。畳んでよいなら、ここが同じになるはずである。
    const [a, b] = [
      selectCourses(allSkillListCourses(data), { keys: ['10006-10606'] })[0]!,
      selectCourses(allSkillListCourses(data), { keys: ['10006-10604'] })[0]!,
    ];
    expect(a.category).toBe(b.category);
    expect(a.surface).toBe(b.surface);
    const wide: SkillListOptions = { ...options, maxSkills: 12 };
    const first = await runSkillListCourse(pool, data, system, a, wide);
    const second = await runSkillListCourse(pool, data, system, b, wide);
    expect(second.columns.mean).not.toEqual(first.columns.mean);
  });
});

describe('版とコースの一覧', () => {
  const dataset: SkillListDataset = {
    skills: 'a', courses: 'b', raceModel: 'c', fieldProfile: 'd', baseline: 'e',
  };
  const settings: SkillListSettings = {
    trials: 200, useField: true, gateCount: 9, seed: 1, trackCondition: 1,
  };
  const entry = (location: number, course: number, version = 'v2-aaa'): SkillListIndexEntry => ({
    course: {
      location, course,
      locationName: '場', courseName: `芝${course}m`,
      distance: 2000, surface: 1, category: 'MIDDLE',
    },
    file: `${version}/${skillListCourseKey(location, course)}.json`,
    rows: 10,
    trials: 200,
    generatedAt: new Date(0).toISOString(),
  });

  it('無いところに作ると、いま測ったコースだけが載る', () => {
    const index = nextSkillListIndex(null, {
      version: 'v2-aaa', dataset, settings, entries: [entry(1, 2)],
    });
    expect(isSkillListIndex(index)).toBe(true);
    expect(index.courses.length).toBe(1);
    expect(index.generations).toEqual(['v2-aaa']);
  });

  it('同じ版なら足していく。分けて回したぶんが積み上がる', () => {
    const first = nextSkillListIndex(null, {
      version: 'v2-aaa', dataset, settings, entries: [entry(1, 2)],
    });
    const second = nextSkillListIndex(first, {
      version: 'v2-aaa', dataset, settings, entries: [entry(1, 3)],
    });
    expect(second.courses.map((e) => e.course.course)).toEqual([2, 3]);
    // 同じコースをもう一度測ったら置き換わり、二重に並ばない
    const again = nextSkillListIndex(second, {
      version: 'v2-aaa', dataset, settings, entries: [{ ...entry(1, 2), rows: 99 }],
    });
    expect(again.courses.length).toBe(2);
    expect(again.courses.find((e) => e.course.course === 2)!.rows).toBe(99);
  });

  it('版が変われば前のコースは引き継がない。値を混ぜてはならない', () => {
    const first = nextSkillListIndex(null, {
      version: 'v2-aaa', dataset, settings, entries: [entry(1, 2), entry(1, 3)],
    });
    const second = nextSkillListIndex(first, {
      version: 'v2-bbb', dataset, settings, entries: [entry(1, 4, 'v2-bbb')],
    });
    expect(second.courses.map((e) => e.course.course)).toEqual([4]);
    // 入れ替えの最中に古い画面が取りに来るので、前の版は 1 世代だけ残す
    expect(second.generations).toEqual(['v2-bbb', 'v2-aaa']);
    const third = nextSkillListIndex(second, {
      version: 'v2-ccc', dataset, settings, entries: [],
    });
    expect(third.generations).toEqual(['v2-ccc', 'v2-bbb']);
  });

  it('壊れた 1 枚は作り直す', () => {
    const next = { version: 'v2-aaa', dataset, settings, entries: [entry(1, 2)] };
    expect(nextSkillListIndex({ format: 1, latest: 'v1-aaa.json' }, next).courses.length).toBe(1);
    expect(isSkillListIndex(nextSkillListIndex('こわれている', next))).toBe(true);
    // format 1 の 1 枚は読まない。中身の作りが違う。
    expect(isSkillListIndex({ latest: 'v1-aaa.json', generations: [] })).toBe(false);
  });

  it('コース 1 枚を書いて、置いてあるものから一覧を作り直せる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-list-'));
    try {
      const file: SkillListCourseFile = {
        format: SKILL_LIST_FORMAT,
        version: 'v2-aaa',
        generatedAt: new Date(0).toISOString(),
        dataset,
        settings,
        course: {
          location: 10006, course: 10606,
          locationName: '東京', courseName: '芝2400m',
          distance: 2400, surface: 1, category: 'MIDDLE',
        },
        baselines: [], skillIds: [], styles: [], fidelities: [],
        columns: {
          length: 0, skill: [], baseline: [], style: [], mean: [], stdError: [],
          triggerRate: [], meanWhenTriggered: [], cost: [], fidelity: [],
        },
        screenedOut: 0, races: 0, elapsedMs: 0,
      };
      const written = writeSkillListCourse(dir, file);
      expect(written.file).toBe('v2-aaa/10006-10606.json');

      updateSkillListIndex(dir, {
        version: 'v2-aaa', dataset, settings, entries: [written],
      });
      const read = readSkillListIndex(dir);
      expect(read?.courses.length).toBe(1);
      const raw: unknown = JSON.parse(readFileSync(join(dir, SKILL_LIST_INDEX_NAME), 'utf8'));
      expect(isSkillListIndex(raw)).toBe(true);

      // 分けて回したジョブの成果をまとめるときは、置いてあるものから数え直す
      expect(collectSkillListCourses(dir, 'v2-aaa')).toEqual([written]);
      expect(collectSkillListCourses(dir, 'v2-無い')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
