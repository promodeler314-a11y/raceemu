import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import {
  assignPopularity,
  buildRaceSetting,
  checkAptitude,
  checkStatusRank,
  chooseStyle,
  DEFAULT_UNIQUE_LEVEL,
  distanceFitOf,
  surfaceFitOf,
  type LineupRunner,
} from '../src/multi/lineup.ts';

const data = loadGameData();

function runner(patch: Partial<LineupRunner> = {}): LineupRunner {
  return {
    name: 'テスト',
    status: { speed: 1200, stamina: 800, power: 900, guts: 600, wisdom: 800 },
    aptitude: {
      surface: { turf: 'A', dirt: 'E' },
      distance: { short: 'F', mile: 'B', mid: 'S', long: 'C' },
      style: { nige: 'E', sen: 'A', sasi: 'C', oi: 'G' },
    },
    skills: [],
    ...patch,
  };
}

describe('脚質の決め方', () => {
  it('指定があればそれを採る', () => {
    const choice = chooseStyle(runner({ style: 'oi' }));
    expect(choice.style).toBe('oi');
    expect(choice.source).toBe('given');
  });

  it('省くと、適性が最も高いものを採る', () => {
    const choice = chooseStyle(runner());
    expect(choice.style).toBe('sen');
    expect(choice.source).toBe('aptitude');
  });

  it('同じランクが並ぶときは、その脚質向けのスキルが多いほうを採る', () => {
    // 先行 A と差し A。差し向けのスキルのほうが多い。
    const choice = chooseStyle(
      runner({
        aptitude: { ...runner().aptitude, style: { nige: 'E', sen: 'A', sasi: 'A', oi: 'G' } },
        skills: ['差し直線◎', '差しコーナー○', '先行コーナー◎', '王手'],
      }),
    );
    expect(choice.style).toBe('sasi');
    expect(choice.source).toBe('aptitude_tie_skills');
  });

  it('それでも並ぶときは、先行、差し、追込、逃げの順に採る', () => {
    const tied = { nige: 'A', sen: 'A', sasi: 'A', oi: 'A' } as const;
    const choice = chooseStyle(runner({ aptitude: { ...runner().aptitude, style: tied } }));
    expect(choice.style).toBe('sen');
    expect(choice.source).toBe('aptitude_tie_order');
    const noSen = chooseStyle(runner({ aptitude: { ...runner().aptitude, style: { ...tied, sen: 'B' } } }));
    expect(noSen.style).toBe('sasi');
    const onlyOiNige = chooseStyle(
      runner({ aptitude: { ...runner().aptitude, style: { nige: 'S', sen: 'B', sasi: 'B', oi: 'S' } } }),
    );
    expect(onlyOiNige.style).toBe('oi');
  });
});

describe('適性の引き方', () => {
  it('距離種別とバ場に当たる適性を引く', () => {
    const r = runner();
    expect(distanceFitOf(r, 1)).toBe('F');
    expect(distanceFitOf(r, 2)).toBe('B');
    expect(distanceFitOf(r, 3)).toBe('S');
    expect(distanceFitOf(r, 4)).toBe('C');
    expect(surfaceFitOf(r, 1)).toBe('A');
    expect(surfaceFitOf(r, 2)).toBe('E');
  });
});

describe('人気の振り方', () => {
  it('評価点の高い順に 1 から振る', () => {
    const runners = [runner({ rating: 17000 }), runner({ rating: 19900 }), runner({ rating: 18500 })];
    expect(assignPopularity(runners)).toEqual([3, 1, 2]);
  });

  it('評価点が無い頭は、ある頭の後に入力の順で続く', () => {
    const runners = [runner(), runner({ rating: 100 }), runner(), runner({ rating: 200 })];
    expect(assignPopularity(runners)).toEqual([3, 2, 4, 1]);
  });

  it('どの頭にも評価点が無ければ入力の順', () => {
    expect(assignPopularity([runner(), runner(), runner()])).toEqual([1, 2, 3]);
  });

  it('同じ評価点は入力の順を保つ', () => {
    expect(assignPopularity([runner({ rating: 5 }), runner({ rating: 5 })])).toEqual([1, 2]);
  });
});

describe('RaceSetting への組み立て', () => {
  // ロンシャン 芝2400m。距離種別は中距離、バ場は芝。
  const track = { location: 10201, course: 11203, condition: 4, gateCount: 11, season: 1, weather: 1, time: 1 };

  it('コースの距離とバ場、決めた脚質の適性を 1 つずつ選ぶ', () => {
    const built = buildRaceSetting(runner(), [], track, data.trackData, 3);
    expect(built.distanceFit).toBe('S');
    expect(built.surfaceFit).toBe('A');
    expect(built.styleFit).toBe('A');
    expect(built.setting.uma).toMatchObject({
      style: 'SEN',
      distanceFit: 'S',
      surfaceFit: 'A',
      styleFit: 'A',
      popularity: 3,
      gateNumber: 0,
      condition: 'BEST',
      speed: 1200,
      wisdom: 800,
    });
  });

  it('固有の Lv が無ければ既定を使い、あれば画像の値を使う', () => {
    expect(buildRaceSetting(runner(), [], track, data.trackData, 1).uniqueLevel).toBe(DEFAULT_UNIQUE_LEVEL);
    const withLevel = buildRaceSetting(runner({ unique: { name: 'x', level: 4 } }), [], track, data.trackData, 1);
    expect(withLevel.uniqueLevel).toBe(4);
    expect(withLevel.setting.uma.uniqueLevel).toBe(4);
  });

  it('画面の既定と同じ設定を持つ（本家と同じ近似、位置取りは後で全頭同時側が上書きする）', () => {
    const { setting } = buildRaceSetting(runner(), [], track, data.trackData, 1);
    expect(setting).toMatchObject({
      skillActivateAdjustment: 'NONE',
      randomPosition: 'RANDOM',
      debuffCounts: {},
      positionKeepMode: 'APPROXIMATE',
      positionKeepRate: 100,
    });
    expect(setting.track).toBe(track);
  });

  it('ダートのコースではダート適性を使う', () => {
    const dirtCourse = Object.entries(data.trackData).flatMap(([location, track]) =>
      Object.entries(track.courses)
        .filter(([, detail]) => detail.surface === 2 && detail.distanceType === 2)
        .map(([course]) => ({ location: Number(location), course: Number(course) })),
    )[0]!;
    const built = buildRaceSetting(
      runner(),
      [],
      { ...track, ...dirtCourse, condition: 1 },
      data.trackData,
      1,
    );
    expect(built.surfaceFit).toBe('E');
    expect(built.distanceFit).toBe('B');
  });

  it('存在しないコースは例外', () => {
    expect(() => buildRaceSetting(runner(), [], { ...track, course: 999999 }, data.trackData, 1)).toThrow(/コース/);
  });
});

