import { bashinMeters } from '../../../packages/sim/src/data/constants.ts';
import type { Style } from '../../../packages/sim/src/data/constants.ts';
import { worseFidelity, type Fidelity } from '../../../packages/sim/src/skill/classify.ts';
import {
  isSkillListFile,
  isSkillListIndex,
  type SkillListCategory,
  type SkillListCourse,
  type SkillListFile,
} from '../../../packages/solver/src/skill-list.ts';

/**
 * 事前計算したスキル一覧（[#83](https://github.com/promodeler314-a11y/raceemu/issues/83)）を
 * 読む側。形の取り決めは `packages/solver/src/skill-list.ts` にある。
 *
 * ここは**読むだけ**である。生成は `pnpm skill-list`、置き場は
 * `apps/web/public/skill-list/` で、どちらも生成側の領分である。
 * 決めたことと理由は docs/webapp-design.md 6.6 節にある。
 *
 * ## 取れないことは普通に起きる
 *
 * 配布物には**静的ファイルだけを置いた版**があり、そこには事前計算の JSON を
 * 載せていないことがある（数 MB あるので、置くかどうかは配る人が決める）。
 * 認証や proxy が 200 で HTML を返す経路もある。`searchApi.ts` と同じく、
 * 状態番号ではなく**中身が JSON かどうか**で判断し、取れなければ日本語で
 * 言い分けて画面は動き続ける。
 */

/** 版の一覧。ここを最初に見る。 */
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
  if (res.status === 404) return 'この配布物にはスキル一覧の表が入っていない。';
  if (res.redirected) return `表ではなく別の画面に飛ばされた（最終 ${res.status}）。`;
  // 「JSON」のような生の語は画面に出さない。読む人に用が無いうえ、
  // 例外がそのまま出ているのか、こちらが言っているのかが見分けられない。
  return `表の代わりに、別の形の応答が返った（${res.status}）。無いパスを画面に落とす配り方をしていると、ここに来る。`;
}

