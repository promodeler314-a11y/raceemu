/**
 * スキル一覧の版の識別子。
 *
 * 表がどの材料から作られたかを 4 つの指紋で持ち、そこから短い版の文字列を作る
 * （`SkillListDataset`、`skill-list.ts`）。どれか 1 つでも動いたら表は作り直しである。
 *
 * **指紋は git の blob SHA-1 である。** `scripts/check-race-model.py` が本家の
 * 計算式を追いかけるのに使っているものと同じ取り方にしてある。理由も同じで、
 * `git hash-object` や GitHub の tree API と同じ値になり、人手で確かめられる。
 *
 * **このファイルは Node でしか動かない**（`node:crypto` を読む）。
 * 画面は配られた JSON の `version` を読むだけなので、ここを import してはならない。
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultFieldProfile, type FieldProfile } from '../../sim/src/field/field.ts';
import { baselinePolicy } from './skill-list-stamina.ts';
import { SKILL_LIST_FORMAT, type SkillListDataset } from './skill-list.ts';

/**
 * git の blob オブジェクト ID。`sha1("blob <長さ>\0" + 中身)`。
 * `git hash-object <file>` と同じ値になる。
 */
export function gitBlobSha1(body: Uint8Array | string): string {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
  return createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

/**
 * 本家の計算式のうち、**計算に関わるものだけ**の指紋をまとめる。
 *
 * マニフェスト（`packages/sim/upstream/race-manifest.json`）をそのまま指紋に
 * すると、計算に関わらないファイルが動いただけで版が変わり、表を作り直す羽目になる。
 * `scripts/check-race-model.py` の `BUILD_ONLY` と `DATA_ONLY` と同じものを外す。
 *
 * - `race/build.gradle.kts`：依存の版上げ。計算には関わらない。
 * - `.../data/rawData.kt`：コースのデータ。こちらは `courses.json` の指紋が見ている。
 */
export const RACE_MANIFEST_EXCLUDED: readonly string[] = [
  'race/build.gradle.kts',
  'race/src/commonMain/kotlin/io/github/mee1080/umasim/race/data/rawData.kt',
];

export interface RaceManifest {
  readonly files: Readonly<Record<string, string>>;
}

/**
 * マニフェストの指紋を 1 つにまとめる。
 *
 * 並びはパスの昇順に固定する。JSON の鍵の順に依ると、マニフェストを
 * 書き直したときに中身が同じでも値が変わりうる。
 */
export function raceModelFingerprint(manifest: RaceManifest): string {
  const lines = Object.entries(manifest.files)
    .filter(([path]) => !RACE_MANIFEST_EXCLUDED.includes(path))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, sha]) => `${path} ${sha}`);
  return gitBlobSha1(`${lines.join('\n')}\n`);
}

/**
 * 相手の束の作り方の指紋。
 *
 * 値そのものを表に効かせるのは相手の分布なので、`defaultFieldProfile` の中身から作る。
 * 鍵の順に依らないよう、並べ直してから文字列にする。
 */
export function fieldProfileFingerprint(profile: FieldProfile): string {
  return gitBlobSha1(stableStringify(profile));
}

/** 鍵を並べ替えてから JSON にする。中身が同じなら必ず同じ文字列になる。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(',');
  return `{${body}}`;
}

/**
 * 5 つの指紋から版の文字列を作る。
 *
 * 版のディレクトリの名前になるので短くする。衝突の心配は要らない（表は週に 1 つ増える程度で、
 * 12 桁の 16 進は 48 ビットある）。頭に形の版を付けるのは、形が変わったときに
 * 古い版と並べても取り違えないようにするためである。
 */
export function skillListVersion(
  dataset: SkillListDataset,
  format: number = SKILL_LIST_FORMAT,
): string {
  const digest = gitBlobSha1(
    [
      dataset.skills,
      dataset.courses,
      dataset.raceModel,
      dataset.fieldProfile,
      dataset.baseline,
    ].join('\n'),
  );
  return `v${format}-${digest.slice(0, 12)}`;
}

/**
 * リポジトリの中の材料から 4 つの指紋を取る。
 *
 * **生成と取りまとめの両方がこれを呼ぶ。** 別々に書くと、分けて回した成果を
 * まとめる側だけが違う版を計算し、置いてあるコースを 1 本も見つけられなくなる
 * （画面からは「表が無い」と区別が付かない）。
 */
export function readSkillListDataset(root: string, gateCount: number): SkillListDataset {
  return {
    skills: gitBlobSha1(readFileSync(join(root, 'packages/data/assets/skills.json'))),
    courses: gitBlobSha1(readFileSync(join(root, 'packages/data/assets/courses.json'))),
    raceModel: raceModelFingerprint(
      JSON.parse(
        readFileSync(join(root, 'packages/sim/upstream/race-manifest.json'), 'utf8'),
      ) as RaceManifest,
    ),
    fieldProfile: fieldProfileFingerprint(defaultFieldProfile(gateCount)),
    baseline: gitBlobSha1(baselinePolicy()),
  };
}
