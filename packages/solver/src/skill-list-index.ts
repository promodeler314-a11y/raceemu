/**
 * 版とコースの一覧（`skill-list/index.json`）の書き出し。
 *
 * **読む側は版もコースのファイル名も当てられない。** 版はデータと計算式と相手の分布の
 * 指紋から決まり、置いてあるコースは回した範囲で決まる。名前を教える 1 枚をあいだに置く。
 * 形は `skill-list.ts` の `SkillListIndex` にある。
 *
 * **1 コース 1 枚で配り、この 1 枚は小さく保つ。** 全 137 コースを 1 枚にすると
 * 25 MB を超える。画面がコースを選ぶためだけにそれを取りに行くのは無駄である。
 *
 * ## 足していく形である
 *
 * 全 137 コースは 1 回では回りきらない（20 時間を超える）。分けて回したぶんを
 * **足し込む**ので、既にある一覧を読んでから書く。ただし**版が変わったら捨てる**。
 * 版が変わったということは材料が動いたということで、前の版で測った値と
 * 新しい版で測った値を同じ表に混ぜてはならない。
 *
 * **このファイルは Node でしか動かない**（`node:fs` を読む）。画面から import してはならない。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  SKILL_LIST_FORMAT,
  isSkillListIndex,
  skillListCourseKey,
  type SkillListCourseFile,
  type SkillListDataset,
  type SkillListIndex,
  type SkillListIndexEntry,
  type SkillListSettings,
} from './skill-list.ts';

export const SKILL_LIST_INDEX_NAME = 'index.json';

/**
 * 残す世代の数。
 *
 * 入れ替えの最中に古い画面が前の版を取りに来るので、1 世代前まで残す。
 * 配布のワークフロー（`.github/workflows/build-skill-list.yml`）の掃除も 2 世代である。
 */
export const KEEP_GENERATIONS = 2;

/** コース 1 枚のファイル名（版のディレクトリから見た相対）。 */
export function skillListCourseFileName(location: number, course: number): string {
  return `${skillListCourseKey(location, course)}.json`;
}

/** `index.json` から見た相対のパス。画面はこれをそのまま取りに行く。 */
export function skillListCoursePath(version: string, location: number, course: number): string {
  return `${version}/${skillListCourseFileName(location, course)}`;
}

/** コース 1 枚を書く。版ごとのディレクトリを作る。 */
export function writeSkillListCourse(dir: string, file: SkillListCourseFile): SkillListIndexEntry {
  const versionDir = join(dir, file.version);
  mkdirSync(versionDir, { recursive: true });
  const name = skillListCourseFileName(file.course.location, file.course.course);
  writeFileSync(join(versionDir, name), JSON.stringify(file));
  return {
    course: file.course,
    file: `${file.version}/${name}`,
    rows: file.columns.length,
    trials: file.settings.trials,
    generatedAt: file.generatedAt,
  };
}

/** 一覧の並び。場 → バ場 → 距離。選択欄の並びがこれで決まる。 */
function sortEntries(entries: readonly SkillListIndexEntry[]): SkillListIndexEntry[] {
  return [...entries].sort(
    (a, b) =>
      a.course.location - b.course.location ||
      a.course.surface - b.course.surface ||
      a.course.distance - b.course.distance ||
      a.course.course - b.course.course,
  );
}

/**
 * 既にある一覧に、いま測ったコースを足した形を作る。**ファイルには触らない。**
 *
 * 同じコースをもう一度測ったら、新しいほうで置き換える。
 * **版が変わったら前のコースは引き継がない**（上の注記）。
 */
export function nextSkillListIndex(
  current: unknown,
  next: {
    readonly version: string;
    readonly dataset: SkillListDataset;
    readonly settings: SkillListSettings;
    readonly entries: readonly SkillListIndexEntry[];
  },
  keep: number = KEEP_GENERATIONS,
): SkillListIndex {
  const previous = isSkillListIndex(current) ? current : null;
  const sameVersion = previous?.version === next.version;
  const byKey = new Map<string, SkillListIndexEntry>();
  if (sameVersion) {
    for (const entry of previous!.courses) {
      byKey.set(skillListCourseKey(entry.course.location, entry.course.course), entry);
    }
  }
  for (const entry of next.entries) {
    byKey.set(skillListCourseKey(entry.course.location, entry.course.course), entry);
  }
  const olderGenerations = previous === null
    ? []
    : [previous.version, ...previous.generations].filter(
        (name) => typeof name === 'string' && name !== '' && name !== next.version,
      );
  const generations = [next.version, ...new Set(olderGenerations)].slice(0, Math.max(1, keep));
  return {
    format: SKILL_LIST_FORMAT,
    version: next.version,
    generatedAt: new Date().toISOString(),
    dataset: next.dataset,
    settings: next.settings,
    courses: sortEntries([...byKey.values()]),
    generations,
  };
}

/** 置いてある一覧を読む。無い・壊れている・形が古いときは null。 */
export function readSkillListIndex(dir: string): SkillListIndex | null {
  const path = join(dir, SKILL_LIST_INDEX_NAME);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isSkillListIndex(parsed) ? parsed : null;
  } catch {
    // 壊れていたら作り直す。読めない 1 枚を残すより、新しい版だけを指すほうが良い。
    return null;
  }
}

/**
 * `index.json` を読んで書き直す。無ければ新しく作る。
 *
 * 置いてある版の一覧は**ディレクトリを見て作り直さない**。配布の側が古い版を
 * 掃除する作りになっており、こちらが勝手に消えたファイルを落とすと、
 * まだ配られている版を一覧から外してしまう。
 */
export function updateSkillListIndex(
  dir: string,
  next: {
    readonly version: string;
    readonly dataset: SkillListDataset;
    readonly settings: SkillListSettings;
    readonly entries: readonly SkillListIndexEntry[];
  },
  keep: number = KEEP_GENERATIONS,
): SkillListIndex {
  mkdirSync(dir, { recursive: true });
  const index = nextSkillListIndex(readSkillListIndex(dir), next, keep);
  writeFileSync(join(dir, SKILL_LIST_INDEX_NAME), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

/**
 * 版のディレクトリに実際に置いてあるコースを数え上げて一覧に直す。
 *
 * 分けて回したぶんを別のジョブが書いた（GitHub Actions の matrix）ときは、
 * それぞれのジョブの `index.json` には自分のぶんしか無い。最後にここで数え直す。
 */
export function collectSkillListCourses(dir: string, version: string): SkillListIndexEntry[] {
  const versionDir = join(dir, version);
  if (!existsSync(versionDir)) return [];
  const entries: SkillListIndexEntry[] = [];
  for (const name of readdirSync(versionDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const file = JSON.parse(readFileSync(join(versionDir, name), 'utf8')) as SkillListCourseFile;
      if (file.format !== SKILL_LIST_FORMAT || typeof file.course !== 'object') continue;
      entries.push({
        course: file.course,
        file: `${version}/${name}`,
        rows: file.columns.length,
        trials: file.settings.trials,
        generatedAt: file.generatedAt,
      });
    } catch {
      // 書いている最中に落ちた 1 枚は読めない。一覧に載せなければ画面は「無い」と読む。
    }
  }
  return sortEntries(entries);
}
