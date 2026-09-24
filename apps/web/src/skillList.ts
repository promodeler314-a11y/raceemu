import { bashinMeters, styleLabel } from '../../../packages/sim/src/data/constants.ts';
import type { Style } from '../../../packages/sim/src/data/constants.ts';
import { worseFidelity, type Fidelity } from '../../../packages/sim/src/skill/classify.ts';
import {
  isSkillListCourseFile,
  isSkillListIndex,
  skillListCourseKey,
  type SkillListCourse,
  type SkillListCourseFile,
  type SkillListIndex,
  type SkillListIndexEntry,
  type SkillListTier,
} from '../../../packages/solver/src/skill-list.ts';

/**
 * 事前計算したスキル一覧（[#83](https://github.com/promodeler314-a11y/raceemu/issues/83)）を
 * 読む側。形の取り決めは `packages/solver/src/skill-list.ts` にある。
 *
 * ここは**読むだけ**である。生成は `pnpm skill-list`、置き場は
 * `apps/web/public/skill-list/` で、どちらも生成側の領分である。
 * 決めたことと理由は docs/webapp-design.md 6.6 節にある。
 *
 * ## 軸はコースである
 *
 * 表は**コースごとに 1 枚**配られる。距離帯で畳んだ表にはしない。
 * 同じ距離帯でもコースが違えば直線の長さも坂も違い、効くスキルが変わるからである。
 * 画面はまず `index.json` で「どのコースが置いてあるか」を知り、
 * 選ばれた 1 コースぶんだけを取りに行く。全部で 25 MB を超えるので、
 * 全コースをまとめて取ることはしない。
 *
 * ## 取れないことは普通に起きる
 *
 * 配布物には**静的ファイルだけを置いた版**があり、そこには事前計算の JSON を
 * 載せていないことがある。認証や proxy が 200 で HTML を返す経路もある。
 * `searchApi.ts` と同じく、状態番号ではなく**中身が JSON かどうか**で判断し、
 * 取れなければ日本語で言い分けて画面は動き続ける。
 *
 * **測ってあるコースが一部だけ、も普通の状態である。** 全 137 コースを回すには
 * 20 時間を超えるので、置いてあるところまでが表になる。画面はそう書く。
 */

/** 版とコースの一覧。ここを最初に見る。 */
export const SKILL_LIST_INDEX_URL = 'skill-list/index.json';

/**
 * 配り先にスキル一覧が無いこと。画面はこれを見て「置いていない」と言う。
 *
 * 静的配信だけの版、置いていない、回線断がここに来る。どれも直しようが
 * 無いので、勧めるのは「配る側が置くこと」だけである。
 */
export class SkillListUnavailable extends Error {}

/** 取れたが形が合わないこと。古い版を配っている場合がここに来る。 */
export class SkillListBroken extends Error {}

function explainNonJson(res: Response): string {
  if (res.status === 404) return 'この配布物にはスキル一覧の表が入っていません。';
  if (res.redirected) return `表ではなく別の画面に飛ばされました（最終 ${res.status}）。`;
  // 「JSON」のような生の語は画面に出さない。読む人に用が無いうえ、
  // 例外がそのまま出ているのか、こちらが言っているのかが見分けられない。
  return `表の代わりに、別の形の応答が返りました（${res.status}）。無いパスを画面に落とす配り方をしていると、ここに来ます。`;
}

