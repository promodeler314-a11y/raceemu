import sharp from 'sharp';
import type { SkillData } from '../../../packages/sim/src/skill/types.ts';
import { normalizeSkillName, SkillMatcher } from '../../../packages/data/src/skill-match.ts';
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
 * データのほうは週次で追随しているので、差は開く一方である。実測した時点で、
 * うちの 2116 件のうち 81 件をモデルが名前を知らず、そのうち 31 件は誰でも
 * 取れる normal / rare だった（先導者、急先鋒、レースメイカー、奥の手 …）。
 * しかも配布元が配っているモデルが既に手元のものと同じで、**取り直しても
 * 直らない**（docs/ocr-design.md 6.6 節）。
 *
 * ## どう直すか
 *
 * 分類器は行ごとに「文字だけの帯」を切り出しており、確信度がいちばん高かった
 * 位置を `crop` として返す。同じ帯を文字認識にかけ、読めた文字が**モデルの
 * 語彙に無いスキル**を強く指していれば、そちらを採る。
 *
 * **語彙に有るスキルについては分類器に手を出さない。** 文字認識は丸いアイコンや
 * 装飾つきの背景に弱く（docs/ocr-design.md 5 節）、そもそも分類器に置き換えた
 * 経緯がある。いま正しく読めている 1775 件を、裏取りのつもりで壊すのは損である。
 * この規則なら、増えるのは「分類器が絶対に返せなかった答え」だけで済む。
 *
 * 読み取れなければ（帯が空、文字が潰れている）何も起きず、分類器の答えが
 * そのまま残る。直せない行は直せないままだが、悪くもならない。
 *
 * ## 費用
 *
 * 帯は 400×28 程度しかないので、1 つあたり 50ms ほどで読める。画面全体を
 * 読むのとは桁が違う。16 行（32 帯）で 1.6 秒、何画面分もつないだ 32 行
 * （64 帯）でも 3 秒ほどで、分類器自身の推論（行あたり 16 回）に上乗せしても
 * ゲートウェイの待ちには収まる。
 */

/** 文字認識の結果をスキル名と認める下限。分類器の答えを覆すので厳しくする。 */
const MIN_SCORE = 0.85;
/** 短い名前（連綿、超然 …）はもう 1 段厳しく。1 文字違うだけで別の名前になる。 */
const SHORT_NAME_LENGTH = 4;
const SHORT_NAME_MIN_SCORE = 1;

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
  const byId = new Map(all.map((skill) => [skill.id, skill]));
  const known = new Set<string>();
  for (const id of classifierSkillIds) {
    const skill = byId.get(id);
    if (skill !== undefined) known.add(normalizeSkillName(skill.name));
  }
  return all.filter((skill) => {
    const key = normalizeSkillName(skill.name);
    return key !== '' && !known.has(key);
  });
}

export interface RowReading {
  /** 文字認識が読み取った生の文字。読めなければ空。 */
  readonly text: string;
  /** モデルの語彙に無いスキルとして強く一致したもの。無ければ null。 */
  readonly skill: SkillData | null;
  readonly score: number;
}

export class SkillVerifier {
  private readonly matcher: SkillMatcher;

  constructor(private readonly ocr: OcrEngine, unknown: Iterable<SkillData>) {
    this.matcher = new SkillMatcher(unknown, {
      minScore: MIN_SCORE,
      shortNameLength: SHORT_NAME_LENGTH,
      shortNameMinScore: SHORT_NAME_MIN_SCORE,
    });
  }

  /**
   * 行ごとの帯を 1 つずつ読む。
   *
   * まとめて 1 枚に貼って一度に読む手もあるが、行が 1 つ読み飛ばされただけで
   * それ以降の対応がずれ、**別の行の答えを別の行に書き込む**。1 行ずつ読めば
   * 対応を取り違えようがない。帯は 400×28 程度と小さく、1 枚あたりの費用は
   * 画面全体を読むのとは桁が違う。
   */
  async read(image: Buffer, crops: readonly RowCrop[]): Promise<RowReading[]> {
    const readings: RowReading[] = [];
    for (const crop of crops) {
      readings.push(await this.readOne(image, crop));
    }
    return readings;
  }

  private async readOne(image: Buffer, crop: RowCrop): Promise<RowReading> {
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
      return { text: '', skill: null, score: 0 };
    }
    let text: string;
    try {
      // 1 行だけの画像なので 7（1 行として読む）。既定の 6（一塊の文章）は
      // 帯の上下に残った隣の行のかけらを別の行として拾うことがある。
      ({ text } = await this.ocr.recognize(strip, { tessedit_pageseg_mode: '7' }));
    } catch {
      return { text: '', skill: null, score: 0 };
    }
    const line = text.replace(/\s+/g, ' ').trim();
    const found = this.matcher.match(line);
    return { text: line, skill: found?.skill ?? null, score: found?.score ?? 0 };
  }
}