/** JSON を 1 枚取る。JSON でなければ「無い」に倒す。 */
async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (error) {
    throw new SkillListUnavailable(
      `表を取りに行けなかった（${error instanceof Error ? error.message : String(error)}）`,
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
 * 表を取る。`index.json` が版の一覧なら、そこから本体を取りに行く。
 *
 * `base` を引数にしてあるのはテストのためである。画面からは既定のまま呼ぶ。
 */
export async function fetchSkillList(
  indexUrl: string = SKILL_LIST_INDEX_URL,
  signal?: AbortSignal,
): Promise<SkillListFile> {
  const first = await fetchJson(indexUrl, signal);
  // 版を教える 1 枚か、表そのものか。見分けは契約側（`isSkillListIndex`）に任せる。
  if (isSkillListFile(first)) return first;
  if (!isSkillListIndex(first)) {
    throw new SkillListBroken(
      'スキル一覧の形が読めない。配ってある版が古いか、別のファイルが置かれている。',
    );
  }
  const body = await fetchJson(indexUrl.replace(/[^/]*$/, first.latest), signal);
  if (!isSkillListFile(body)) {
    throw new SkillListBroken(`版 ${first.latest} の形が読めない。配ってある版が古い。`);
  }
  return body;
}

/** 画面が読むときの失敗の言い分け。例外の型ごとに文面を変える。 */
export function explainSkillListError(error: unknown): string {
  if (error instanceof SkillListUnavailable) {
    return `${error.message} この面は事前に計算した表を読むだけなので、表が無いと何も出せない。表は \`pnpm skill-list\` が作り、\`apps/web/public/skill-list/\` に置く。`;
  }
  if (error instanceof SkillListBroken) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ */
/* 絞り込みと集計。ここから下は純粋な関数で、テストが固定する。        */
/* ------------------------------------------------------------------ */

/**
 * 絞り込みの軸。**この版の JSON が持っている軸だけを置く。**
 *
 * issue は季節と天候とバ場状態でも絞ると書いているが、`SkillListSettings` の
 * とおり、いまの版はそれらを振っていない（固定で 1 通り）。無い軸の選択欄を
 * 出すと、選べるのに何も変わらないものになる。画面には「1 通りしか持って
 * いない」と書く。
 */
export interface SkillListFilter {
  /** 距離帯。`ALL` は全部。 */
  readonly category: SkillListCategory | 'ALL';
  /** 脚質。`ALL` は全部。 */
  readonly style: Style | 'ALL';
  /** バ場。0 は全部、1 は芝、2 はダート。 */
  readonly surface: 0 | 1 | 2;
  /**
   * 基準になる個体の**段**（`normal` / `strong`）。空なら先頭の段。
   *
   * **個体そのものではなく段である。** 生成側は距離帯とバ場ごとに別の個体を
   * 置いている（長距離の基準個体は短距離のそれよりスタミナが多い）ので、
   * `baselines` は段の数より多い。どの個体が使われるかはコースから決まるので、
   * 利用者が選ぶのは段だけでよい。`baselineTier` を参照。
   */
  readonly baseline: string;
}

export const DEFAULT_SKILL_LIST_FILTER: SkillListFilter = {
  category: 'ALL',
  style: 'ALL',
  surface: 0,
  baseline: '',
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
  /** 平均に入った行数（コース × 脚質）。 */
  readonly rows: number;
  /** バ身の目安。`secondsToBashin` を行ごとに掛けて平均したもの。 */
  readonly bashin: number;
}

/** コースごとの内訳。行を押したときに降りる先。 */
export interface SkillListCourseRow {
  readonly course: SkillListCourse;
  readonly mean: number;
  readonly stdError: number;
  readonly triggerRate: number;
  readonly bashin: number;
  readonly rows: number;
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
 * 基準個体の id から**段**を取り出す。
 *
 * 生成側は `<段>:<バ場>:<距離帯>`（例 `normal:1:MIDDLE`）という複合の id を
 * 使っているが、**契約（`packages/solver/src/skill-list.ts`）はこの形を強制して
 * いない。** 例示は `normal` / `strong` のままである。だから画面は形を決め打ちせず、
 * 「区切りがあればその手前、無ければ全体」とだけ決める。
 * 生成側が 1 段 1 個体に戻しても、そのまま動く。
 */
export function baselineTier(id: string): string {
  const separator = id.indexOf(':');
  return separator < 0 ? id : id.slice(0, separator);
}

/** 選択欄に出す段。`label` は同じ段の最初の個体のものを使う。 */
export interface SkillListTier {
  readonly id: string;
  readonly label: string;
}

/**
 * 段の一覧。重複を落として、`baselines` に出てくる順に返す。
 *
 * 16 件の `baselines` をそのまま選択欄に出すと「普通」が 8 個並んで区別できない。
 * 出すべきは段の 2 つである。
 */
export function baselineTiers(file: SkillListFile): readonly SkillListTier[] {
  const out: SkillListTier[] = [];
  const seen = new Set<string>();
  for (const baseline of file.baselines) {
    const tier = baselineTier(baseline.id);
    if (seen.has(tier)) continue;
    seen.add(tier);
    out.push({ id: tier, label: baseline.label });
  }
  return out;
}

/** 絞り込みに当たるかどうかを、列の添字だけで判定できる形に畳んだもの。 */
interface CourseFacts {
  readonly category: SkillListCategory;
  readonly surface: number;
  readonly distance: number;
}

function courseFacts(file: SkillListFile): readonly CourseFacts[] {
  return file.courses.map((course) => ({
    category: course.category,
    surface: course.surface,
    distance: course.distance,
  }));
}

/**
 * 走る前に決まる、絞り込みの当たり判定。
 *
 * **基準個体は段で絞る。** 個体 1 つに固定すると、その個体が割り当てられた
 * 距離帯とバ場の行しか当たらない。生成側は距離帯とバ場ごとに別の個体を置いて
 * いるので、「全距離帯」を選んでいるのに芝短距離の行しか出ない、という壊れ方を
 * した（実データで 4 通りのうち 3 通りが 0 件になった）。
 * 距離帯とバ場はコースの側で絞れば足りる。
 */
function matcher(file: SkillListFile, filter: SkillListFilter) {
  const facts = courseFacts(file);
  const tiers = baselineTiers(file);
  // 知らない段を渡されたら先頭に落とす。選択欄には在るものしか出さないので、
  // ここに来るのは版が入れ替わった直後くらいである。黙って全段を混ぜるより、
  // 1 段に寄せたほうが読み手を欺かない。
  const wanted = tiers.some((tier) => tier.id === filter.baseline) ? filter.baseline : tiers[0]?.id;
  const allowedBaselines =
    wanted === undefined
      ? null
      : new Set(
          file.baselines
            .map((baseline, index) => [baselineTier(baseline.id), index] as const)
            .filter(([tier]) => tier === wanted)
            .map(([, index]) => index),
        );
  const styleIndex = filter.style === 'ALL' ? -1 : file.styles.indexOf(filter.style);
  return (row: number): boolean => {
    if (allowedBaselines !== null && !allowedBaselines.has(file.columns.baseline[row]!)) {
      return false;
    }
    if (filter.style !== 'ALL' && file.columns.style[row] !== styleIndex) return false;
    const course = facts[file.columns.course[row]!];
    if (course === undefined) return false;
    if (filter.category !== 'ALL' && course.category !== filter.category) return false;
    if (filter.surface !== 0 && course.surface !== filter.surface) return false;
    return true;
  };
}

/** 足し込みの途中。平均と誤差をまとめて出すための入れ物。 */
interface Accumulator {
  sum: number;
  sumVariance: number;
  sumTrigger: number;
  sumWhenTriggered: number;
  sumBashin: number;
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
    sumBashin: 0,
    cost: 0,
    fidelity: 'exact',
    rows: 0,
  };
}

function add(acc: Accumulator, file: SkillListFile, row: number, distance: number): void {
  const c = file.columns;
  const mean = c.mean[row]!;
  const stdError = c.stdError[row]!;
  acc.sum += mean;
  acc.sumVariance += stdError * stdError;
  acc.sumTrigger += c.triggerRate[row]!;
  acc.sumWhenTriggered += c.meanWhenTriggered[row]!;
  acc.sumBashin += secondsToBashin(mean, distance);
  acc.cost = c.cost[row]!;
  acc.fidelity = worseFidelity(acc.fidelity, file.fidelities[c.fidelity[row]!] ?? 'exact');
  acc.rows += 1;
}

/**
 * 絞り込みに当たる行を、スキルごとに平均する。
 *
 * **コースどうしと脚質どうしは別々に走らせてある**ので、平均の誤差は
 * 二乗和の平方根を行数で割ったものにする（独立と見なす）。同じ試行番号で
 * 引き算した 1 行ぶんの誤差より、こちらのほうが素直である。
 */
export function aggregate(
  file: SkillListFile,
  filter: SkillListFilter,
): readonly SkillListAggregate[] {
  const facts = courseFacts(file);
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
    add(acc, file, row, facts[file.columns.course[row]!]!.distance);
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
      bashin: acc.sumBashin / acc.rows,
    });
  }
  out.sort((a, b) => b.mean - a.mean);
  return out;
}