/** JSON を 1 枚取る。JSON でなければ「無い」に倒す。 */
async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (error) {
    throw new SkillListUnavailable(
      `表を取りに行けませんでした（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!res.ok || !contentType.includes('application/json')) {
    throw new SkillListUnavailable(explainNonJson(res));
  }
  try {
    return (await res.json()) as unknown;
  } catch {
    throw new SkillListUnavailable(explainNonJson(res));
  }
}

/**
 * 版とコースの一覧を取る。
 *
 * `indexUrl` を引数にしてあるのはテストのためである。画面からは既定のまま呼ぶ。
 */
export async function fetchSkillListIndex(
  indexUrl: string = SKILL_LIST_INDEX_URL,
  signal?: AbortSignal,
): Promise<SkillListIndex> {
  const body = await fetchJson(indexUrl, signal);
  if (!isSkillListIndex(body)) {
    throw new SkillListBroken(
      'スキル一覧の形が読めません。配ってある版が古いか、別のファイルが置かれています。',
    );
  }
  return body;
}

/** コース 1 枚を取る。`entry.file` は `index.json` から見た相対のパスである。 */
export async function fetchSkillListCourse(
  entry: SkillListIndexEntry,
  indexUrl: string = SKILL_LIST_INDEX_URL,
  signal?: AbortSignal,
): Promise<SkillListCourseFile> {
  const body = await fetchJson(indexUrl.replace(/[^/]*$/, entry.file), signal);
  if (!isSkillListCourseFile(body)) {
    throw new SkillListBroken(`${entry.file} の形が読めません。配ってある版が古いです。`);
  }
  return body;
}

/** 画面が読むときの失敗の言い分け。例外の型ごとに文面を変える。 */
export function explainSkillListError(error: unknown): string {
  if (error instanceof SkillListUnavailable) {
    // 作り方（pnpm skill-list）は配る側の話なので、画面には出さない。README と CLAUDE.md にある。
    return `${error.message} この面は事前に計算した表を読むだけなので、表が無いと何も出せません。`;
  }
  if (error instanceof SkillListBroken) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ */
/* コースの選び方。ここから下は純粋な関数で、テストが固定する。        */
/* ------------------------------------------------------------------ */

/** 「東京 芝2400m」。選択欄にも内訳にも同じ書き方を使う。 */
export function courseLabel(course: SkillListCourse): string {
  return `${course.locationName} ${course.courseName}`;
}

export function entryKey(entry: SkillListIndexEntry): string {
  return skillListCourseKey(entry.course.location, entry.course.course);
}

/**
 * 既定で開くコース。
 *
 * **東京 芝2400m があればそれにする。** リポジトリの既定コースであり
 * （`pnpm sim` も `pnpm cross` もここを既定にしている）、他の実測と並べられる。
 * 置いていなければ一覧の先頭にする。
 */
export const DEFAULT_SKILL_LIST_COURSE = skillListCourseKey(10006, 10606);

export function defaultCourseEntry(
  index: SkillListIndex,
): SkillListIndexEntry | undefined {
  return (
    index.courses.find((entry) => entryKey(entry) === DEFAULT_SKILL_LIST_COURSE) ??
    index.courses[0]
  );
}

/** 選択欄の入れ子。レース場ごとにまとめる（`optgroup` になる）。 */
export interface SkillListCourseGroup {
  readonly locationName: string;
  readonly entries: readonly SkillListIndexEntry[];
}

/**
 * 一覧をレース場ごとにまとめる。並びは `index.json` のままにする。
 *
 * 137 本を平らに並べた選択欄からは目当てのコースを見つけられない。
 * 場でまとめると、ゲームの画面と同じ探し方になる。
 */
export function groupCoursesByLocation(
  entries: readonly SkillListIndexEntry[],
): readonly SkillListCourseGroup[] {
  const out: SkillListCourseGroup[] = [];
  for (const entry of entries) {
    const last = out.at(-1);
    if (last !== undefined && last.locationName === entry.course.locationName) {
      (last.entries as SkillListIndexEntry[]).push(entry);
    } else {
      out.push({ locationName: entry.course.locationName, entries: [entry] });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 絞り込みと集計                                                      */
/* ------------------------------------------------------------------ */

/**
 * 絞り込みの軸。**この版の JSON が持っている軸だけを置く。**
 *
 * コースは絞り込みではなく、**どの 1 枚を取るか**である（`SkillListIndexEntry`）。
 * 距離帯とバ場の選択欄はもう無い。コースを選ぶのだから、距離帯は決まっている。
 *
 * issue は季節と天候とバ場状態でも絞ると書いているが、`SkillListSettings` の
 * とおり、いまの版はそれらを振っていない（固定で 1 通り）。無い軸の選択欄を
 * 出すと、選べるのに何も変わらないものになる。画面には「1 通りしか持って
 * いない」と書く。
 */
export interface SkillListFilter {
  /** 脚質。`ALL` は全部。 */
  readonly style: Style | 'ALL';
  /** 基準になる個体（`normal` / `strong`）。 */
  readonly baseline: SkillListTier;
}

export const DEFAULT_SKILL_LIST_FILTER: SkillListFilter = {
  style: 'ALL',
  baseline: 'normal',
};

/** 1 スキルぶんの集計。絞り込みに当たる行を平均したものである。 */
export interface SkillListAggregate {
  readonly skillId: string;
  /** 秒。正が速い。 */
  readonly mean: number;
  readonly stdError: number;
  readonly triggerRate: number;
  readonly meanWhenTriggered: number;
  readonly cost: number;
  /** 秒 / pt。`cost` が 0 なら 0。 */
  readonly efficiency: number;
  /** 当たる行の中でいちばん悪い印。 */
  readonly fidelity: Fidelity;
  /** 平均に入った行数（= 脚質の数）。 */
  readonly rows: number;
  /** バ身の目安。`secondsToBashin` で秒から直したもの。 */
  readonly bashin: number;
}

/** 脚質ごとの内訳。行を押したときに降りる先。 */
export interface SkillListStyleRow {
  readonly style: Style;
  readonly label: string;
  /**
   * 測った行があるか。
   *
   * **false は「走らせずに落とした」である。** その脚質では確かに発動しないと
   * `screen.ts` が判定したので、行そのものが無い（`screen.ts` の判定は片側だけ
   * 確かで、落としたものは確かに発動しない）。数値の側を 0 で埋めて黙って並べると、
   * 「測ったら 0 だった」と読まれる。**この 2 つは別のことである。**
   */
  readonly measured: boolean;
  readonly mean: number;
  readonly stdError: number;
  readonly triggerRate: number;
  readonly meanWhenTriggered: number;
  readonly bashin: number;
}

/**
 * 秒をバ身に直す目安。
 *
 * **裏取り前の換算を 2 つ重ねている。** 1 バ身 = 2.5 m がゲームからの裏取り前で
 * あることは `constants.ts` に書いてあるとおりで（[#52](https://github.com/promodeler314-a11y/raceemu/issues/52)）、
 * そのうえ「1 秒が何メートルか」は走っている速度に依る。JSON は秒しか持たない
 * ので、ここでは**そのコースの基準速度**（`setting.ts` の `baseSpeed`、
 * 2000 m で 20.0 m/s）で置いている。終盤は基準速度より速いので、この目安は
 * 実際よりやや小さめに出る。
 *
 * だから**秒が正で、バ身は併記にとどめる。**
 */
export function secondsToBashin(seconds: number, distance: number): number {
  const baseSpeed = 20.0 - (distance - 2000) / 1000.0;
  return (seconds * baseSpeed) / bashinMeters;
}

/**
 * 絞り込みに当たるかどうかを、列の添字だけで判定できる形に畳んだもの。
 *
 * **基準個体は id そのもので絞れる。** 1 枚が 1 コースなので、id は
 * `normal` / `strong` の 2 つしか無い（format 1 では id に距離帯とバ場が
 * 混ざっており、画面が段で絞れずに実データで絞り込みが全滅した）。
 * 知らない id を渡されたら先頭の個体に落とす。
 */
function matcher(file: SkillListCourseFile, filter: SkillListFilter) {
  const baselineIndex = file.baselines.findIndex((baseline) => baseline.id === filter.baseline);
  const wanted = baselineIndex < 0 ? 0 : baselineIndex;
  const styleIndex = filter.style === 'ALL' ? -1 : file.styles.indexOf(filter.style);
  return (row: number): boolean => {
    if (file.columns.baseline[row] !== wanted) return false;
    if (filter.style !== 'ALL' && file.columns.style[row] !== styleIndex) return false;
    return true;
  };
}

/** 足し込みの途中。平均と誤差をまとめて出すための入れ物。 */
interface Accumulator {
  sum: number;
  sumVariance: number;
  sumTrigger: number;
  sumWhenTriggered: number;
  cost: number;
  fidelity: Fidelity;
  rows: number;
}

function emptyAccumulator(): Accumulator {
  return {
    sum: 0,
    sumVariance: 0,
    sumTrigger: 0,
    sumWhenTriggered: 0,
    cost: 0,
    fidelity: 'exact',
    rows: 0,
  };
}

function add(acc: Accumulator, file: SkillListCourseFile, row: number): void {
  const c = file.columns;
  const stdError = c.stdError[row]!;
  acc.sum += c.mean[row]!;
  acc.sumVariance += stdError * stdError;
  acc.sumTrigger += c.triggerRate[row]!;
  acc.sumWhenTriggered += c.meanWhenTriggered[row]!;
  acc.cost = c.cost[row]!;
  acc.fidelity = worseFidelity(acc.fidelity, file.fidelities[c.fidelity[row]!] ?? 'exact');
  acc.rows += 1;
}

/**
 * 絞り込みに当たる行を、スキルごとに平均する。
 *
 * **脚質どうしは別々に走らせてある**ので、平均の誤差は二乗和の平方根を
 * 行数で割ったものにする（独立と見なす）。同じ試行番号で引き算した 1 行ぶんの
 * 誤差より、こちらのほうが素直である。
 */
export function aggregate(
  file: SkillListCourseFile,
  filter: SkillListFilter,
): readonly SkillListAggregate[] {
  const matches = matcher(file, filter);
  const bySkill = new Map<number, Accumulator>();
  for (let row = 0; row < file.columns.length; row += 1) {
    if (!matches(row)) continue;
    const skill = file.columns.skill[row]!;
    let acc = bySkill.get(skill);
    if (acc === undefined) {
      acc = emptyAccumulator();
      bySkill.set(skill, acc);
    }
    add(acc, file, row);
  }
  const out: SkillListAggregate[] = [];
  for (const [skill, acc] of bySkill) {
    const mean = acc.sum / acc.rows;
    out.push({
      skillId: file.skillIds[skill]!,
      mean,
      stdError: Math.sqrt(acc.sumVariance) / acc.rows,
      triggerRate: acc.sumTrigger / acc.rows,
      meanWhenTriggered: acc.sumWhenTriggered / acc.rows,
      cost: acc.cost,
      efficiency: acc.cost === 0 ? 0 : mean / acc.cost,
      fidelity: acc.fidelity,
      rows: acc.rows,
      bashin: secondsToBashin(mean, file.course.distance),
    });
  }
  out.sort((a, b) => b.mean - a.mean);
  return out;
}

/**
 * 1 スキルの**脚質ごと**の内訳。行を押すとここに降りる。
 *
 * 表がコースごとになったので、内訳はコースではなく脚質である。
 * 絞り込みで脚質を 1 つに決めているときも、比べられるように全脚質を出す。
 *
 * **測った行が無い脚質も並べる**（`measured: false`）。脚質の条件を持つスキルは、
 * 当たらない脚質では `screen.ts` が走らせる前に落としており、行そのものが無い。
 * 黙って行を減らすと「逃げでは効かない」のか「逃げは測っていない」のかが分からない。
 *
 * **発動位置の分布はここに出せない。** JSON が持っていないからである
 * （docs/webapp-design.md 6.6 節）。
 */
export function styleBreakdown(
  file: SkillListCourseFile,
  filter: SkillListFilter,
  skillId: string,
): readonly SkillListStyleRow[] {
  const skillIndex = file.skillIds.indexOf(skillId);
  if (skillIndex < 0) return [];
  const baselineIndex = file.baselines.findIndex((baseline) => baseline.id === filter.baseline);
  const wanted = baselineIndex < 0 ? 0 : baselineIndex;
  const out: SkillListStyleRow[] = [];
  for (const [styleIdx, style] of file.styles.entries()) {
    const empty: SkillListStyleRow = {
      style,
      label: styleLabel[style],
      measured: false,
      mean: 0,
      stdError: 0,
      triggerRate: 0,
      meanWhenTriggered: 0,
      bashin: 0,
    };
    let found: SkillListStyleRow | null = null;
    for (let row = 0; row < file.columns.length; row += 1) {
      if (file.columns.skill[row] !== skillIndex) continue;
      if (file.columns.baseline[row] !== wanted) continue;
      if (file.columns.style[row] !== styleIdx) continue;
      const mean = file.columns.mean[row]!;
      found = {
        ...empty,
        measured: true,
        mean,
        stdError: file.columns.stdError[row]!,
        triggerRate: file.columns.triggerRate[row]!,
        meanWhenTriggered: file.columns.meanWhenTriggered[row]!,
        bashin: secondsToBashin(mean, file.course.distance),
      };
      break;
    }
    out.push(found ?? empty);
  }
  return out;
}

/** 上位互換のひとまとまり。下位から順に並ぶ。 */
export interface SkillListGroup {
  readonly group: number;
  readonly members: readonly SkillListGroupMember[];
}

export interface SkillListGroupMember {
  readonly row: SkillListAggregate;
  /** 1 つ下位との差額（pt）。いちばん下位は総額そのもの。 */
  readonly costStep: number;
  /** 1 つ下位との短縮量の差（秒）。いちばん下位は短縮量そのもの。 */
  readonly meanStep: number;
}

/**
 * 上位互換のグループにまとめる（○ → ◎ → 鬼）。
 *
 * `cost.ts` のとおり、表示されているポイントは**そのスキルを持つまでの総額**で
 * ある。したがって上位への乗り換えは差額で見る。効果も同じで、上位に乗り換えて
 * 何秒増えるのかは差で見ないと分からない。
 *
 * 2 つ以上そろっているグループだけを返す。1 つしか無いものは乗り換えの話に
 * ならない。
 */
export function upgradeGroups(
  rows: readonly SkillListAggregate[],
  groupOf: (skillId: string) => number,
): readonly SkillListGroup[] {
  const byGroup = new Map<number, SkillListAggregate[]>();
  for (const row of rows) {
    const group = groupOf(row.skillId);
    if (group < 0) continue;
    const list = byGroup.get(group);
    if (list === undefined) byGroup.set(group, [row]);
    else list.push(row);
  }
  const out: SkillListGroup[] = [];
  for (const [group, list] of byGroup) {
    if (list.length < 2) continue;
    // 総額の小さいほうが下位である。
    const sorted = [...list].sort((a, b) => a.cost - b.cost);
    out.push({
      group,
      members: sorted.map((row, i) => ({
        row,
        costStep: i === 0 ? row.cost : row.cost - sorted[i - 1]!.cost,
        meanStep: i === 0 ? row.mean : row.mean - sorted[i - 1]!.mean,
      })),
    });
  }
  // 上位まで取ったときの短縮量が大きいグループから並べる。
  out.sort((a, b) => b.members.at(-1)!.row.mean - a.members.at(-1)!.row.mean);
  return out;
}

/** この版が振っていない軸。画面に「1 通りしか持っていない」と書くために使う。 */
export const FIXED_AXES = ['季節', '天候', 'バ場状態'] as const;
