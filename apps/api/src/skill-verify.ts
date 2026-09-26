import sharp from 'sharp';
import type { SkillData } from '../../../packages/sim/src/skill/types.ts';
import { nameSimilarity, normalizeSkillName } from '../../../packages/data/src/skill-match.ts';
import type { OcrEngine } from './ocr.ts';
import type { RowCrop } from './skill-classifier.ts';

/**
 * 分類モデルが名前を知らないスキルを、文字認識で拾い直す。
 *
 * ## なぜ要るか
 *
 * モデルは学習した時点のスキルしか分類できない（`skill-classifier.ts`）。
 * 知らないスキルを見せられたとき、モデルは「分からない」とは言わない。
 * **見た目のいちばん近い既知のスキルを、確信度 1.0 近くで返す。** 確信度では
 * 見分けられないので、読み取りが静かに間違う。
 *
 * データのほうは週次で追随しているので、差は開く一方である。2026-09-21 の
 * 取り直しの時点で、うちの 2120 件のうち 85 件をモデルが名前を知らず、そのうち
 * 31 件は誰でも取れる normal / rare だった（先導者、急先鋒、レースメイカー、
 * 奥の手 …）。しかも配布元は学習し直しておらず、**取り直しても直らない**
 * （docs/ocr-design.md 6.6 節）。
 *
 * ## どう直すか
 *
 * 分類器は行ごとに「文字だけの帯」を切り出しており、確信度がいちばん高かった
 * 位置を `crop` として返す。同じ帯を文字認識にかけ、読めた文字を
 * **分類器の答えと比べて**判定する（`ReadingJudge`）。
 *
 * - 読めた文字が、分類器の答えを含むどの名前よりも、はっきり語彙に無いスキルに
 *   近ければ、そちらに置き換える。
 * - 置き換えるほどではないが、読めた文字にいちばん近いのが語彙に無いスキルで、
 *   分類器の答えからははっきり離れていれば、そのスキルを「要確認」として出す。
 * - それ以外は分類器の答えに手を出さない。読めた文字が別の**既知の**スキルを
 *   指していても同じである。語彙に有るスキルどうしなら分類器のほうが確かで、
 *   `右回り◎` を `右回り○` と読み違えた程度で正しい答えを疑わせたくない。
 *
 * 以前は「語彙に無いスキルと 0.85 以上で一致すること」「4 文字以下は完全一致」
 * という絶対的な下限で判定していた。文字認識は丸いアイコンや装飾つきの背景に弱く
 * （docs/ocr-design.md 5 節）、実機の帯ではこの下限に届かないまま分類器の誤答が
 * 残った。**絶対的な近さではなく、対抗との差で決める**と、1 文字読み違えた
 * 3 文字の名前（0.67）でも、分類器の答えとの差がはっきりしていれば拾える。
 * 詳しくは docs/ocr-design.md 6.7 節。
 *
 * 読み取れなければ（帯が空、文字が潰れている）何も起きず、分類器の答えが
 * そのまま残る。直せない行は直せないままだが、悪くもならない。
 *
 * ## 費用
 *
 * 帯は 400×28 程度しかないので、1 つあたり 50ms ほどで読める。画面全体を
 * 読むのとは桁が違う。16 行（32 帯）で 1.6 秒、何画面分もつないだ 32 行
 * （64 帯）でも 3 秒ほどで、分類器自身の推論（行あたり 16 回）に上乗せしても
 * ゲートウェイの待ちには収まる。判定は 1 帯あたり全スキルとの編集距離で、
 * 読み取りに比べれば無視できる。
 */

/** 読めた文字をある名前と認める下限。全文の読み取り（docs/ocr-design.md 3.2 節）と同じ。 */
const MIN_SCORE = 0.6;
/**
 * 短い名前の下限。3 文字の名前の 1 文字違い（0.67）までは認め、2 文字の名前には
 * 完全一致を求める。短い名前は別の短い名前とも近くなりやすいが、そこは
 * 下限ではなく対抗との差（`CONTRAST`）で見る。
 */
