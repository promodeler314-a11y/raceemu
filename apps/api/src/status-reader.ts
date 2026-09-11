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
 * 読み取りは、数字が tesseract（`ocr.ts`）、適性が色（`rankFromColor`）である。
 *
 * **スキル一覧と違って文字認識で足りる。** スキル名が壊れたのは、丸いアイコンと
 * 装飾つきの背景が隣の文字を巻き込むためだった（docs/ocr-design.md 5 節）。
 * ステータスの数字と適性の文字は、無地の板の上に 1 つずつ離れて置かれている。
 * 切り出しが合ってさえいれば、周りに巻き込むものが無い。
 *
 * ステータスの数字では読む文字を絞らない。絞ると `jpn` の学習データが返す
 * 丸囲み数字が候補から外れ、何も返らなくなるためである（`normalizeDigits`）。
 *
 * 適性は文字認識では読めなかった。飾りの強い立体的な字で、二値化すると輪郭
 * だけが残る。実機の 1 枚では 10 個のうち 7 個までしか当たらず、取り違えも
 * 混ざった。**色で決めるほうがはるかに確かである**（`RANK_HUES`）。
 *
 * ## 確かめたこと
 *
 * 実機 3 枚（横 608 と 810、縦横比はすべて違う）で、**45 か所すべてを正しく
 * 読んだ**。切り出しの割合は umacapture の値のままで、目印の検出も較正も
 * 要らなかった。写真はゲームの著作物なのでリポジトリには置いていない。
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

/**
 * ステータスの上限。これを超える読み取りは切り出しのずれとみなして捨てる。
 *
 * 2000 にしていたら、実機の写真のスピード 2165 を捨てていた。因子と覚醒で
 * 2000 は普通に超える。画面の入力欄と同じ 2500 に合わせてある。
 */
const MAX_STATUS = 2500;

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

/**
 * 実機で測った、適性の記号の色相（0 から 360）。
 *
 * 記号は立体的に飾られた字で、文字認識には向かない。二値化すると輪郭だけが
 * 残って中が抜ける。実機の写真では 10 個のうち 7 個までしか当たらず、`B` を
 * `E` と読む取り違えも混ざった。
 *
 * **色のほうがはるかにはっきりしている。** 実機 3 枚（解像度は 608 と 810 の
 * 2 通り）で 30 か所を測ったところ、同じ階級は色相が 1 度も違わなかった。
 * `A` は 10 か所すべてで 24、`S` は 4 か所すべてで 42 である。
 *
 * | 階級 | 色相 | 彩度の高い画素 |
 * | --- | ---: | ---: |
 * | S | 42 | 33〜34% |
 * | A | 24 | 33〜35% |
 * | B | 342 | 18% |
 * | C | 106 | 26% |
 * | D | 203 | 27% |
 * | E | 286 | 23% |
 * | F | 245 | 1.4〜6.0% |
 * | G | 無し | 0.0% |
 *
 * いちばん近い組は `A` と `S` の 18 度で、それ以外は 40 度以上離れている。
 * 許容を 8 度に取れば、どの 2 つも取り違えない。
 */
const RANK_HUES: Partial<Record<FitRank, number>> = {
  S: 42,
  A: 24,
  B: 342,
  C: 106,
  D: 203,
  E: 286,
  F: 245,
};

/**
 * 色相がこれだけ離れていたら別の色とみなす。
 *
 * いちばん近い `A`（24）と `S`（42）の間が 18 度なので、8 度なら両方に当たる
 * ことがない。実測の色相は階級ごとにぴたりと同じ値なので、これだけ狭くても
 * 取りこぼさない。
 */
const HUE_TOLERANCE = 8;

/** これを下回る彩度は「色が付いていない」とみなす。 */
const VIVID_SATURATION = 0.45;

/**
 * 彩度の高い画素がこの割合を下回れば、灰色の `G` とみなす。
 *
 * **`F` と `G` の境目である。** `F` は淡い青紫で、彩度の高い画素が 1.4% しか
 * 無いことがある。ここを 2% にしていたときは、その `F` を `G` と答えていた。
 * `G` は実測 6 か所すべてで 0.0%（1 画素も無い）なので、0.5% で分かれる。
 */
const GRAY_RATIO = 0.005;

/**
 * 切り出した領域の色から階級を決める。分からなければ null。
 *
 * 色相は円周上の量なので、平均は sin と cos を平均してから角度に戻す。
 * 342 のような 0 をまたぐ値を素直に平均すると、真ん中あたりの別の色になる。
 */
function rankFromColor(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  channels: number,
  rect: PixelRect,
): FitRank | null {
  let sumSin = 0;
  let sumCos = 0;
  let vivid = 0;
  let total = 0;
  for (let y = rect.top; y < rect.top + rect.height; y++) {
    for (let x = rect.left; x < rect.left + rect.width; x++) {
      const at = (y * width + x) * channels;
      const r = pixels[at]! / 255;
      const g = pixels[at + 1]! / 255;
      const b = pixels[at + 2]! / 255;
      total++;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const delta = max - min;
      const saturation = max > 0 ? delta / max : 0;
      if (saturation < VIVID_SATURATION || max < 0.35 || delta === 0) continue;
      let hue: number;
      if (max === r) hue = 60 * (((g - b) / delta) % 6);
      else if (max === g) hue = 60 * ((b - r) / delta + 2);
      else hue = 60 * ((r - g) / delta + 4);
      if (hue < 0) hue += 360;
      const radians = (hue * Math.PI) / 180;
      sumSin += Math.sin(radians);
      sumCos += Math.cos(radians);
      vivid++;
    }
  }
  if (total === 0) return null;
  // 色がまったく付いていなければ灰色の G である。色が付いているのに
  // 知らない色だったときは、ここでは決めずに文字認識へ回す。
  if (vivid / total < GRAY_RATIO) return 'G';
  let hue = (Math.atan2(sumSin / vivid, sumCos / vivid) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  for (const [rank, center] of Object.entries(RANK_HUES)) {
    // 円周上の差。342 と 5 のように 0 をまたぐ組でも正しく近いと分かる。
    const diff = Math.abs(((hue - center + 540) % 360) - 180);
    if (diff <= HUE_TOLERANCE) return rank as FitRank;
  }
  return null;
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
    const rect = aptitudeRects[index]!;
    const { text } = await ocr.recognize(await cropTo(image, rect), {
      tessedit_char_whitelist: 'SABCDEFG',
      // 1 語として読ませる。1 文字として読ませる 10 より当たった（7 対 5）。
      tessedit_pageseg_mode: '8',
    });
    // 色を先に見る。実機の 1 枚では、文字認識が黙った 3 つと間違えた 1 つを
    // 色が拾って 10 個すべて当たった（`RANK_HUES`）。
    aptitudes[key] = rankFromColor(data, info.width, info.channels, rect) ?? toRank(text);
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
