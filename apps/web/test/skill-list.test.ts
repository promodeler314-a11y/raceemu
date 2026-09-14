import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillListFile } from '../../../packages/solver/src/skill-list.ts';
import {
  SkillListBroken,
  SkillListUnavailable,
  aggregate,
  courseBreakdown,
  fetchSkillList,
  secondsToBashin,
  upgradeGroups,
  type SkillListFilter,
} from '../src/skillList.ts';

/**
 * 事前計算したスキル一覧を読む側（[#83](https://github.com/promodeler314-a11y/raceemu/issues/83)）。
 *
 * **JSON の実体はまだ無い。** 生成は別に進んでいるので、ここでは手書きの小さな
 * 見本で形と集計を固定する。見本はこのファイルの中だけに置く
 * （`apps/web/public/skill-list/` は生成側の領分である）。
 *
 * いちばん大事なのは、`searchApi.ts` と同じく**取れない配布物で倒れないこと**
 * である。静的ファイルだけを置いた版には表が入っていないことがあり、そこでは
 * 面が「置いていない」と言って終わればよい。`pnpm e2e` の偽サーバが実物で
 * 同じことを突くが、応答の形ごとの振り分けはここで固定する。
 */

/** 手書きの見本。コース 2 本 × 脚質 2 つ × 基準 1 段 × スキル 3 つ。 */
function sample(): SkillListFile {
  // 行の並びは (スキル, 脚質, コース) の入れ子である。
  // 添字だけで持つ形（SkillListColumns）をそのまま手で書く。
  const skill: number[] = [];
  const baseline: number[] = [];
  const style: number[] = [];
  const course: number[] = [];
  const mean: number[] = [];
  const stdError: number[] = [];
  const triggerRate: number[] = [];
  const meanWhenTriggered: number[] = [];
  const cost: number[] = [];
  const fidelity: number[] = [];

  // スキルごとの「効き」を決めておく。コースと脚質で少しずつ変える。
  const costs = [90, 200, 170];
  const base = [0.1, 0.3, 0.2];
  for (let s = 0; s < 3; s += 1) {
    for (let st = 0; st < 2; st += 1) {
      for (let c = 0; c < 2; c += 1) {
        skill.push(s);
        baseline.push(0);
        style.push(st);
        course.push(c);
        mean.push(base[s]! + 0.01 * st + 0.02 * c);
        stdError.push(0.004);
        triggerRate.push(0.5 + 0.1 * st);
        meanWhenTriggered.push(2 * base[s]!);
        cost.push(costs[s]!);
        fidelity.push(s === 2 ? 1 : 0);
      }
    }
  }

  return {
    format: 1,
    version: 'test-0001',
    generatedAt: '2026-09-14T00:00:00.000Z',
    dataset: { skills: 'aaa', courses: 'bbb', raceModel: 'ccc', fieldProfile: 'ddd' },
    settings: { trials: 200, useField: true, gateCount: 9, seed: 1, trackCondition: 1 },
    baselines: [
      { id: 'strong', label: '強い', speed: 1200, stamina: 1000, power: 900, guts: 600, wisdom: 900 },
    ],
    courses: [
      {
        location: 10006,
        course: 10606,
        locationName: '中山',
        courseName: '芝2000m（内）',
        distance: 2000,
        surface: 1,
        category: 'MIDDLE',
      },
      {
        location: 10001,
        course: 10101,
        locationName: '札幌',
        courseName: 'ダート1200m',
        distance: 1200,
        surface: 2,
        category: 'SHORT',
      },
    ],
    // 「右回り○」「右回り◎」「一匹狼」。前の 2 つは同じグループである。
    skillIds: ['201021', '201022', '200333'],
    styles: ['NIGE', 'SEN'],
    fidelities: ['exact', 'approximate'],
    columns: {
      length: skill.length,
      skill,
      baseline,
      style,
      course,
      mean,
      stdError,
      triggerRate,
      meanWhenTriggered,
      cost,
      fidelity,
    },
    screenedOut: 42,
    races: 1200,
    elapsedMs: 5000,
  };
}

const ALL: SkillListFilter = { category: 'ALL', style: 'ALL', surface: 0, baseline: 'strong' };

/** `fetch` の代わり。中身の型と本文を並べて返すだけのもの。 */
function stubFetch(pages: Readonly<Record<string, { type: string; body: string; status?: number }>>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    calls.push(url);
    const page = pages[url];
    if (page === undefined) {
      return Promise.resolve({
        ok: false,
        status: 404,
        redirected: false,
        headers: { get: () => 'text/plain' },
        json: () => Promise.reject(new Error('not json')),
      } as unknown as Response);
    }
    return Promise.resolve({
      ok: (page.status ?? 200) < 400,
      status: page.status ?? 200,
      redirected: false,
      headers: { get: () => page.type },
      json: () => Promise.resolve(JSON.parse(page.body) as unknown),
    } as unknown as Response);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('表を取る', () => {
  it('index.json が表そのものならそれを返す', async () => {
    stubFetch({
      'skill-list/index.json': { type: 'application/json', body: JSON.stringify(sample()) },
    });
    const file = await fetchSkillList();
    expect(file.version).toBe('test-0001');
  });

  it('index.json が版の一覧なら、名指しされた版を取りに行く', async () => {
    stubFetch({
      'skill-list/index.json': {
        type: 'application/json',
        body: JSON.stringify({ latest: '2026-09-14.json' }),
      },
      'skill-list/2026-09-14.json': {
        type: 'application/json',
        body: JSON.stringify(sample()),
      },
    });
    const file = await fetchSkillList();
    expect(file.columns.length).toBe(12);
  });

  it('静的配信だけの版（HTML が返る）では「無い」に倒す', async () => {
    stubFetch({
      'skill-list/index.json': { type: 'text/html; charset=utf-8', body: '{}', status: 200 },
    });
    await expect(fetchSkillList()).rejects.toBeInstanceOf(SkillListUnavailable);
  });

  it('置いていない（404）ときも「無い」に倒し、生の例外を出さない', async () => {
    stubFetch({});
    await expect(fetchSkillList()).rejects.toThrow(/入っていない/);
  });

  it('形が合わない JSON は「壊れている」に分ける', async () => {
    stubFetch({
      'skill-list/index.json': {
        type: 'application/json',
        body: JSON.stringify({ format: 1, version: 'x' }),
      },
    });
    await expect(fetchSkillList()).rejects.toBeInstanceOf(SkillListBroken);
  });

  it('取りに行けない（回線断）ときも「無い」に倒す', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('failed to fetch')));
    await expect(fetchSkillList()).rejects.toBeInstanceOf(SkillListUnavailable);
  });
});

