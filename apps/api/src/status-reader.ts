import sharp from 'sharp';
import type { FitRank } from '../../../packages/sim/src/data/constants.ts';
import type { OcrEngine } from './ocr.ts';
import {
  APTITUDE_KEYS,
  APTITUDE_RECTS,
  detectContentRect,
  fitsInside,
  STATUS_RECTS,
  toPixelRect,
  type AptitudeKey,
  type ContentRect,
  type PixelRect,
} from './status-header.ts';

/**
 * 「ウマ娘詳細」画面から、ステータス 5 つと適性 10 個を読む。
 *
 * 切り出しは `status-header.ts`（umacapture の割合をそのまま使う）。
 * 読み取りは既にある tesseract（`ocr.ts`）に、1 か所ずつ渡す。
 *
 * **スキル一覧と違って文字認識で足りる。** スキル名が壊れたのは、丸いアイコンと
 * 装飾つきの背景が隣の文字を巻き込むためだった（docs/ocr-design.md 5 節）。
 * ステータスの数字と適性の文字は、無地の板の上に 1 つずつ離れて置かれている。
 * 切り出しが合ってさえいれば、周りに巻き込むものが無い。
 *
 * 適性は読む文字を S から G までの 8 文字に絞る。`B` と `8`、`S` と `5` の
 * ような取り違えが起きなくなる。ステータスの数字では絞らない。絞ると `jpn` の
 * 学習データが返す丸囲み数字が候補から外れ、何も返らなくなるためである
 * （`normalizeDigits`）。
 *
 * ## 確かめていないこと
 *
 * **実機の写真で検証していない。** 合成した見本でしか通していない。
 * 適性の文字は装飾が強く（S は虹色、A は赤系）、二値化で潰れる可能性がある。
 * 本来は umacapture が配る適性の分類モデル（`aptitude/prediction.onnx`）を
 * 使うのが筋だが、このリポジトリを触っている環境からは配布元に届かない。
 * docs/ocr-design.md の 7 節を参照。
 */

export interface StatusReading {
  /** スピード・スタミナ・パワー・根性・賢さ。読めなかったものは null。 */
  readonly status: readonly (number | null)[];
  /** 適性。読めなかったものは null。 */
  readonly aptitudes: Readonly<Record<AptitudeKey, FitRank | null>>;
  /** 切り出しに使った内容領域。ずれていたときに外から見えるようにしてある。 */
  readonly content: ContentRect;
}

const RANKS: readonly FitRank[] = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];

/** ステータスの上限。これを超える読み取りは切り出しのずれとみなして捨てる。 */
const MAX_STATUS = 2000;

/** この数だけ読めなければ、そもそもこの画面ではないとみなす。 */
const MIN_STATUS_READ = 3;

/**
 * 切り出しを広げる割合（内容領域の横幅に対して）。
 *
 * 文字の縁が切れると読み違える。umacapture の矩形は、学習した分類器に渡す
 * ための「ぴったり」の寸法なので、文字認識に渡すにはわずかに狭い。
 */
const CROP_MARGIN = 0.004;

/** 切り出したあとの拡大率。tesseract は小さい文字を苦手とする。 */
const UPSCALE = 3;

async function cropTo(image: Buffer, rect: PixelRect): Promise<Buffer> {
  return sharp(image)
    .extract({ left: rect.left, top: rect.top, width: rect.width, height: rect.height })
    .resize({ width: rect.width * UPSCALE, height: rect.height * UPSCALE, kernel: 'lanczos3' })
    .png()
    .toBuffer();
}

/**
 * 丸囲みの数字と全角の数字を、ふつうの数字に直す。
 *
 * `jpn` の学習データは丸囲み数字（①②…）を字として持っており、ゲームの数字を
 * そちらに読むことがある。**しかも二桁を 1 文字にまとめる**（`1247` を
 * `⑫④⑦` と読む）。丸囲みは 1 文字で二桁を表せるので、そのまま展開すれば
 * 元の並びに戻る。
 *
 * 読む文字を数字に絞る（`tessedit_char_whitelist`）と、候補から丸囲みが
 * 外れて**何も返らなくなる**ので、数字では絞らない。絞りが効く適性とは
 * 扱いを変えている。
 *
 * 見本では `eng` の学習データなら丸囲みにならず、そのまま `1247` と読んだ。
 * 実機の写真でここが揺れるようなら、数字だけ `eng` に読ませるのが次の手である
 * （docs/ocr-design.md 7 節）。
 */
