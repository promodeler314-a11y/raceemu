import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  SkillListCourseFile,
  SkillListIndex,
  SkillListIndexEntry,
} from '../../../packages/solver/src/skill-list.ts';
import {
  SkillListBroken,
  SkillListUnavailable,
  aggregate,
  courseLabel,
  defaultCourseEntry,
  entryKey,
  fetchSkillListCourse,
  fetchSkillListIndex,
  groupCoursesByLocation,
  secondsToBashin,
  styleBreakdown,
  upgradeGroups,
  type SkillListFilter,
} from '../src/skillList.ts';

/**
 * 事前計算したスキル一覧を読む側（[#83](https://github.com/promodeler314-a11y/raceemu/issues/83)）。
 *
 * **表はコースごとに 1 枚である。** 画面はまず一覧（`index.json`）で
 * 「どのコースが置いてあるか」を知り、選ばれた 1 枚だけを取りに行く。
 * ここでは手書きの小さな見本で形と集計を固定し、最後に**配ってある実データ**で
 * 同じことを確かめる。
 *
 * **手書きの見本だけでは足りない。** 見本は書いた人が思っている形になるので、
 * 生成側が実際に出した形とズレていても気付けない。format 1 のころ、
 * 基準個体の id の作りが生成側と画面側で食い違い、実データで絞り込みが全滅したのに
 * 見本のテストは緑だった。だから**実データを読む一群を必ず置く**。
 *
 * いちばん大事なのは、`searchApi.ts` と同じく**取れない配布物で倒れないこと**
 * である。静的ファイルだけを置いた版には表が入っていないことがあり、そこでは
 * 面が「置いていない」と言って終わればよい。
 */

const DATASET = { skills: 'aaa', courses: 'bbb', raceModel: 'ccc', fieldProfile: 'ddd' };
const SETTINGS = { trials: 200, useField: true, gateCount: 9, seed: 1, trackCondition: 1 } as const;

/**
 * 手書きの見本 1 コースぶん。脚質 2 つ × 段 2 つ × スキル 3 つ。
 *
 * **基準個体の id は `normal` / `strong` の 2 つだけである**（契約でそう決めてある）。
 * 1 枚が 1 コースなので、id に距離帯やバ場を混ぜる必要が無い。
 */
function sampleCourse(
  course = { location: 10006, course: 10606, locationName: '東京', courseName: '芝2400m', distance: 2400, surface: 1, category: 'MIDDLE' as const },
  shift = 0,
): SkillListCourseFile {
  // 行の並びは (スキル, 段, 脚質) の入れ子である。
  // 添字だけで持つ形（SkillListColumns）をそのまま手で書く。
  const skill: number[] = [];
  const baseline: number[] = [];
  const style: number[] = [];
  const mean: number[] = [];
  const stdError: number[] = [];
  const triggerRate: number[] = [];
  const meanWhenTriggered: number[] = [];
  const cost: number[] = [];
  const fidelity: number[] = [];

  const costs = [90, 200, 170];
  const base = [0.1, 0.3, 0.2];
  for (let s = 0; s < 3; s += 1) {
    for (let t = 0; t < 2; t += 1) {
      for (let st = 0; st < 2; st += 1) {
        skill.push(s);
        baseline.push(t);
        style.push(st);
        mean.push(base[s]! + 0.01 * st + 0.05 * t + shift);
        stdError.push(0.004);
        triggerRate.push(0.5 + 0.1 * st);
        meanWhenTriggered.push(2 * base[s]!);
        cost.push(costs[s]!);
        fidelity.push(s === 2 ? 1 : 0);
      }
    }
  }

  return {
    format: 2,
    version: 'v2-test0001',
    generatedAt: '2026-09-14T00:00:00.000Z',
    dataset: DATASET,
    settings: SETTINGS,
    course,
    baselines: [
      { id: 'normal', label: '普通', speed: 1100, stamina: 725, power: 900, guts: 600, wisdom: 900 },
      { id: 'strong', label: '強い', speed: 1250, stamina: 850, power: 1050, guts: 750, wisdom: 1050 },
    ],
    // 「右回り○」「右回り◎」「一匹狼」。前の 2 つは同じグループである。
    skillIds: ['201021', '201022', '200333'],
    styles: ['NIGE', 'SEN'],
    fidelities: ['exact', 'approximate'],
    columns: {
      length: skill.length,
      skill, baseline, style, mean, stdError, triggerRate, meanWhenTriggered, cost, fidelity,
    },
    screenedOut: 42,
    races: 1200,
    elapsedMs: 5000,
  };
}