/**
 * 1 スキルのコースごとの内訳。
 *
 * 絞り込みで脚質を全部にしているときは、コースの中で脚質を平均する。
 * **発動位置の分布はここに出せない。** JSON が持っていないからである
 * （docs/webapp-design.md 6.6 節）。
 */
export function courseBreakdown(
  file: SkillListFile,
  filter: SkillListFilter,
  skillId: string,
): readonly SkillListCourseRow[] {
  const skillIndex = file.skillIds.indexOf(skillId);
  if (skillIndex < 0) return [];
  const facts = courseFacts(file);
  const matches = matcher(file, filter);
  const byCourse = new Map<number, Accumulator>();
  for (let row = 0; row < file.columns.length; row += 1) {
    if (file.columns.skill[row] !== skillIndex) continue;
    if (!matches(row)) continue;
    const course = file.columns.course[row]!;
    let acc = byCourse.get(course);
    if (acc === undefined) {
      acc = emptyAccumulator();
      byCourse.set(course, acc);
    }
    add(acc, file, row, facts[course]!.distance);
  }
  const out: SkillListCourseRow[] = [];
  for (const [course, acc] of byCourse) {
    out.push({
      course: file.courses[course]!,
      mean: acc.sum / acc.rows,
      stdError: Math.sqrt(acc.sumVariance) / acc.rows,
      triggerRate: acc.sumTrigger / acc.rows,
      bashin: acc.sumBashin / acc.rows,
      rows: acc.rows,
    });
  }
  out.sort((a, b) => b.mean - a.mean);
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
