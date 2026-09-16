/**
 * スキル一覧。全スキルの単体評価を**コースごとに**事前計算して配る。
 *
 * U-Tools のスキル評価は計算の根拠が見えず、特定のレース場での獲得バ身しか出ない。
 * こちらは共通乱数のペア比較で誤差付きの短縮量を出し、順位条件はフィールドで判定し、
 * 近似に依るスキルには印を付けられる。issue #83 と docs/roadmap.md を参照。
 *
 * **ここは型と取り決めだけを持つ。** 生成は `skill-list-cli.ts`、表示は `apps/web` にある。
 * 3 つが同じ形を見るように、形をここに 1 か所だけ置いてある。
 *
 * ## 決めてあること
 *
 * - **軸はコースである。距離帯ではない。** 距離帯の代表を 1 本ずつ選ぶと、
 *   同じ距離帯の中でコースが違えば効くスキルも違う（東京 芝2000m と京都 芝2200m は
 *   直線の長さも坂も違う）ことを表に出せない。距離帯は選ぶときの手がかりとして
 *   `SkillListCourse.category` に残すが、**行を畳む単位にはしない。**
 * - **1 コース 1 枚で配る。** 137 コースを 1 枚にすると 25 MB を超え、
 *   画面を開くたびにそれを取ることになる。コースを選んでから 1 枚だけ取る。
 *   どのコースが置いてあるかは `index.json`（`SkillListIndex`）が持つ。
 * - **基準個体のスタミナはコースごとの実測である。** だから `SkillListBaseline.id` は
 *   `normal` / `strong` の 2 つだけでよい（1 枚が 1 コースなので、id に距離帯を
 *   混ぜる必要が無い）。**この 2 つ以外を置かない。** 画面はこの id で絞る。
 * - **単位は秒で、正が速い。** バ身は画面での併記にとどめる。
 *   換算（1 バ身 = 2.5 m）がゲームからの裏取り前だからである（issue #52）。
 *   したがってこのファイルはバ身を持たない。
 * - **「単体」であって「限界」ではない。** 何も持っていない構成へ 1 つだけ足したときの差である。
 *   食い合うスキル（最終直線の加速どうし）は過大に出る。表にもそう書くこと。
 * - **値は相手の分布に依る**（`defaultFieldProfile`）。相手の作り方を変えたら表は作り直しになるので、
 *   版に相手の分布の識別子を含める。
 * - **画面はこの JSON を動的に取る。** バンドルに混ぜない（`pnpm e2e` がバンドルの上限を見ている）。
 */

import type { Fidelity } from '../../sim/src/skill/classify.ts';
import type { Style } from '../../sim/src/data/constants.ts';

/** 距離帯。`packages/sim/src/data/track.ts` の `Distance` と同じ並び。 */
export type SkillListCategory = 'SHORT' | 'MILE' | 'MIDDLE' | 'LONG';

/** 形の版。読む側が古い形を弾くために見る。 */
export const SKILL_LIST_FORMAT = 2;

/**
 * 基準個体の段。**この 2 つしか無い。**
 *
 * 1 枚が 1 コースなので、id に距離帯やバ場を混ぜる必要が無い。
 * 混ぜた版（format 1）では画面が段で絞れず、実データで絞り込みが全滅した。
 */
export type SkillListTier = 'normal' | 'strong';
export const SKILL_LIST_TIERS: readonly SkillListTier[] = ['normal', 'strong'];

/**
 * 表が何から作られたかの識別子。**版はこの 5 つで決まる。**
 *
 * データだけを見ていると計算式の変更を取りこぼし、計算式だけを見ていると
 * スキルが増えたことに気付けない。相手の分布と基準個体は表の値そのものを動かす。
 * どれか 1 つでも動いたら作り直しである。
 */