const SHORT_NAME_LENGTH = 4;
const SHORT_NAME_MIN_SCORE = 0.66;
/**
 * いちばん近い名前が、対抗よりこれだけ近いこと。
 *
 * 3 文字の名前なら 1 文字ぶん（0.33）の差に当たる。分類器の答えを覆すのだから、
 * **取りこぼしより誤りのほうが重い**。文字認識が分類器の答えをそれなりに
 * 読めているなら（語彙に有るスキルの行はふつうそうなる）、この差は生まれない。
 */
const CONTRAST = 0.25;

/** 切り出した帯を文字認識に渡す前に何倍にするか。28px 前後の帯はそのままでは低すぎる。 */
const UPSCALE = 3;

/**
 * モデルが名前を知らないスキルを選び出す。
 *
 * 突き合わせは ID ではなく**正規化した名前**で行う。固有とその継承版のように
 * 名前が同じで ID が違うものがあり、対応表はその片方（継承版）しか指さない。
 * ID で見ると、モデルが見た目を知っている固有まで「知らない」側に落ちる。
 */
export function skillsUnknownToClassifier(
  skills: Iterable<SkillData>,
  classifierSkillIds: Iterable<string>,
): SkillData[] {
  const all = [...skills];
  const known = knownNames(all, classifierSkillIds);
  return all.filter((skill) => {
    const key = normalizeSkillName(skill.name);
    return key !== '' && !known.has(key);
  });
}

function knownNames(skills: readonly SkillData[], classifierSkillIds: Iterable<string>): Set<string> {
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const known = new Set<string>();
  for (const id of classifierSkillIds) {
    const skill = byId.get(id);
    if (skill !== undefined) known.add(normalizeSkillName(skill.name));
  }
  return known;
}

/**
 * 読めた文字と分類器の答えを比べた結果。
 * `score` は読めた文字と `skill` の名前の近さ、`margin` は対抗との差。
 */
export type Verdict =
  /** 分類器の答えのままにする。 */
  | { readonly kind: 'keep' }
  /** 語彙に無いスキルに置き換える。 */
  | { readonly kind: 'replace'; readonly skill: SkillData; readonly score: number; readonly margin: number }
  /** 語彙に無いスキルらしいが、対抗との差が小さい。人に確かめてもらう。 */
  | { readonly kind: 'doubt'; readonly skill: SkillData; readonly score: number; readonly margin: number };

const KEEP: Verdict = { kind: 'keep' };

interface JudgeEntry {
  readonly skill: SkillData;
  readonly key: string;
  /** モデルが名前を知っているか */
  readonly known: boolean;
}

/**
 * 読めた文字から、分類器の答えを覆すかどうかを決める。
 * 文字認識を持たないので、帯を読まずに判定だけを検査できる。
 */
export class ReadingJudge {
  /** 名前ごとに 1 つ。固有と継承版のように同じ名前のものは、先に出たほうで代表させる。 */
  private readonly entries: JudgeEntry[];

  constructor(skills: Iterable<SkillData>, classifierSkillIds: Iterable<string>) {
    const all = [...skills];
    const known = knownNames(all, classifierSkillIds);
    const seen = new Set<string>();
    this.entries = [];
    for (const skill of all) {
      const key = normalizeSkillName(skill.name);
      if (key === '' || seen.has(key)) continue;
      seen.add(key);
      this.entries.push({ skill, key, known: known.has(key) });
    }
  }

