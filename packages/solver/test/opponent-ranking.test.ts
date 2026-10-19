import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Fidelity } from '../../sim/src/skill/classify.ts';
import type { Style } from '../../sim/src/data/constants.ts';
import { opponentRankingFromSkillList, opponentRankingTier } from '../src/opponent-ranking.ts';
import { SKILL_LIST_DIR } from '../src/opponent-roster-setup.ts';
import {
  SKILL_LIST_FORMAT,
  type SkillListCourseFile,
  type SkillListDataset,
  type SkillListSettings,
  type SkillListTier,
} from '../src/skill-list.ts';
import {
  readSkillListCourse,
  updateSkillListIndex,
  writeSkillListCourse,
} from '../src/skill-list-index.ts';

const dataset: SkillListDataset = {
  skills: 'a', courses: 'b', raceModel: 'c', fieldProfile: 'd', baseline: 'e',
};
const settings: SkillListSettings = {
  trials: 100, useField: true, gateCount: 9, seed: 1, trackCondition: 1,
};

interface Row {
  readonly skill: string;
  readonly tier: SkillListTier;
  readonly style: Style;
  readonly mean: number;
  readonly fidelity?: Fidelity;
}

/** 行の一覧から、列で持つコース 1 枚を組む。 */
function courseFile(rows: readonly Row[], tiers: readonly SkillListTier[]): SkillListCourseFile {
  const skillIds = [...new Set(rows.map((row) => row.skill))];
  const styles: Style[] = ['NIGE', 'SEN', 'SASI', 'OI'];
  const fidelities: Fidelity[] = ['exact', 'approximate', 'dropped'];
  return {
    format: SKILL_LIST_FORMAT,
    version: 'v2-test',
    generatedAt: new Date(0).toISOString(),
    dataset,
    settings,
    course: {
      location: 10008, course: 10808,
      locationName: '京都', courseName: '芝2200m(外)',
      distance: 2200, surface: 1, category: 'MIDDLE',
    },
    baselines: tiers.map((id) => ({
      id, label: id, speed: 1, stamina: 1, power: 1, guts: 1, wisdom: 1,
    })),
    skillIds,
    styles,
    fidelities,
    columns: {
      length: rows.length,
      skill: rows.map((row) => skillIds.indexOf(row.skill)),
      baseline: rows.map((row) => tiers.indexOf(row.tier)),
      style: rows.map((row) => styles.indexOf(row.style)),
      mean: rows.map((row) => row.mean),
      stdError: rows.map(() => 0),
      triggerRate: rows.map(() => 1),
      meanWhenTriggered: rows.map((row) => row.mean),
      cost: rows.map(() => 100),
      fidelity: rows.map((row) => fidelities.indexOf(row.fidelity ?? 'exact')),
    },
    screenedOut: 0, races: 0, elapsedMs: 0,
  };
}

describe('スキル一覧から相手の順位表を作る', () => {
  const rows: Row[] = [
    { skill: 'a', tier: 'strong', style: 'NIGE', mean: 0.2 },
    { skill: 'b', tier: 'strong', style: 'NIGE', mean: 0.5 },
    { skill: 'c', tier: 'strong', style: 'NIGE', mean: 9, fidelity: 'dropped' },
    { skill: 'd', tier: 'strong', style: 'NIGE', mean: -0.1 },
    { skill: 'a', tier: 'strong', style: 'SEN', mean: 0.1 },
    { skill: 'a', tier: 'normal', style: 'SEN', mean: 7 },
    { skill: 'e', tier: 'strong', style: 'OI', mean: 0.3, fidelity: 'approximate' },
  ];

  it('強い段を使い、条件を落としたものを除き、短縮量の降順に並べる', () => {
    const ranking = opponentRankingFromSkillList(courseFile(rows, ['normal', 'strong']));
    expect(ranking.NIGE).toEqual([['b', 0.5], ['a', 0.2], ['d', -0.1]]);
    // 普通の段の行（7 秒）は混ざらない。
    expect(ranking.SEN).toEqual([['a', 0.1]]);
    // 近似（approximate）は残す。
    expect(ranking.OI).toEqual([['e', 0.3]]);
  });

  it('行が無い脚質も空の配列で持つ（名簿は脚質で直に引く）', () => {
    const ranking = opponentRankingFromSkillList(courseFile(rows, ['normal', 'strong']));
    expect(ranking.SASI).toEqual([]);
    expect(Object.keys(ranking).sort()).toEqual(['NIGE', 'OI', 'SASI', 'SEN']);
  });

  it('強い段が無ければ普通の段を使う。どちらも無ければ空', () => {
    const onlyNormal = courseFile(
      [{ skill: 'a', tier: 'normal', style: 'SEN', mean: 0.4 }],
      ['normal'],
    );
    expect(opponentRankingTier(onlyNormal)).toBe('normal');
    expect(opponentRankingFromSkillList(onlyNormal).SEN).toEqual([['a', 0.4]]);

    const none = courseFile([], []);
    expect(opponentRankingTier(none)).toBeNull();
    expect(opponentRankingFromSkillList(none).SEN).toEqual([]);
  });

  it('同じ値のときは id の順になり、行の並びに依らない', () => {
    const tied: Row[] = [
      { skill: 'z', tier: 'strong', style: 'SEN', mean: 0.3 },
      { skill: 'y', tier: 'strong', style: 'SEN', mean: 0.3 },
    ];
    const forward = opponentRankingFromSkillList(courseFile(tied, ['strong']));
    const backward = opponentRankingFromSkillList(courseFile([...tied].reverse(), ['strong']));
    expect(forward.SEN.map(([id]) => id)).toEqual(['y', 'z']);
    expect(backward).toEqual(forward);
  });
});

describe('置いてあるコース 1 枚を読む', () => {
  it('一覧にあるコースだけを読み、無いコースや無い置き場は null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'opponent-ranking-'));
    try {
      expect(readSkillListCourse(dir, 10008, 10808)).toBeNull();
      const file = courseFile([{ skill: 'a', tier: 'strong', style: 'SEN', mean: 0.1 }], ['strong']);
      const written = writeSkillListCourse(dir, file);
      // 一覧に載せる前は、ファイルがあっても読まない（版は一覧だけが知っている）。
      expect(readSkillListCourse(dir, 10008, 10808)).toBeNull();
      updateSkillListIndex(dir, { version: 'v2-test', dataset, settings, entries: [written] });
      expect(readSkillListCourse(dir, 10008, 10808)?.version).toBe('v2-test');
      expect(readSkillListCourse(dir, 10006, 10606)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 置いてある表（京都 芝2200m 外）の形が、名簿の読み方に合っているか。無ければ飛ばす。
  const real = readSkillListCourse(SKILL_LIST_DIR, 10008, 10808);
  it.skipIf(real === null)('実際の表から、4 脚質とも順位表ができる', () => {
    const ranking = opponentRankingFromSkillList(real!);
    expect(opponentRankingTier(real!)).toBe('strong');
    for (const style of ['NIGE', 'SEN', 'SASI', 'OI'] as const) {
      const list = ranking[style];
      expect(list.length).toBeGreaterThan(100);
      for (let i = 1; i < list.length; i++) expect(list[i - 1]![1]).toBeGreaterThanOrEqual(list[i]![1]);
    }
    // 継承固有（id が 9 から始まる）は順位表に残る。名簿が継承固有を引くのに使う。
    expect(ranking.SEN.some(([id]) => id.startsWith('9'))).toBe(true);
  });
});