describe('集計', () => {
  it('絞り込みなしでは全スキルが出て、短縮量の大きい順に並ぶ', () => {
    const rows = aggregate(sample(), ALL);
    expect(rows.map((row) => row.skillId)).toEqual(['201022', '200333', '201021']);
    expect(rows[0]!.rows).toBe(4);
  });

  it('距離帯とバ場で絞ると、当たるコースの行だけを平均する', () => {
    const file = sample();
    const middle = aggregate(file, { ...ALL, category: 'MIDDLE' });
    // 中距離は 1 本目のコースだけ。脚質 2 つなので 2 行。
    expect(middle[0]!.rows).toBe(2);
    // 平均は 0.3（基準）+ 0.01 × 脚質の平均 0.5 + 0.02 × コース 0
    expect(middle.find((row) => row.skillId === '201022')!.mean).toBeCloseTo(0.305, 12);
    const dirt = aggregate(file, { ...ALL, surface: 2 });
    expect(dirt[0]!.rows).toBe(2);
    expect(dirt.find((row) => row.skillId === '201022')!.mean).toBeCloseTo(0.325, 12);
  });

  it('脚質で絞ると、その脚質の行だけになる', () => {
    const rows = aggregate(sample(), { ...ALL, style: 'SEN' });
    expect(rows[0]!.rows).toBe(2);
    expect(rows.find((row) => row.skillId === '201021')!.mean).toBeCloseTo(0.12, 12);
  });

  it('平均の誤差は行どうしを独立と見て合成する', () => {
    const rows = aggregate(sample(), ALL);
    // 4 行それぞれ 0.004。sqrt(4 × 0.004^2) / 4 = 0.002
    expect(rows[0]!.stdError).toBeCloseTo(0.002, 12);
  });

  it('印は当たる行のうちいちばん悪いものになる', () => {
    const rows = aggregate(sample(), ALL);
    expect(rows.find((row) => row.skillId === '200333')!.fidelity).toBe('approximate');
    expect(rows.find((row) => row.skillId === '201021')!.fidelity).toBe('exact');
  });

  it('効率は総額あたりの短縮量である', () => {
    const rows = aggregate(sample(), ALL);
    const row = rows.find((r) => r.skillId === '201021')!;
    expect(row.cost).toBe(90);
    expect(row.efficiency).toBeCloseTo(row.mean / 90, 12);
  });
});

describe('コースごとの内訳', () => {
  it('コースごとに 1 行になり、脚質は中で平均される', () => {
    const rows = courseBreakdown(sample(), ALL, '201022');
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.rows === 2)).toBe(true);
    // ダート 1200 のほうが 0.02 だけ大きく出るようにしてある。
    expect(rows[0]!.course.courseName).toBe('ダート1200m');
  });

  it('絞り込みは内訳にも効く', () => {
    const rows = courseBreakdown(sample(), { ...ALL, category: 'SHORT' }, '201022');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.course.distance).toBe(1200);
  });

  it('知らないスキルには何も出さない', () => {
    expect(courseBreakdown(sample(), ALL, 'そんな ID は無い')).toHaveLength(0);
  });
});

describe('上位互換のグループ', () => {
  const groupOf = (id: string) => (id === '201021' || id === '201022' ? 7 : 99);

  it('2 つ以上そろったグループだけを、下位から順に返す', () => {
    const groups = upgradeGroups(aggregate(sample(), ALL), groupOf);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members.map((m) => m.row.skillId)).toEqual(['201021', '201022']);
  });

  it('上位は差額と効果差で出す（総額そのものではない）', () => {
    const groups = upgradeGroups(aggregate(sample(), ALL), groupOf);
    const [lower, upper] = groups[0]!.members;
    expect(lower!.costStep).toBe(90);
    expect(upper!.costStep).toBe(110);
    expect(upper!.meanStep).toBeCloseTo(0.2, 12);
  });
});

describe('バ身の換算', () => {
  it('2000 m では 1 秒が 20 m、つまり 8 バ身になる', () => {
    expect(secondsToBashin(1, 2000)).toBeCloseTo(8, 12);
  });

  it('距離が伸びると基準速度が落ちるので、同じ秒でもバ身は小さくなる', () => {
    expect(secondsToBashin(1, 3000)).toBeLessThan(secondsToBashin(1, 2000));
  });
});