const OTHER_COURSE = {
  location: 10006, course: 10604,
  locationName: '東京', courseName: '芝2000m',
  distance: 2000, surface: 1, category: 'MIDDLE' as const,
};

function sampleIndex(): SkillListIndex {
  const entry = (
    file: SkillListCourseFile,
  ): SkillListIndexEntry => ({
    course: file.course,
    file: `v2-test0001/${file.course.location}-${file.course.course}.json`,
    rows: file.columns.length,
    trials: file.settings.trials,
    generatedAt: file.generatedAt,
  });
  return {
    format: 2,
    version: 'v2-test0001',
    generatedAt: '2026-09-14T00:00:00.000Z',
    dataset: DATASET,
    settings: SETTINGS,
    courses: [entry(sampleCourse(OTHER_COURSE, 0.5)), entry(sampleCourse())],
    generations: ['v2-test0001'],
  };
}

const ALL: SkillListFilter = { style: 'ALL', baseline: 'normal' };

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

describe('一覧と 1 枚を取る', () => {
  it('一覧を取り、そこに名指しされたコースだけを取りに行く', async () => {
    const calls = stubFetch({
      'skill-list/index.json': { type: 'application/json', body: JSON.stringify(sampleIndex()) },
      'skill-list/v2-test0001/10006-10606.json': {
        type: 'application/json',
        body: JSON.stringify(sampleCourse()),
      },
    });
    const index = await fetchSkillListIndex();
    expect(index.courses).toHaveLength(2);
    const file = await fetchSkillListCourse(defaultCourseEntry(index)!);
    expect(file.course.course).toBe(10606);
    // **全コースをまとめて取らない。** 一覧 1 回と、選んだ 1 枚だけである。
    expect(calls).toEqual([
      'skill-list/index.json',
      'skill-list/v2-test0001/10006-10606.json',
    ]);
  });

  it('静的配信だけの版（HTML が返る）では「無い」に倒す', async () => {
    stubFetch({
      'skill-list/index.json': { type: 'text/html; charset=utf-8', body: '{}', status: 200 },
    });
    await expect(fetchSkillListIndex()).rejects.toBeInstanceOf(SkillListUnavailable);
  });

  it('置いていない（404）ときも「無い」に倒し、生の例外を出さない', async () => {
    stubFetch({});
    await expect(fetchSkillListIndex()).rejects.toThrow(/入っていない/);
  });

  it('形が合わない一覧は「壊れている」に分ける', async () => {
    stubFetch({
      'skill-list/index.json': {
        type: 'application/json',
        body: JSON.stringify({ format: 2, version: 'x' }),
      },
    });
    await expect(fetchSkillListIndex()).rejects.toBeInstanceOf(SkillListBroken);
  });

  it('古い形（format 1 の 1 枚）は読まない', async () => {
    stubFetch({
      'skill-list/index.json': {
        type: 'application/json',
        body: JSON.stringify({ latest: 'v1-aaa.json', generations: ['v1-aaa.json'] }),
      },
    });
    await expect(fetchSkillListIndex()).rejects.toBeInstanceOf(SkillListBroken);
  });

  it('一覧は取れたがコースの 1 枚が無いときも「無い」に倒す', async () => {
    stubFetch({
      'skill-list/index.json': { type: 'application/json', body: JSON.stringify(sampleIndex()) },
    });
    const index = await fetchSkillListIndex();
    await expect(fetchSkillListCourse(index.courses[0]!)).rejects.toBeInstanceOf(
      SkillListUnavailable,
    );
  });

  it('取りに行けない（回線断）ときも「無い」に倒す', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('failed to fetch')));
    await expect(fetchSkillListIndex()).rejects.toBeInstanceOf(SkillListUnavailable);
  });
});