function normalizeDigits(text: string): string {
  let out = '';
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code === 0x24ea) out += '0'; // ⓪
    else if (code >= 0x2460 && code <= 0x2473) out += String(code - 0x2460 + 1); // ①〜⑳
    else if (code >= 0x2776 && code <= 0x277f) out += String(code - 0x2776 + 1); // ❶〜❿
    else if (code >= 0xff10 && code <= 0xff19) out += String(code - 0xff10); // ０〜９
    else out += char;
  }
  return out;
}

/** 読み取った文字から数字だけを拾う。 */
function toNumber(text: string): number | null {
  const digits = normalizeDigits(text).replace(/[^0-9]/g, '');
  if (digits === '') return null;
  const value = Number(digits);
  if (!Number.isFinite(value) || value <= 0 || value > MAX_STATUS) return null;
  return value;
}

function toRank(text: string): FitRank | null {
  for (const char of text.toUpperCase()) {
    const rank = RANKS.find((r) => r === char);
    if (rank !== undefined) return rank;
  }
  return null;
}

/**
 * 「ウマ娘詳細」の上半分が写っていない画像を渡されたときの失敗。
 *
 * 送った側の問題なので、サーバ側の不具合（500）と混ぜない。
 */
export class StatusOutOfFrameError extends Error {}

export interface StatusReaderOptions {
  /** 内容領域を自分で決めたいとき（検査用）。 */
  readonly content?: ContentRect;
}

export async function readStatusHeader(
  image: Buffer,
  ocr: OcrEngine,
  options: StatusReaderOptions = {},
): Promise<StatusReading> {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const content =
    options.content ?? detectContentRect(data, info.width, info.height, info.channels);

  const statusRects = STATUS_RECTS.map((r) => toPixelRect(r, content, CROP_MARGIN));
  const aptitudeRects = APTITUDE_RECTS.map((r) => toPixelRect(r, content, CROP_MARGIN));
  const all = [...statusRects, ...aptitudeRects];
  if (!all.every((rect) => fitsInside(rect, info.width, info.height))) {
    // 上半分が写っていない（スキル一覧だけを切り抜いた画像など）。
    // 当てずっぽうの数字を返すより、読めなかったことをそのまま返す。
    throw new StatusOutOfFrameError(
      'ステータスの位置が画像の外に出る。「ウマ娘詳細」画面の上半分が写った画像を渡す',
    );
  }

  const status: (number | null)[] = [];
  for (const rect of statusRects) {
    // 数字では読む文字を絞らない（`normalizeDigits` の説明を参照）。
    // 1 行だけが写っている前提で読ませる。行の切り出しを tesseract に任せると、
    // 余白を別の行と見て空文字を返すことがある。
    const { text } = await ocr.recognize(await cropTo(image, rect), {
      tessedit_pageseg_mode: '7',
    });
    status.push(toNumber(text));
  }

  const aptitudes: Record<string, FitRank | null> = {};
  for (const [index, key] of APTITUDE_KEYS.entries()) {
    const { text } = await ocr.recognize(await cropTo(image, aptitudeRects[index]!), {
      tessedit_char_whitelist: 'SABCDEFG',
      // 1 文字だけが写っている。
      tessedit_pageseg_mode: '10',
    });
    aptitudes[key] = toRank(text);
  }

  // 縦さえ足りていれば矩形は画像の中に収まってしまうので、位置の検査だけでは
  // 別の画面を渡されたことに気付けない（スキル一覧の画像でも収まる）。
  // 5 つの枠のうち数字として読めた数で見分ける。本物なら 5 つとも読める。
  // にじみで 1 つ 2 つ落ちることは許し、それ以上なら別の画面とみなす。
  const read = status.filter((value) => value !== null).length;
  if (read < MIN_STATUS_READ) {
    throw new StatusOutOfFrameError(
      `ステータスが ${read} 個しか読めない。「ウマ娘詳細」画面の上半分が写った画像を渡す`,
    );
  }

  return {
    status,
    aptitudes: aptitudes as Record<AptitudeKey, FitRank | null>,
    content,
  };
}