export interface SkillListDataset {
  /** `packages/data/assets/skills.json` の指紋 */
  readonly skills: string;
  /** `packages/data/assets/courses.json` の指紋 */
  readonly courses: string;
  /** `packages/sim/upstream/race-manifest.json` の計算側の指紋をまとめたもの */
  readonly raceModel: string;
  /** 相手の束の作り方の識別子（`defaultFieldProfile` の中身から作る） */
  readonly fieldProfile: string;
  /**
   * 基準個体の決め方の識別子（`baselinePolicy` の中身から作る）。
   *
   * **これが無いと、基準を変えても版が同じままになる。** 骨格やスタミナの置き方を
   * 動かせば表の値は全部変わるのに、スキルデータもコースデータも計算式も動いていない。
   * 古い基準で測った表を新しい基準の表と取り違えることになる（しかも気付けない）。
   */
  readonly baseline: string;
}

/** 事前計算を回したときの条件。表の読み方がここで決まる。 */
export interface SkillListSettings {
  /** 1 行あたりの試行数。ペア比較なので基準と候補で同じ番号を使う。 */
  readonly trials: number;
  /** 順位条件を判定したか。false なら順位・距離差の条件は満たしている前提になる。 */
  readonly useField: boolean;
  readonly gateCount: number;
  readonly seed: number;
  /** バ場状態。1=良 2=稍重 3=重 4=不良 */
  readonly trackCondition: number;
}

/**
 * 基準になる個体。
 *
 * **表の信頼性はここで決まる。** 強さが違えばスキルの効き方も変わるので、
 * 1 段だけにすると「この表はどの個体の話か」が答えられなくなる。
 * 2 段持って幅で見せる。
 *
 * スタミナは**そのコースで実測した値**である（`skill-list-stamina.json`）。
 */
export interface SkillListBaseline {
  readonly id: SkillListTier;
  /** 画面に出す名前（「強い」「普通」） */
  readonly label: string;
  readonly speed: number;
  readonly stamina: number;
  readonly power: number;
  readonly guts: number;
  readonly wisdom: number;
}

/** 表に載せたコース。 */
export interface SkillListCourse {
  readonly location: number;
  readonly course: number;
  /** 「東京」 */
  readonly locationName: string;
  /** 「芝2400m」 */
  readonly courseName: string;
  readonly distance: number;
  /** 1=芝 2=ダート */
  readonly surface: number;
  /** 距離帯。**絞り込みの手がかりであって、行を畳む単位ではない。** */
  readonly category: SkillListCategory;
}

/**
 * そのコースで最大スパートに要るスタミナ。**基準個体の値ではない。**
 *
 * 基準個体のスタミナは育成の上限に置いてある（`skill-list-stamina.ts`）。
 * これは「そのコースがどれだけスタミナを要るか」の実測で、
 * **上限でも足りないコースがどれかを画面が言うため**に持つ。
 * 京都 芝3000m は p50 が 1225 で上限の 1200 を超える。そこで回復スキルが
 * 上位を占めるのは、モデルの都合ではなくコースの性質である。
 */
export interface StaminaDemand {
  /** 50 パーセンタイル。五分五分で最大スパートが出る量。 */
  readonly p50: number;
  /** 90 パーセンタイル。ほぼ確実に出る量。 */
  readonly p90: number;
}

/**
 * 基準個体のスタミナ。**育成が終わった時点のステータスの上限である。**
 *
 * 契約の側に置いてあるのは、画面もテストもこの値で「余裕があるか」を判断するからである。
 */
export const STAMINA_CAP = 1200;

/**
 * 「スタミナが縛りになっていない」と言える余裕。**実測で決めた。**
 *
 * 最大スパートに要る量の 90 パーセンタイルからどれだけ離れているかで、
 * 上位 20 に占める回復スキルの割合がこう動く（試行 100、脚質をまとめた平均）。
 *
 * | 余裕 | 回復 |
 * | ---: | ---: |
 * | 475〜1000 | 0〜5 % |
 * | 250 | 15 % |
 * | 50 | 85 % |
 *
 * 15 % は買えるスキルに占める回復スキルの割合とほぼ同じなので、250 を境にする。
 * **連続した量に引いた線であって、ここに段差があるわけではない。**
 *
 * スタミナは最大スパートの可否だけでなく、スパートを保てる距離
 * （`calcSpurtDistance`）にも効く。だから 90 パーセンタイルを超えたくらいでは
 * まだ足りず、余裕が要る。
 */
export const STAMINA_MARGIN = 250;

