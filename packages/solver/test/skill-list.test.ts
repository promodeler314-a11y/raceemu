import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { nodeWorkerFactory } from '../../sim/src/parallel/node.ts';
import { WorkerPool } from '../../sim/src/parallel/pool.ts';
import { DerivedSetting, defaultSystemSetting, emptyPassiveBonus } from '../../sim/src/setting.ts';
import { canTrigger } from '../src/screen.ts';
import { isSkillListIndex, skillListRowAt, type SkillListFile } from '../src/skill-list.ts';
import {
  SKILL_LIST_INDEX_NAME,
  nextSkillListIndex,
  updateSkillListIndex,
} from '../src/skill-list-index.ts';
import {
  REPRESENTATIVE_COURSES,
  baselinesFor,
  buildRaceSetting,
  planSkillList,
  purchasableSkills,
  runSkillList,
  type SkillListOptions,
} from '../src/skill-list-run.ts';
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
    };
    expect(skillListVersion(dataset)).toBe(skillListVersion({ ...dataset }));
    // 鍵の並びが違っても同じ
    const reordered = {
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
    };
    const base = skillListVersion(dataset);
    for (const key of ['skills', 'courses', 'raceModel', 'fieldProfile'] as const) {
      expect(skillListVersion({ ...dataset, [key]: 'e'.repeat(40) })).not.toBe(base);
    }
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

describe('事前計算', () => {
  const course = REPRESENTATIVE_COURSES.find(
    (c) => c.surface === 1 && c.category === 'SHORT',
  )!;
  const options: SkillListOptions = {
    trials: 20,
    seed: 1,
    gateCount: 9,
    trackCondition: 1,
    useField: false,
    samples: 16,
    courses: [course],
    styles: ['SEN'],
    baselineIds: ['normal'],
    maxSkills: 4,
  };

  it('走らせずに落とした数が screen.ts の判定と合う', async () => {
    const baseline = baselinesFor(course).find((b) => b.id.startsWith('normal'))!;
    const setting = buildRaceSetting(course, 'SEN', baseline, options);
    const derived = new DerivedSetting(setting, emptyPassiveBonus(), data.trackData);
    const expected = purchasableSkills(data).filter((skill) => !canTrigger(skill, derived)).length;

    // 数え上げだけの口と、実際に走らせた結果の両方が同じ数を返すこと。
    expect(planSkillList(data, options).screenedOut).toBe(expected);
    const body = await runSkillList(pool, data, system, options);
    expect(body.screenedOut).toBe(expected);
    // 打ち切りは「測っていない」であって「発動しない」ではないので、落とした数には入らない。
    expect(body.columns.length).toBe(4);
  });

  it('列の形から行に戻せる', async () => {
    const body = await runSkillList(pool, data, system, options);
    const file: SkillListFile = {
      format: 1,
      version: 'test',
      generatedAt: new Date(0).toISOString(),
      dataset: { skills: '', courses: '', raceModel: '', fieldProfile: '' },
      ...body,
    };
    expect(file.columns.length).toBeGreaterThan(0);
    // すべての列が同じ長さである
    for (const column of [
      file.columns.skill, file.columns.baseline, file.columns.style, file.columns.course,
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
      expect(row.baseline.startsWith('normal')).toBe(true);
      expect(row.style).toBe('SEN');
      expect(row.course).toBe(course.course);
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
    const first = await runSkillList(pool, data, system, options);
    const second = await runSkillList(pool, data, system, options);
    expect(second.columns.mean).toEqual(first.columns.mean);
    expect(second.columns.triggerRate).toEqual(first.columns.triggerRate);
  });
});

describe('版を教える 1 枚', () => {
  it('無いところに作ると、新しい版だけの 1 要素になる', () => {
    expect(nextSkillListIndex(null, 'v1-aaa.json')).toEqual({
      latest: 'v1-aaa.json',
      generations: ['v1-aaa.json'],
    });
  });

  it('既にあるなら先頭に足し、2 世代だけ残す', () => {
    const first = nextSkillListIndex(null, 'v1-aaa.json');
    const second = nextSkillListIndex(first, 'v1-bbb.json');
    expect(second).toEqual({ latest: 'v1-bbb.json', generations: ['v1-bbb.json', 'v1-aaa.json'] });
    const third = nextSkillListIndex(second, 'v1-ccc.json');
    expect(third).toEqual({ latest: 'v1-ccc.json', generations: ['v1-ccc.json', 'v1-bbb.json'] });
  });

  it('同じ版をもう一度作っても二重に並ばない', () => {
    const first = nextSkillListIndex(null, 'v1-aaa.json');
    const again = nextSkillListIndex(first, 'v1-aaa.json');
    expect(again.generations).toEqual(['v1-aaa.json']);
  });

  it('壊れた 1 枚は作り直す', () => {
    expect(nextSkillListIndex({ latest: 42 }, 'v1-aaa.json').generations).toEqual(['v1-aaa.json']);
    expect(isSkillListIndex(nextSkillListIndex('こわれている', 'v1-aaa.json'))).toBe(true);
  });

  it('ファイルに書いて読み直せる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skill-list-'));
    try {
      updateSkillListIndex(dir, 'v1-aaa.json');
      const written = updateSkillListIndex(dir, 'v1-bbb.json');
      const read: unknown = JSON.parse(readFileSync(join(dir, SKILL_LIST_INDEX_NAME), 'utf8'));
      expect(isSkillListIndex(read)).toBe(true);
      expect(read).toEqual(written);
      expect(written.generations).toEqual(['v1-bbb.json', 'v1-aaa.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