describe('コースの選び方', () => {
  it('既定は東京 芝2400m。置いてあれば必ずそれを開く', () => {
    const index = sampleIndex();
    // 一覧の並びでは芝2000m が先だが、既定は 2400 である。
    expect(index.courses[0]!.course.course).toBe(10604);
    expect(defaultCourseEntry(index)!.course.course).toBe(10606);
  });

  it('置いていなければ一覧の先頭にする', () => {
    const index = sampleIndex();
    const without = { ...index, courses: [index.courses[0]!] };
    expect(defaultCourseEntry(without)!.course.course).toBe(10604);
    expect(defaultCourseEntry({ ...index, courses: [] })).toBeUndefined();
  });

  it('選択欄はレース場でまとめる', () => {
    const index = sampleIndex();
    const groups = groupCoursesByLocation(index.courses);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.locationName).toBe('東京');
    expect(groups[0]!.entries).toHaveLength(2);
  });

  it('鍵と表示名はコースから決まる', () => {
    expect(entryKey(sampleIndex().courses[1]!)).toBe('10006-10606');
    expect(courseLabel(sampleCourse().course)).toBe('東京 芝2400m');
  });
});

describe('集計', () => {
  it('絞り込みなしでは全スキルが出て、短縮量の大きい順に並ぶ', () => {
    const rows = aggregate(sampleCourse(), ALL);
    expect(rows.map((row) => row.skillId)).toEqual(['201022', '200333', '201021']);
    // 1 段ぶんの脚質 2 つ。段を混ぜていれば 4 になる。
    expect(rows[0]!.rows).toBe(2);
  });

  it('段を切り替えると別の行が当たる', () => {
    const file = sampleCourse();
    const normal = aggregate(file, { ...ALL, baseline: 'normal' });
    const strong = aggregate(file, { ...ALL, baseline: 'strong' });
    expect(normal).toHaveLength(3);
    expect(strong).toHaveLength(3);
    // 見本では強いほうが 0.05 秒ぶん大きく出るようにしてある。
    expect(strong[0]!.mean - normal[0]!.mean).toBeCloseTo(0.05, 12);
    expect(strong[0]!.rows).toBe(2);
  });

  it('知らない段を渡されたら先頭の個体に落とす（両段を混ぜない）', () => {
    const file = sampleCourse();
    const fallback = aggregate(file, { ...ALL, baseline: 'normal:1:MIDDLE' as never });
    expect(fallback[0]!.rows).toBe(2);
    expect(fallback[0]!.mean).toBeCloseTo(aggregate(file, ALL)[0]!.mean, 12);
  });

  it('脚質で絞ると、その脚質の行だけになる', () => {
    const rows = aggregate(sampleCourse(), { ...ALL, style: 'SEN' });
    expect(rows[0]!.rows).toBe(1);
    expect(rows.find((row) => row.skillId === '201021')!.mean).toBeCloseTo(0.11, 12);
  });

  it('コースが違えば値も違う。距離帯で畳んではならない', () => {
    // 同じ距離帯の別のコース。畳んでよいなら、ここが同じになるはずである。
    const a = sampleCourse();
    const b = sampleCourse(OTHER_COURSE, 0.5);
    expect(a.course.category).toBe(b.course.category);
    expect(aggregate(a, ALL)[0]!.mean).not.toBeCloseTo(aggregate(b, ALL)[0]!.mean, 6);
  });

  it('平均の誤差は行どうしを独立と見て合成する', () => {
    const rows = aggregate(sampleCourse(), ALL);
    // 2 行それぞれ 0.004。sqrt(2 × 0.004^2) / 2 ≒ 0.002828
    expect(rows[0]!.stdError).toBeCloseTo(Math.sqrt(2 * 0.004 ** 2) / 2, 12);
  });

  it('印は当たる行のうちいちばん悪いものになる', () => {
    const rows = aggregate(sampleCourse(), ALL);
    expect(rows.find((row) => row.skillId === '200333')!.fidelity).toBe('approximate');
    expect(rows.find((row) => row.skillId === '201021')!.fidelity).toBe('exact');
  });

  it('効率は総額あたりの短縮量である', () => {
    const rows = aggregate(sampleCourse(), ALL);
    const row = rows.find((r) => r.skillId === '201021')!;
    expect(row.cost).toBe(90);
    expect(row.efficiency).toBeCloseTo(row.mean / 90, 12);
  });

  it('バ身はそのコースの距離から直す', () => {
    const rows = aggregate(sampleCourse(), ALL);
    const row = rows[0]!;
    expect(row.bashin).toBeCloseTo(secondsToBashin(row.mean, 2400), 12);
  });
});

