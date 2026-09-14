/**
 * スキル一覧。全スキルの単体評価を事前に計算して配る。
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

/**
 * 表が何から作られたかの識別子。**版はこの 4 つで決まる。**
 *
 * データだけを見ていると計算式の変更を取りこぼし、計算式だけを見ていると
 * スキルが増えたことに気付けない。相手の分布は表の値そのものを動かす。
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
 */
export interface SkillListBaseline {
  /** `strong` / `normal` のような短い識別子。行から引く鍵になる。 */
  readonly id: string;
  /** 画面に出す名前（「強い」「普通」） */
  readonly label: string;
  readonly speed: number;
  readonly stamina: number;
  readonly power: number;
  readonly guts: number;
  readonly wisdom: number;
}

/** 表に載せたコース。距離帯ごとの代表である。 */
export interface SkillListCourse {
  readonly location: number;
  readonly course: number;
  /** 「東京」 */
  readonly locationName: string;
  /** 「芝2400m（内）」 */
  readonly courseName: string;
  readonly distance: number;
  /** 1=芝 2=ダート */
  readonly surface: number;
  readonly category: SkillListCategory;
}

/**
 * 1 行ぶんの値。**ファイルの中では列ごとに分けて持つ**（`SkillListColumns`）。
 *
 * 行を素直に並べると 3 万行で数十 MB になる。読む側はこの形に戻して使う。
 */
export interface SkillListRow {
  readonly skillId: string;
  /** `SkillListBaseline.id` */
  readonly baseline: string;
  readonly style: Style;
  /** `SkillListCourse.course` */
  readonly course: number;
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
  /** `courses` への添字 */
  readonly course: readonly number[];
  readonly mean: readonly number[];
  readonly stdError: readonly number[];
  readonly triggerRate: readonly number[];
  readonly meanWhenTriggered: readonly number[];
  readonly cost: readonly number[];
  /** `fidelities` への添字 */
  readonly fidelity: readonly number[];
}

/** 配る JSON そのもの。 */
export interface SkillListFile {
  /** 形の版。読む側が古い形を弾くために見る。 */
  readonly format: 1;
  /** 中身の版。`SkillListDataset` から作る短い文字列。 */
  readonly version: string;
  /** 生成した時刻（ISO 8601） */
  readonly generatedAt: string;
  readonly dataset: SkillListDataset;
  readonly settings: SkillListSettings;
  readonly baselines: readonly SkillListBaseline[];
  readonly courses: readonly SkillListCourse[];
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

/** 列の形から 1 行を組み立てる。 */
export function skillListRowAt(file: SkillListFile, index: number): SkillListRow {
  const c = file.columns;
  const cost = c.cost[index]!;
  const mean = c.mean[index]!;
  return {
    skillId: file.skillIds[c.skill[index]!]!,
    baseline: file.baselines[c.baseline[index]!]!.id,
    style: file.styles[c.style[index]!]!,
    course: file.courses[c.course[index]!]!.course,
    mean,
    stdError: c.stdError[index]!,
    triggerRate: c.triggerRate[index]!,
    meanWhenTriggered: c.meanWhenTriggered[index]!,
    cost,
    efficiency: cost === 0 ? 0 : mean / cost,
    fidelity: file.fidelities[c.fidelity[index]!]!,
  };
}

/**
 * 版を教える 1 枚。`skill-list/index.json` に置く。
 *
 * **読む側は版を当てられない。** 版はデータと計算式と相手の分布の指紋から決まるので、
 * 画面がファイル名を組み立てることはできない。名前を教える 1 枚をあいだに置く。
 *
 * `index.json` がそのまま `SkillListFile` でも読めるようにしてある
 * （1 枚しか置かない作りを選んだとき用）。読む側は `latest` の有無で見分ける。
 */
export interface SkillListIndex {
  /** いまの版のファイル名（`skill-list/` から見た相対。例 `a1b2c3-d4e5f6.json`） */
  readonly latest: string;
  /** 置いてある版。新しい順。入れ替えの最中に古い画面が取りに来るので 1 世代前まで残す。 */
  readonly generations: readonly string[];
}

/** `index.json` が版を教える 1 枚かを見分ける。`latest` が無ければ表そのものである。 */
export function isSkillListIndex(value: unknown): value is SkillListIndex {
  if (typeof value !== 'object' || value === null) return false;
  const index = value as Partial<SkillListIndex>;
  return typeof index.latest === 'string' && index.latest !== '';
}

/** 読んだ JSON がこの形かを確かめる。配る先が古い版を持っていることがある。 */
export function isSkillListFile(value: unknown): value is SkillListFile {
  if (typeof value !== 'object' || value === null) return false;
  const file = value as Partial<SkillListFile>;
  if (file.format !== 1) return false;
  if (typeof file.version !== 'string') return false;
  if (!Array.isArray(file.skillIds) || !Array.isArray(file.courses)) return false;
  const columns = file.columns;
  if (typeof columns !== 'object' || columns === null) return false;
  return typeof (columns as SkillListColumns).length === 'number';
}
