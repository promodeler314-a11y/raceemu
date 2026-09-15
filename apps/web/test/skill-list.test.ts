import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SkillListCategory, SkillListFile } from '../../../packages/solver/src/skill-list.ts';
import {
  SkillListBroken,
  SkillListUnavailable,
  aggregate,
  baselineTier,
  baselineTiers,
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

/**
 * 手書きの見本。コース 2 本 × 脚質 2 つ × 段 2 つ × スキル 3 つ。
 *
 * **実データと同じ形にしてある。** 生成側の基準個体は
 * `<段>:<バ場>:<距離帯>` という複合の id を持ち、距離帯とバ場ごとに別の個体になる
 * （長距離のほうがスタミナが多い）。見本を 1 段 1 個体で書いていたせいで、
 * 「基準個体を 1 つに固定すると、その個体が割り当てられた距離帯の行しか当たらない」
 * という壊れ方をテストが素通りさせた。実データでは 4 通りの絞り込みのうち
 * 3 通りが 0 件になっていた。
 */
function sample(): SkillListFile {
  // 行の並びは (スキル, 段, 脚質, コース) の入れ子である。
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

  // スキルごとの「効き」を決めておく。コースと脚質と段で少しずつ変える。
  const costs = [90, 200, 170];
  const base = [0.1, 0.3, 0.2];
  for (let s = 0; s < 3; s += 1) {
    for (let t = 0; t < 2; t += 1) {
      for (let st = 0; st < 2; st += 1) {
        for (let c = 0; c < 2; c += 1) {
          skill.push(s);
          // 基準個体はコースから決まる。段は t、コースは c。
          baseline.push(c * 2 + t);
          style.push(st);
          course.push(c);
          mean.push(base[s]! + 0.01 * st + 0.02 * c + 0.05 * t);
          stdError.push(0.004);
          triggerRate.push(0.5 + 0.1 * st);
          meanWhenTriggered.push(2 * base[s]!);
          cost.push(costs[s]!);
          fidelity.push(s === 2 ? 1 : 0);
        }
      }
    }
  }

  return {
    format: 1,
    version: 'test-0001',
    generatedAt: '2026-09-14T00:00:00.000Z',
    dataset: { skills: 'aaa', courses: 'bbb', raceModel: 'ccc', fieldProfile: 'ddd' },
    settings: { trials: 200, useField: true, gateCount: 9, seed: 1, trackCondition: 1 },
    // 段 2 つ × コースの種類 2 つ。同じ段が同じ `label` を共有する。
    baselines: [
      { id: 'normal:1:MIDDLE', label: '普通', speed: 1100, stamina: 725, power: 900, guts: 600, wisdom: 900 },
      { id: 'strong:1:MIDDLE', label: '強い', speed: 1250, stamina: 850, power: 900, guts: 600, wisdom: 900 },
      { id: 'normal:2:SHORT', label: '普通', speed: 1100, stamina: 300, power: 900, guts: 600, wisdom: 900 },
      { id: 'strong:2:SHORT', label: '強い', speed: 1250, stamina: 300, power: 900, guts: 600, wisdom: 900 },
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

const ALL: SkillListFilter = { category: 'ALL', style: 'ALL', surface: 0, baseline: 'normal' };

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
    expect(file.columns.length).toBe(24);
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
    // 段の中の全コース × 全脚質。基準個体が距離帯ごとに分かれていても、
    // 段で絞っているかぎり全部の行が当たる。
    expect(rows[0]!.rows).toBe(4);
  });

  /*
    ここから 4 件が、実データで壊れていた形を固定する。
    基準個体を具体的な id 1 つに固定していたころは、その個体が割り当てられた
    距離帯とバ場の行しか当たらず、距離帯やバ場で絞ると 0 件になっていた。
    **0 件なら落ちる**形で書く。前は 0 件でも緑になった。
  */
  it('どの距離帯で絞っても行が残る', () => {
    const file = sample();
    for (const category of ['MIDDLE', 'SHORT'] as const) {
      const rows = aggregate(file, { ...ALL, category });
      expect(rows.length, `${category} が 0 件`).toBe(3);
      expect(rows[0]!.rows).toBeGreaterThan(0);
    }
  });

  it('どのバ場で絞っても行が残る', () => {
    const file = sample();
    for (const surface of [1, 2] as const) {
      const rows = aggregate(file, { ...ALL, surface });
      expect(rows.length, `バ場 ${surface} が 0 件`).toBe(3);
    }
  });

  it('段を切り替えると別の行が当たる', () => {
    const file = sample();
    const normal = aggregate(file, { ...ALL, baseline: 'normal' });
    const strong = aggregate(file, { ...ALL, baseline: 'strong' });
    expect(normal).toHaveLength(3);
    expect(strong).toHaveLength(3);
    // 見本では強いほうが 0.05 秒ぶん大きく出るようにしてある。
    expect(strong[0]!.mean - normal[0]!.mean).toBeCloseTo(0.05, 12);
  });

  it('段を絞らないまま両方を混ぜたりしない', () => {
    // 1 段ぶんの行数は 4（コース 2 × 脚質 2）。8 なら両段を混ぜている。
    expect(aggregate(sample(), ALL)[0]!.rows).toBe(4);
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

  it('知らない段を渡されたら先頭の段に落とす（全段を混ぜない）', () => {
    const file = sample();
    // 具体的な個体の id を渡しても、段として扱えないので先頭に落ちる。
    const fallback = aggregate(file, { ...ALL, baseline: 'normal:1:MIDDLE' });
    expect(fallback[0]!.rows).toBe(4);
    expect(fallback[0]!.mean).toBeCloseTo(aggregate(file, { ...ALL, baseline: 'normal' })[0]!.mean, 12);
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

describe('基準個体の段', () => {
  it('複合の id からは先頭の段だけを取る', () => {
    expect(baselineTier('normal:1:MIDDLE')).toBe('normal');
    expect(baselineTier('strong:2:LONG')).toBe('strong');
  });

  it('区切りの無い id は、そのまま段として扱う', () => {
    // 契約（packages/solver/src/skill-list.ts）は複合の形を強制していない。
    // 生成側が 1 段 1 個体に戻してもそのまま動くこと。
    expect(baselineTier('normal')).toBe('normal');
  });

  it('選択欄には段だけを出す（同じ語が並ばない）', () => {
    const tiers = baselineTiers(sample());
    expect(tiers.map((tier) => tier.id)).toEqual(['normal', 'strong']);
    expect(tiers.map((tier) => tier.label)).toEqual(['普通', '強い']);
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

/**
 * 配ってある実データそのもので絞り込みを確かめる。
 *
 * **手書きの見本だけでは足りない。** 見本は書いた人が思っている形になるので、
 * 生成側が実際に出した形（基準個体が 16 件、id が複合）とズレていても気付けない。
 * 実際、距離帯とバ場の絞り込みが実データで全滅していたのに、見本のテストは緑だった。
 *
 * 読み込みは 1.5 MB あるので 1 回だけにする。表が配られていない環境（生成側を
 * 取り込む前の枝）では静かに飛ばす。
 */
const SKILL_LIST_DIR = 'apps/web/public/skill-list';
const SKILL_LIST_INDEX = `${SKILL_LIST_DIR}/index.json`;
describe.skipIf(!existsSync(SKILL_LIST_INDEX))('配ってある実データ', () => {
  const index = JSON.parse(readFileSync(SKILL_LIST_INDEX, 'utf8')) as { latest: string };
  const real = JSON.parse(
    readFileSync(`${SKILL_LIST_DIR}/${index.latest}`, 'utf8'),
  ) as SkillListFile;
  const tiers = baselineTiers(real);
  const base: SkillListFilter = {
    category: 'ALL',
    style: 'ALL',
    surface: 0,
    baseline: tiers[0]?.id ?? '',
  };
  const categories = [...new Set(real.courses.map((course) => course.category))];
  const surfaces = [...new Set(real.courses.map((course) => course.surface))];

  it('基準個体は段より多く、選択欄には段だけが出る', () => {
    // 16 件をそのまま選択欄に出すと「普通」が 8 個並んで区別できない。
    expect(tiers.length).toBeGreaterThan(1);
    expect(tiers.length).toBeLessThan(real.baselines.length);
    expect(new Set(tiers.map((tier) => tier.id)).size).toBe(tiers.length);
  });

  it('既定の絞り込みで、全コース × 全脚質まで当たるスキルがある', () => {
    // ここが壊れていた。基準個体を 1 つに固定していたころは、その個体が
    // 割り当てられた距離帯とバ場の行しか当たらず、最大でも脚質の数で頭打ちになった。
    const rows = aggregate(real, base);
    expect(rows.length).toBeGreaterThan(0);
    expect(Math.max(...rows.map((row) => row.rows))).toBe(
      real.styles.length * real.courses.length,
    );
  });

  it('「すべて」が、いちばん狭い絞り込みより広い', () => {
    // 壊れていたときは「すべて」＝芝短距離だけで、数が一致していた。
    const all = aggregate(real, base).length;
    const narrow = aggregate(real, {
      ...base,
      category: categories[0] as SkillListCategory,
      surface: surfaces[0] as 1 | 2,
    }).length;
    expect(all).toBeGreaterThan(narrow);
  });

  it('どの距離帯で絞っても 0 件にならない', () => {
    for (const category of categories) {
      expect(aggregate(real, { ...base, category }).length, `${category} が 0 件`).toBeGreaterThan(0);
    }
  });

  it('どのバ場で絞っても 0 件にならない', () => {
    for (const surface of surfaces) {
      expect(
        aggregate(real, { ...base, surface: surface as 1 | 2 }).length,
        `バ場 ${surface} が 0 件`,
      ).toBeGreaterThan(0);
    }
  });

  it('どの脚質で絞っても 0 件にならない', () => {
    for (const style of real.styles) {
      expect(aggregate(real, { ...base, style }).length, `${style} が 0 件`).toBeGreaterThan(0);
    }
  });

  it('どの段を選んでも 0 件にならず、段ごとに値が変わる', () => {
    const byTier = tiers.map((tier) => aggregate(real, { ...base, baseline: tier.id }));
    for (const [i, rows] of byTier.entries()) {
      expect(rows.length, `${tiers[i]!.id} が 0 件`).toBeGreaterThan(0);
    }
    const first = new Map(byTier[0]!.map((row) => [row.skillId, row.mean]));
    const moved = byTier[1]!.filter((row) => first.get(row.skillId) !== row.mean);
    expect(moved.length).toBeGreaterThan(0);
  });

  it('内訳も距離帯を跨ぐ', () => {
    const rows = aggregate(real, base);
    const everywhere = rows.find((row) => row.rows === real.styles.length * real.courses.length)!;
    const breakdown = courseBreakdown(real, base, everywhere.skillId);
    expect(breakdown).toHaveLength(real.courses.length);
    expect(new Set(breakdown.map((row) => row.course.category)).size).toBe(categories.length);
  });
});