describe('脚質ごとの内訳', () => {
  it('脚質ごとに 1 行になり、絞り込みで脚質を決めていても全脚質が出る', () => {
    const rows = styleBreakdown(sampleCourse(), { ...ALL, style: 'SEN' }, '201022');
    expect(rows.map((row) => row.style)).toEqual(['NIGE', 'SEN']);
    expect(rows.map((row) => row.label)).toEqual(['逃げ', '先行']);
    expect(rows.every((row) => row.measured)).toBe(true);
    expect(rows[1]!.mean - rows[0]!.mean).toBeCloseTo(0.01, 12);
  });

  it('測った行が無い脚質も並べる。0 と書き分ける', () => {
    // 脚質の条件を持つスキルは、当たらない脚質では走らせる前に落としてある。
    // 黙って行を減らすと「逃げでは効かない」と「逃げは測っていない」が区別できない。
    const file = sampleCourse();
    const onlySen: SkillListCourseFile = {
      ...file,
      columns: {
        ...file.columns,
        // 逃げ（添字 0）の行を落とす
        ...(() => {
          const keep = file.columns.style.map((value) => value === 1);
          const pick = <T,>(column: readonly T[]) => column.filter((_, i) => keep[i]!);
          return {
            length: keep.filter(Boolean).length,
            skill: pick(file.columns.skill),
            baseline: pick(file.columns.baseline),
            style: pick(file.columns.style),
            mean: pick(file.columns.mean),
            stdError: pick(file.columns.stdError),
            triggerRate: pick(file.columns.triggerRate),
            meanWhenTriggered: pick(file.columns.meanWhenTriggered),
            cost: pick(file.columns.cost),
            fidelity: pick(file.columns.fidelity),
          };
        })(),
      },
    };
    const rows = styleBreakdown(onlySen, ALL, '201022');
    expect(rows.map((row) => row.style)).toEqual(['NIGE', 'SEN']);
    expect(rows.map((row) => row.measured)).toEqual([false, true]);
    expect(rows[0]!.mean).toBe(0);
  });

  it('段は内訳にも効く', () => {
    const normal = styleBreakdown(sampleCourse(), ALL, '201022');
    const strong = styleBreakdown(sampleCourse(), { ...ALL, baseline: 'strong' }, '201022');
    expect(strong[0]!.mean - normal[0]!.mean).toBeCloseTo(0.05, 12);
  });

  it('知らないスキルには何も出さない', () => {
    expect(styleBreakdown(sampleCourse(), ALL, 'そんな ID は無い')).toHaveLength(0);
  });
});