/** 基準個体のスタミナが、そのコースの要りようからどれだけ離れているか。 */
export function staminaHeadroom(file: SkillListCourseFile): number | null {
  const demand = file.staminaDemand;
  const stamina = file.baselines[0]?.stamina;
  if (demand === undefined || demand === null || stamina === undefined) return null;
  return stamina - demand.p90;
}

/**
 * このコースではスタミナが縛りになっているか。
 *
 * **true のコースで回復スキルが上位を占めるのは正しい。** 基準個体の置き方の
 * せいではなく、上限まで持たせてもまだ足りないというコースの性質である。
 */
export function isStaminaBinding(file: SkillListCourseFile): boolean {
  const headroom = staminaHeadroom(file);
  return headroom !== null && headroom < STAMINA_MARGIN;
}

/** コースを一意に指す鍵。ファイル名にもこれを使う。 */
export function skillListCourseKey(location: number, course: number): string {
  return `${location}-${course}`;
}

/**
 * 1 行ぶんの値。**ファイルの中では列ごとに分けて持つ**（`SkillListColumns`）。
 *
 * 行を素直に並べると 1 コースで数 MB になる。読む側はこの形に戻して使う。
 * **コースは列に持たない。** 1 枚が 1 コースだからである。
 */
export interface SkillListRow {
  readonly skillId: string;
  readonly baseline: SkillListTier;
  readonly style: Style;
  /** 短縮量の平均。秒、正が速い。 */
  readonly mean: number;
  readonly stdError: number;
  /** 発動した試行の割合。0 から 1。 */
  readonly triggerRate: number;
  /**
   * 発動した試行だけで見た短縮量。秒。
   *
   * `mean` と分けて持つのは、「発動しにくいが刺さる」と「常に少し効く」を
   * 区別できるようにするためである。発動が 0 のときは NaN ではなく 0 を入れる。
   */
  readonly meanWhenTriggered: number;
  /** そのスキルを持つまでの総額（`cost.ts` の定義）。 */
  readonly cost: number;
  /** 1 ポイントあたりの短縮量。秒 / pt。`cost` が 0 なら 0。 */
  readonly efficiency: number;
  /** 再現度の印（`classify.ts`）。走らせなくても条件式から決まる。 */
  readonly fidelity: Fidelity;
}

/**
 * ファイルの中身。行は列ごとの配列で持つ。
 *
 * 同じ長さの配列を並べ、`i` 番目が 1 行になる。文字列の列（スキル ID、基準、脚質、印）は
 * `*Ids` の一覧への添字にして、同じ語を何万回も書かないようにする。
 */
export interface SkillListColumns {
  /** 行数。すべての列がこの長さになる。 */
  readonly length: number;
  /** `skillIds` への添字 */
  readonly skill: readonly number[];
  /** `baselines` への添字 */
  readonly baseline: readonly number[];
  /** `styles` への添字 */
  readonly style: readonly number[];
  readonly mean: readonly number[];
  readonly stdError: readonly number[];
  readonly triggerRate: readonly number[];
  readonly meanWhenTriggered: readonly number[];
  readonly cost: readonly number[];
  /** `fidelities` への添字 */
  readonly fidelity: readonly number[];
}

/** 配る JSON そのもの。**1 枚が 1 コース。** */
export interface SkillListCourseFile {
  readonly format: typeof SKILL_LIST_FORMAT;
  /** 中身の版。`SkillListDataset` から作る短い文字列。 */
  readonly version: string;
  /** 生成した時刻（ISO 8601） */
  readonly generatedAt: string;
  readonly dataset: SkillListDataset;
  /** **この 1 枚を回したときの条件。** 分けて回すと版の中で揃っていないことがある。 */
  readonly settings: SkillListSettings;
  readonly course: SkillListCourse;
  readonly baselines: readonly SkillListBaseline[];
  /**
   * そのコースがスタミナをどれだけ要るか。測っていなければ無い。
   *
   * 基準個体の値ではなく、**表の読み方の説明**である（`StaminaDemand`）。
   */
  readonly staminaDemand?: StaminaDemand | null;
  /** 列の添字が引く一覧 */
  readonly skillIds: readonly string[];
  readonly styles: readonly Style[];
  readonly fidelities: readonly Fidelity[];
  readonly columns: SkillListColumns;
  /**
   * 走らせずに落とした組の数（`screen.ts` が落としたもの）。
   *
   * 行が無いことには「発動しない」と「測っていない」の 2 通りがあるので、
   * 落とした数を持って画面で区別できるようにする。
   */
  readonly screenedOut: number;
  /** 実際に走らせたレース数と所要時間。作り直しの見積もりに使う。 */
  readonly races: number;
  readonly elapsedMs: number;
}