  /**
   * @param text 帯から読めた文字
   * @param predicted 分類器の答え。答えが無い（確信度が低い、うちのデータに無い）なら null
   */
  judge(text: string, predicted: SkillData | null): Verdict {
    const key = normalizeSkillName(text);
    if (key === '') return KEEP;
    const predictedKey = predicted === null ? null : normalizeSkillName(predicted.name);
    const predictedScore = predictedKey === null ? 0 : nameSimilarity(key, predictedKey);

    let best: { entry: JudgeEntry; score: number } | null = null;
    let secondScore = 0;
    let bestUnknown: { entry: JudgeEntry; score: number } | null = null;
    for (const entry of this.entries) {
      // 編集距離は長さの差を下回らない。長さの差だけで 2 番目にも届かないと
      // 分かる既知の名前は、距離を求めずに飛ばす。結果は変わらない。
      // 語彙に無い名前は 85 件ほどしかないので、いちばん近いものを必ず求める。
      if (entry.known && best !== null) {
        const length = Math.max(key.length, entry.key.length);
        if (1 - Math.abs(key.length - entry.key.length) / length <= secondScore) continue;
      }
      const score = nameSimilarity(key, entry.key);
      if (best === null || score > best.score) {
        secondScore = best?.score ?? 0;
        best = { entry, score };
      } else if (score > secondScore) {
        secondScore = score;
      }
      if (!entry.known && (bestUnknown === null || score > bestUnknown.score)) bestUnknown = { entry, score };
    }
    if (best === null || bestUnknown === null) return KEEP;

    // 語彙に無い名前が、読めた文字にいちばん近いこと（同点を含む）。既知の名前の
    // ほうが近ければ、語彙に有るスキルどうしの話なので分類器を信じる。
    if (bestUnknown.score < best.score) return KEEP;
    const floor = bestUnknown.entry.key.length <= SHORT_NAME_LENGTH ? SHORT_NAME_MIN_SCORE : MIN_SCORE;
    if (bestUnknown.score < floor) return KEEP;
    // 分類器の答えからはっきり離れていること。答えどおりに読めている行には手を出さない。
    if (bestUnknown.score - predictedScore < CONTRAST) return KEEP;

    // 置き換えは、他のどの名前にもはっきり勝っているときだけ。同点で並ぶ名前が
    // あれば `secondScore` がそれを拾う。
    const rival = best.entry === bestUnknown.entry ? Math.max(secondScore, predictedScore) : best.score;
    const margin = bestUnknown.score - rival;
    const kind = margin >= CONTRAST ? 'replace' : 'doubt';
    return { kind, skill: bestUnknown.entry.skill, score: bestUnknown.score, margin };
  }
}

export interface VerifyRow {
  readonly crop: RowCrop;
  readonly predicted: SkillData | null;
}

export interface RowReading {
  /** 文字認識が読み取った生の文字。読めなければ空。 */
  readonly text: string;
  readonly verdict: Verdict;
}

export class SkillVerifier {
  constructor(
    private readonly ocr: OcrEngine,
    private readonly judge: ReadingJudge,
  ) {}

  /**
   * 行ごとの帯を 1 つずつ読む。
   *
   * まとめて 1 枚に貼って一度に読む手もあるが、行が 1 つ読み飛ばされただけで
   * それ以降の対応がずれ、**別の行の答えを別の行に書き込む**。1 行ずつ読めば
   * 対応を取り違えようがない。帯は 400×28 程度と小さく、1 枚あたりの費用は
   * 画面全体を読むのとは桁が違う。
   */
  async read(image: Buffer, rows: readonly VerifyRow[]): Promise<RowReading[]> {
    const readings: RowReading[] = [];
    for (const row of rows) {
      const text = await this.readOne(image, row.crop);
      readings.push({ text, verdict: this.judge.judge(text, row.predicted) });
    }
    return readings;
  }

  private async readOne(image: Buffer, crop: RowCrop): Promise<string> {
    let strip: Buffer;
    try {
      strip = await sharp(image)
        .extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
        .resize({ width: crop.width * UPSCALE, height: crop.height * UPSCALE, kernel: 'lanczos3' })
        .png()
        .toBuffer();
    } catch {
      // 切り出しに失敗する（帯が画像からはみ出しているなど）行は諦める。
      // 分類器の答えがそのまま残るだけで、悪くはならない。
      return '';
    }
    try {
      // 1 行だけの画像なので 7（1 行として読む）。既定の 6（一塊の文章）は
      // 帯の上下に残った隣の行のかけらを別の行として拾うことがある。
      const { text } = await this.ocr.recognize(strip, { tessedit_pageseg_mode: '7' });
      return text.replace(/\s+/g, ' ').trim();
    } catch {
      return '';
    }
  }
}
