/**
 * 「ウマ娘詳細」画面の上半分（評価点・ステータス・適性）の切り出し。
 *
 * スキル一覧（`skill-classifier.ts`）は行数も位置も可変なので、画面内の目印から
 * 行を探す必要があった。上半分は違う。**並びが固定**なので、内容領域さえ決まれば
 * あとは割合で切り出せる。「目印で基準位置を割り出してから、そこからの距離で
 * 切り取る」という umacapture の考え方の、いちばん素直な適用である。
 *
 * ## 座標系
 *
 * 割合の値は umacapture（MIT、https://github.com/umasagashi/umacapture）の
 * `assets/config/chara_detail/recognizer.json` の `status_header` から取った。
 * ゲーム画面の並びという事実であって、学習データでもモデルでもない。
 *
 * **縦も横幅で割る**（`native/src/cv/frame.h` の `FrameAnchor`。長さの単位
 * `unit_size` が `intersection.width()` で、縦横どちらの offset もこれで割る）。
 * 見落としやすいが、ここが要である。画面の縦横比が機種ごとに違っても、内容の
 * 配置は横幅に対して決まるので、縦を高さで割ると機種ごとにずれる。
 *
 * したがって画素の位置は次で求まる。
 *
 *   x = content.left + rx * content.width
 *   y = content.top  + ry * content.width
 *
 * ## 内容領域（content）
 *
 * umacapture は取り込んだ窓の中からゲームの描画領域を求めてここに入れる。
 * こちらが受け取るのはスマートフォンのスクリーンショットで、ふつうは画面全体が
 * ゲームである。ただし機種によっては上下に黒帯が入るので、縁の一様な帯だけ
 * 落としてから使う（`detectContentRect`）。
 *
 * ## 確かめていないこと
 *
 * **実機の写真で検証していない。** 割合そのものは umacapture が実機で使って
 * いるものだが、こちらの入力（スマートフォンのスクリーンショット）で内容領域の
 * 求め方が合っているかは確かめていない。合成した見本では通る。
 * docs/ocr-design.md の 7 節を参照。
 */

/** 内容領域の横幅を 1 とした割合。左上と右下。 */
export interface RelativeRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface ContentRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface PixelRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

function rect(left: number, top: number, right: number, bottom: number): RelativeRect {
  return { left, top, right, bottom };
}

/** 評価点。数字だが桁数が多く、ここでは読まない（7 節の積み残し）。 */
export const EVALUATION_RECT: RelativeRect = rect(0.1389, 0.3722, 0.2556, 0.4);

/** スピード・スタミナ・パワー・根性・賢さ。画面の並びどおり。 */
export const STATUS_RECTS: readonly RelativeRect[] = [
  rect(0.1074, 0.4833, 0.2111, 0.5111),
  rect(0.2926, 0.4833, 0.3963, 0.5111),
  rect(0.4778, 0.4833, 0.5815, 0.5111),
  rect(0.663, 0.4833, 0.7667, 0.5111),
  rect(0.8481, 0.4833, 0.9518, 0.5111),
];

/** 適性の並び。`APTITUDE_RECTS` と同じ順。 */
export const APTITUDE_KEYS = [
  'turf',
  'dirt',
  'sprint',
  'mile',
  'middle',
  'long',
  'nige',
  'sen',
  'sasi',
  'oi',
] as const;

export type AptitudeKey = (typeof APTITUDE_KEYS)[number];

/**
 * 適性 10 個。1 行目がバ場（芝・ダート）、2 行目が距離（短距離・マイル・中距離・
 * 長距離）、3 行目が脚質（逃げ・先行・差し・追込）である。
 */
export const APTITUDE_RECTS: readonly RelativeRect[] = [
  rect(0.3407, 0.5648, 0.3685, 0.5926),
  rect(0.5241, 0.5648, 0.5519, 0.5926),
  rect(0.3407, 0.6204, 0.3685, 0.6481),
  rect(0.5241, 0.6204, 0.5519, 0.6481),
  rect(0.7074, 0.6204, 0.7352, 0.6481),
  rect(0.8907, 0.6204, 0.9185, 0.6481),
  rect(0.3407, 0.6759, 0.3685, 0.7037),
  rect(0.5241, 0.6759, 0.5519, 0.7037),
  rect(0.7074, 0.6759, 0.7352, 0.7037),
  rect(0.8907, 0.6759, 0.9185, 0.7037),
];

/**
 * 割合を画素の矩形に直す。**縦も横幅で割る**（冒頭の説明を参照）。
 *
 * `margin` は外側に広げる割合。文字の縁が切れると読み違えるので、切り出しは
 * 少し広めに取る。
 */
export function toPixelRect(
  relative: RelativeRect,
  content: ContentRect,
  margin = 0,
): PixelRect {
  const unit = content.width;
  const grow = unit * margin;
  const left = Math.round(content.left + relative.left * unit - grow);
  const top = Math.round(content.top + relative.top * unit - grow);
  const right = Math.round(content.left + relative.right * unit + grow);
  const bottom = Math.round(content.top + relative.bottom * unit + grow);
  return { left, top, width: right - left, height: bottom - top };
}

/** 矩形が画像の中に収まっているか。上半分が写っていない画像を弾くのに使う。 */
export function fitsInside(rect: PixelRect, width: number, height: number): boolean {
  return (
    rect.left >= 0 &&
    rect.top >= 0 &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.left + rect.width <= width &&
    rect.top + rect.height <= height
  );
}

/** 画素が縁の帯（黒や白で一様）に見えるか。 */
function isBorderRow(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  channels: number,
  y: number,
): boolean {
  let min = 255;
  let max = 0;
  for (let x = 0; x < width; x++) {
    const at = (y * width + x) * channels;
    for (let c = 0; c < 3; c++) {
      const value = pixels[at + c]!;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  return isBorderTone(min, max);
}

/**
 * 縁の帯とみなす色。**黒だけを見る。**
 *
 * 明るい色も落とすようにしていたことがあったが、この画面は背景が淡い色
 * （クリーム色）で、画面全部が「明るく一様な行」に当たってしまい、内容を
 * すべて削り落とした。額縁が付くのは、画面比の合わない端末で上下左右に入る
 * 黒帯であって、白い余白ではない。
 */
function isBorderTone(min: number, max: number): boolean {
  return max - min < 24 && max < 32;
}

function isBorderColumn(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  channels: number,
  x: number,
): boolean {
  let min = 255;
  let max = 0;
  for (let y = 0; y < height; y++) {
    const at = (y * width + x) * channels;
    for (let c = 0; c < 3; c++) {
      const value = pixels[at + c]!;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  return isBorderTone(min, max);
}

/**
 * ゲームの描画領域を求める。上下左右の黒帯を落とすだけである。
 *
 * 落とすのを縁だけに限るのは、ゲーム画面そのものにも一様な行（背景のべた塗り）
 * があるためである。内側から探し始めると内容を削ってしまう。
 * 黒だけを見る理由は `isBorderTone` にある。
 */
export function detectContentRect(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  channels: number,
): ContentRect {
  let top = 0;
  while (top < height - 1 && isBorderRow(pixels, width, channels, top)) top++;
  let bottom = height - 1;
  while (bottom > top && isBorderRow(pixels, width, channels, bottom)) bottom--;
  let left = 0;
  while (left < width - 1 && isBorderColumn(pixels, width, height, channels, left)) left++;
  let right = width - 1;
  while (right > left && isBorderColumn(pixels, width, height, channels, right)) right--;
  return { left, top, width: right - left + 1, height: bottom - top + 1 };
}