/** `index.json` に並ぶ 1 コース。 */
export interface SkillListIndexEntry {
  readonly course: SkillListCourse;
  /** `skill-list/` から見た相対のパス（例 `v2-a1b2c3d4e5f6/10006-10606.json`） */
  readonly file: string;
  readonly rows: number;
  /**
   * この 1 枚の試行数。**版の中で揃っているとは限らない。**
   * 137 コースは 1 回では回りきらないので、分けて回したぶんがここに出る。
   */
  readonly trials: number;
  readonly generatedAt: string;
}

/**
 * 版とコースの一覧。`skill-list/index.json` に置く。
 *
 * **読む側は版もコースのファイル名も当てられない。** 版はデータと計算式と相手の分布の
 * 指紋から決まり、置いてあるコースは回した範囲で決まる。名前を教える 1 枚をあいだに置く。
 *
 * **ここに無いコースは測っていない。** 全 137 コースを 1 回で回すには何十時間もかかるので、
 * 部分的にしか置いていないのが普通の状態である。画面はそう書く。
 */
export interface SkillListIndex {
  readonly format: typeof SKILL_LIST_FORMAT;
  /** いまの版 */
  readonly version: string;
  /** `index.json` を最後に書いた時刻（ISO 8601） */
  readonly generatedAt: string;
  readonly dataset: SkillListDataset;
  /** 直近に回したときの条件。**1 枚ごとの正は course ファイルの側にある。** */
  readonly settings: SkillListSettings;
  /** 載っているコース。場と距離の順に並べる。 */
  readonly courses: readonly SkillListIndexEntry[];
  /** 置いてある版のディレクトリ。新しい順。入れ替えの最中に古い画面が取りに来るので残す。 */
  readonly generations: readonly string[];
}

/** 列の形から 1 行を組み立てる。 */
export function skillListRowAt(file: SkillListCourseFile, index: number): SkillListRow {
  const c = file.columns;
  const cost = c.cost[index]!;
  const mean = c.mean[index]!;
  return {
    skillId: file.skillIds[c.skill[index]!]!,
    baseline: file.baselines[c.baseline[index]!]!.id,
    style: file.styles[c.style[index]!]!,
    mean,
    stdError: c.stdError[index]!,
    triggerRate: c.triggerRate[index]!,
    meanWhenTriggered: c.meanWhenTriggered[index]!,
    cost,
    efficiency: cost === 0 ? 0 : mean / cost,
    fidelity: file.fidelities[c.fidelity[index]!]!,
  };
}

/** 読んだ JSON が版とコースの一覧かを確かめる。配る先が古い版を持っていることがある。 */
export function isSkillListIndex(value: unknown): value is SkillListIndex {
  if (typeof value !== 'object' || value === null) return false;
  const index = value as Partial<SkillListIndex>;
  if (index.format !== SKILL_LIST_FORMAT) return false;
  if (typeof index.version !== 'string') return false;
  return Array.isArray(index.courses);
}

/** 読んだ JSON がコース 1 枚かを確かめる。 */
export function isSkillListCourseFile(value: unknown): value is SkillListCourseFile {
  if (typeof value !== 'object' || value === null) return false;
  const file = value as Partial<SkillListCourseFile>;
  if (file.format !== SKILL_LIST_FORMAT) return false;
  if (typeof file.version !== 'string') return false;
  if (typeof file.course !== 'object' || file.course === null) return false;
  if (!Array.isArray(file.skillIds) || !Array.isArray(file.baselines)) return false;
  const columns = file.columns;
  if (typeof columns !== 'object' || columns === null) return false;
  return typeof (columns as SkillListColumns).length === 'number';
}