describe('上位互換のグループ', () => {
  const groupOf = (id: string) => (id === '201021' || id === '201022' ? 7 : 99);

  it('2 つ以上そろったグループだけを、下位から順に返す', () => {
    const groups = upgradeGroups(aggregate(sampleCourse(), ALL), groupOf);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.members.map((m) => m.row.skillId)).toEqual(['201021', '201022']);
  });

  it('上位は差額と効果差で出す（総額そのものではない）', () => {
    const groups = upgradeGroups(aggregate(sampleCourse(), ALL), groupOf);
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
 * 配ってある実データそのもので確かめる。
 *
 * 表が配られていない環境（生成側を取り込む前の枝）では静かに飛ばす。
 */
const SKILL_LIST_DIR = 'apps/web/public/skill-list';
const SKILL_LIST_INDEX = `${SKILL_LIST_DIR}/index.json`;
const HAS_REAL = existsSync(SKILL_LIST_INDEX);
describe.skipIf(!HAS_REAL)('配ってある実データ', () => {
  // **飛ばす回でも describe の中身は読まれる。** 無いファイルをここで開くと、
  // 表を置いていない枝で「飛ばした」ではなく「集めるのに失敗した」で赤になる。
  const index = HAS_REAL
    ? (JSON.parse(readFileSync(SKILL_LIST_INDEX, 'utf8')) as SkillListIndex)
    : ({ format: 2, version: '', courses: [] } as unknown as SkillListIndex);
  const load = (entry: SkillListIndexEntry) =>
    JSON.parse(readFileSync(`${SKILL_LIST_DIR}/${entry.file}`, 'utf8')) as SkillListCourseFile;

  it('一覧は format 2 で、コースが 1 本以上載っている', () => {
    expect(index.format).toBe(2);
    expect(index.courses.length).toBeGreaterThan(0);
    expect(index.version).toMatch(/^v2-/);
  });

  it('一覧が指すファイルはすべて置いてある', () => {
    for (const entry of index.courses) {
      expect(existsSync(`${SKILL_LIST_DIR}/${entry.file}`), `${entry.file} が無い`).toBe(true);
    }
  });

  it('置いてあるファイルはすべて一覧に載っている', () => {
    // 載せ忘れた 1 枚は、画面からは「測っていない」と見分けが付かない。
    const listed = new Set(index.courses.map((entry) => entry.file));
    const present = readdirSync(`${SKILL_LIST_DIR}/${index.version}`)
      .filter((name) => name.endsWith('.json'))
      .map((name) => `${index.version}/${name}`);
    expect(present.length).toBeGreaterThan(0);
    expect(present.filter((file) => !listed.has(file))).toEqual([]);
  });

  it('どのコースを開いても行が出て、段でも脚質でも 0 件にならない', () => {
    for (const entry of index.courses) {
      const file = load(entry);
      expect(file.format).toBe(2);
      expect(file.version).toBe(index.version);
      expect(file.course).toEqual(entry.course);
      expect(file.columns.length).toBe(entry.rows);

      // 基準個体の id は normal / strong の 2 つだけである（契約）。
      expect(file.baselines.map((baseline) => baseline.id)).toEqual(['normal', 'strong']);

      for (const baseline of file.baselines) {
        const rows = aggregate(file, { style: 'ALL', baseline: baseline.id });
        expect(rows.length, `${courseLabel(file.course)} の ${baseline.id} が 0 件`).toBeGreaterThan(0);
        // 1 段ぶんの行数は脚質の数。これを超えていたら両段を混ぜている。
        expect(Math.max(...rows.map((row) => row.rows))).toBe(file.styles.length);
      }
      for (const style of file.styles) {
        expect(
          aggregate(file, { style, baseline: 'normal' }).length,
          `${courseLabel(file.course)} の ${style} が 0 件`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('段を変えると値が動く', () => {
    const file = load(index.courses[0]!);
    const normal = new Map(
      aggregate(file, { style: 'ALL', baseline: 'normal' }).map((row) => [row.skillId, row.mean]),
    );
    const moved = aggregate(file, { style: 'ALL', baseline: 'strong' }).filter(
      (row) => normal.get(row.skillId) !== row.mean,
    );
    expect(moved.length).toBeGreaterThan(0);
  });

  it('同じ距離帯の別のコースは、同じ表にならない', () => {
    // **この表がコース単位である理由そのもの。** 距離帯で畳んでよいなら、
    // ここが一致するはずである。
    const byCategory = new Map<string, SkillListIndexEntry[]>();
    for (const entry of index.courses) {
      const key = `${entry.course.surface}:${entry.course.category}`;
      byCategory.set(key, [...(byCategory.get(key) ?? []), entry]);
    }
    const pair = [...byCategory.values()].find((entries) => entries.length >= 2);
    if (pair === undefined) return; // 1 距離帯 1 コースしか置いていないうちは確かめようが無い
    const [a, b] = [aggregate(load(pair[0]!), ALL), aggregate(load(pair[1]!), ALL)];
    const first = new Map(a.map((row) => [row.skillId, row.mean]));
    const moved = b.filter((row) => first.get(row.skillId) !== row.mean);
    expect(moved.length).toBeGreaterThan(0);
  });

  it('1 枚は画面が動的に取れる大きさに収まっている', () => {
    // バンドルには混ぜないが、選ぶたびに取るものなので大きすぎてもいけない。
    for (const entry of index.courses) {
      const bytes = readFileSync(`${SKILL_LIST_DIR}/${entry.file}`).length;
      expect(bytes, `${entry.file} が大きすぎる`).toBeLessThan(2 * 1024 * 1024);
    }
  });
});