describe('ステータスとランク文字の突き合わせ', () => {
  const at = (value: number, rank: string) =>
    checkStatusRank({ speed: value, stamina: 500, power: 500, guts: 500, wisdom: 500 }, { speed: rank });
  const codes = (value: number, rank: string) => at(value, rank).map((issue) => issue.code);

  it('各ランクの境目は 100 刻みである', () => {
    expect(codes(599, 'C+')).toEqual([]);
    expect(codes(600, 'C+')).toEqual(['rank_mismatch']);
    expect(codes(600, 'B')).toEqual([]);
    expect(codes(599, 'B')).toEqual(['rank_mismatch']);
    expect(codes(799, 'B+')).toEqual([]);
    expect(codes(800, 'B+')).toEqual(['rank_mismatch']);
    expect(codes(800, 'A')).toEqual([]);
    expect(codes(799, 'A')).toEqual(['rank_mismatch']);
    expect(codes(999, 'A+')).toEqual([]);
    expect(codes(1000, 'A+')).toEqual(['rank_mismatch']);
    expect(codes(1000, 'S')).toEqual([]);
    expect(codes(1099, 'S')).toEqual([]);
    expect(codes(1100, 'S')).toEqual(['rank_mismatch']);
    expect(codes(400, 'C')).toEqual([]);
    expect(codes(399, 'C')).toEqual(['rank_mismatch']);
  });

  it('全角のプラスや小文字、空白の揺れは吸収する', () => {
    expect(codes(950, 'A＋')).toEqual([]);
    expect(codes(950, ' a+ ')).toEqual([]);
  });

  it('S を超える数値は、U 系と SS 系なら 1100 以上であることだけを見る', () => {
    expect(codes(1203, 'U')).toEqual([]);
    expect(codes(1319, 'UF')).toEqual([]);
    expect(codes(1150, 'SS')).toEqual([]);
    expect(codes(1000, 'U')).toEqual(['rank_mismatch']);
    expect(codes(900, 'SS')).toEqual(['rank_mismatch']);
  });

  it('表に無いランク（C 未満）と、ランク文字の無い項目は検査しない', () => {
    expect(codes(150, 'G')).toEqual([]);
    expect(codes(450, 'D')).toEqual([]);
    expect(checkStatusRank({ speed: 900, stamina: 900, power: 900, guts: 900, wisdom: 900 }, undefined)).toEqual([]);
  });

  it('1 から 2000 の外は範囲の警告になる', () => {
    expect(codes(0, 'B')).toEqual(['status_range']);
    expect(codes(2001, 'B')).toEqual(['status_range']);
    expect(codes(2000, 'U')).toEqual([]);
  });

  it('画像から読んだ実際の値は、全部食い違いが出ない', () => {
    // 会話の中で読んだ 11 頭のうちの 3 頭。ヒシアマゾンのスタミナ 532 は C+、ツルマルツヨシの 565 も C+。
    expect(
      checkStatusRank(
        { speed: 1319, stamina: 532, power: 837, guts: 628, wisdom: 824 },
        { speed: 'U', stamina: 'C+', power: 'A', guts: 'B', wisdom: 'A' },
      ),
    ).toEqual([]);
    expect(
      checkStatusRank(
        { speed: 1036, stamina: 600, power: 856, guts: 657, wisdom: 1036 },
        { speed: 'S', stamina: 'B', power: 'A', guts: 'B', wisdom: 'S' },
      ),
    ).toEqual([]);
    // 数字を 1 桁読み違えると捕まる（613 を 513 と読んだ）。
    expect(
      checkStatusRank({ speed: 1200, stamina: 513, power: 900, guts: 600, wisdom: 800 }, { stamina: 'B' }),
    ).toEqual([expect.objectContaining({ code: 'rank_mismatch' })]);
  });
});

describe('適性の点検', () => {
  it('S から G 以外の文字は警告になる', () => {
    expect(checkAptitude(runner().aptitude)).toEqual([]);
    const bad = checkAptitude({
      ...runner().aptitude,
      style: { nige: 'Z' as never, sen: 'A', sasi: 'C', oi: 'G' },
    });
    expect(bad).toHaveLength(1);
    expect(bad[0]!.code).toBe('invalid_aptitude');
  });
});
