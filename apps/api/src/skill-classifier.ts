import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';

/**
 * 「ウマ娘詳細」画面のスキル一覧を、文字認識ではなく画像分類で読む。
 *
 * tesseract は文字を1つずつ読もうとするため、丸いアイコンや装飾つきの背景が
 * 隣接する文字を巻き込んで壊す（docs/ocr-design.md 5 節）。行の見た目そのものを
 * 「約1800種のスキルのどれか」への分類問題として解けば、アイコンや背景は
 * 「そのスキルの見た目の一部」として扱われ、壊れなくなる。
 *
 * 分類モデルは umacapture（https://github.com/umasagashi/umacapture、MIT）が
 * 配布している学習済み ONNX（`prediction.onnx`）で、`license.md` により
 * パブリックドメイン。入力は行を 200×16 に縮小した RGB 画像 1 枚、出力は
 * 1832 種のスキル名への分類番号と確信度。前処理（正規化）はモデルの中に
 * 組み込まれているので、こちらでやることは切り出しと縮小だけである。
 *
 * 番号→うちのスキル ID の対応表は `scripts/build-skill-classifier-labels.ts` で
 * 作った `label-map.json`（このリポジトリの著作物）。umacapture 側の
 * `labels.json`（Cygames の著作物が入っている）はコピーしていない。
 *
 * ## 行の切り出し方
 *
 * umacapture 本家は「画面内の目印（ヘッダーの境界線、閉じるボタンの下端など）を
 * 検出して基準位置を割り出す」専用の較正機構を持つ（`detail_crop_calibrator.h`）。
 * 数ピクセルの誤差で分類が外れる（しかも確信度が下がらず、堂々と別解を返す）
 * ほどシビアだからである。
 *
 * ここでは実機の1枚（本物の「ウマ娘詳細」画面）で次の手順を確かめた。
 *
 * 1. **タブの下端をヘッダーから見分ける**。ブランドの緑色は上部ヘッダーと
 *    アクティブなタブの両方に使われるが、ヘッダーは全幅に近く、タブは
 *    画面の一部（3分の1）しか占めない。ヘッダーより下で「部分幅の緑」を
 *    探すと、スキル一覧の直前にあるタブの下端が見つかる（見つからなければ、
 *    スキル一覧だけを切り抜いた画像が来たとみなして画面の先頭から探す）。
 * 2. **左列のアイコンの位置で行を数える**。スキル名の左にある丸いアイコンは
 *    彩度が高い（色は問わない。緑のアイコンもある。後述）。左列が来る横幅
 *    （0〜11%）の中でこの条件に合う横方向の塊を縦に探すと、行の数とそれぞれの
 *    上下端が分かる。右列のアイコンは検出に使わない。一覧は詰めて並ぶので、
 *    行数が奇数のときに空くのは最後の行の右側だけであり、左列だけを見れば
 *    数え間違えない。金色・虹色の縁取りが隣の行まで続いていると、内側の隙間を
 *    埋める処理が複数行を1つに繋げてしまうことがあるため、行の間隔（top
 *    どうしの差）の中央値よりはっきり高い塊は複数行分とみなして等分する。
 * 3. **文字だけを切り出す**。アイコンの実際の右端はそのまま使わず、横幅に
 *    対する割合（実機の1枚で目視して合わせた固定値）で文字の帯を切り出す。
 *    アイコンの右端をそのまま使うと、モデルが学習した切り出し方（アイコンの
 *    縁の柔らかい部分を少し含む）とずれて、確信度の高い誤答が増えるため。
 * 4. **確信度で微調整する**。手順1〜3の検出・固定値には数ピクセルの誤差が
 *    残るので、切り出しの左端を±10px・行の中心を±6px・高さを24〜36pxの
 *    範囲で振り、いちばん確信度が高い切り出しを採用する。正しい位置なら
 *    ほぼ1.0、ずれていれば0.6以下に落ちるという差がはっきりしているため、
 *    これで実用上の精度が出る。横・縦・高さの全組み合わせ（5×7×4=140通り）を
 *    総当たりすると、一覧が長い（何画面分もつなげた）写真で推論が数千回に
 *    膨れてゲートウェイのタイムアウトに掛かる。3方向はほぼ独立に決まるため、
 *    縦→高さ→横の順に1つずつ決める（7+4+5=16通り）。
 *
 * アイコンの色を問わない（2.）のは、当初「ブランドの緑を除く」判定にしていて、
 * 適性系スキルなど緑色のアイコンの行を見落としていたのを直したもの。タブの
 * 検出（1.）はその下端より下しか見ないので、ブランドの緑と紛れることは無い。
 *
 * この手順は実機の写真1枚で検証したものである。行数がずっと多い（32行分、
 * 複数画面をつなげた）別の写真を試した利用者から、緑色のアイコンを見落とす
 * ことと、行数が多いと時間がかかりすぎることの報告を受けて上記の2点を
 * 直したが、この写真そのものはファイルとして受け取れておらず、直った
 * ことまでは確かめていない。他の解像度・機種でどこまで通用するかも
 * 確かめていない（docs/ocr-design.md 5.4 と同じ立ち位置の限界）。
 */

export interface SkillRowPrediction {
  /** モデルの一致先。うちのデータに無い名前（対戦相手の debuff など）なら null。 */
  readonly skillId: string | null;
  /** 0 から 1。低ければそもそもスキルの行ではない（一覧の末尾など）。 */
  readonly confidence: number;
}

const ASSET_DIR = new URL('../assets/skill-classifier/', import.meta.url);
const LABEL_MAP: readonly (string | null)[] = JSON.parse(
  readFileSync(fileURLToPath(new URL('label-map.json', ASSET_DIR)), 'utf8'),
);

const MODEL_INPUT_WIDTH = 200;
const MODEL_INPUT_HEIGHT = 16;

/** ブランドの緑（ヘッダーとアクティブなタブ）を見分ける彩度・色相の下限。 */
function isGreenPixel(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max > 0 ? (max - min) / max : 0;
  return g > r * 1.15 && g > b * 1.3 && sat > 0.35 && max / 255 > 0.4;
}

/**
 * スキルのアイコンらしい、彩度の高い塊。
 *
 * ブランドの緑を除く判定にしていたことがあったが、アイコンの検出はタブの下端
 * より下（`searchStart` 以降）でしか行わないため、ブランドの緑と紛れることは
 * 無い。一方で適性系のスキルなど、アイコン自体が緑色のものを誤って除外して
 * しまっていた（一覧が長い実機の写真で発覚）。緑かどうかは問わない。
 */
function isVividPixel(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max > 0 ? (max - min) / max : 0;
  return sat > 0.45 && max / 255 > 0.5;
}

interface Band {
  readonly top: number;
  readonly bottom: number;
}

function groupRowsIntoBands(rows: readonly number[], maxGap: number): Band[] {
  const bands: Band[] = [];
  let top: number | null = null;
  let prev: number | null = null;
  for (const y of rows) {
    if (top === null) {
      top = y;
    } else if (prev !== null && y - prev > maxGap) {
      bands.push({ top, bottom: prev });
      top = y;
    }
    prev = y;
  }
  if (top !== null && prev !== null) bands.push({ top, bottom: prev });
  return bands;
}

/**
 * ヘッダー直下からタブの帯（部分幅の緑）を探し、その下端を返す。
 * 見つからなければ null（スキル一覧だけを切り抜いた画像を渡された場合など）。
 */
function findTabBarBottom(isGreen: Uint8Array, width: number, height: number): number | null {
  const skipHeader = Math.floor(height * 0.15);
  const fracByRow = new Float64Array(height);
  for (let y = skipHeader; y < height; y++) {
    let count = 0;
    const rowOffset = y * width;
    for (let x = 0; x < width; x++) count += isGreen[rowOffset + x]!;
    fracByRow[y] = count / width;
  }
  const rows: number[] = [];
  for (let y = skipHeader; y < height; y++) if (fracByRow[y]! > 0.15) rows.push(y);
  const bands = groupRowsIntoBands(rows, 3);
  // タブはヘッダーと同じ緑だが全幅を占めない。ピーク比率が中途半端な帯を選ぶ。
  const tabBand = bands.find((band) => {
    let peak = 0;
    for (let y = band.top; y <= band.bottom; y++) peak = Math.max(peak, fracByRow[y]!);
    return peak >= 0.15 && peak <= 0.7;
  });
  return tabBand?.bottom ?? null;
}

/**
 * 探す幅（[xStart, xEnd)）の中から、アイコンらしい塊の上下端を行ごとに求める。
 * 呼び出し側は上下端（行の Y 位置）だけを使い、左右の実際の端は使わない
 * （`buildRowGeometry` の説明を参照）。
 *
 * 金色・虹色などで飾られた行は、背景そのものが彩度の高い色になり、アイコンだけでなく
 * 文字の帯まで「vivid」判定に引っかかる。アイコンは横幅が一定（この探索幅の半分ほど）
 * なのに対し、装飾された背景は探索幅いっぱいまで続くので、**塊の幅が探索幅の80%を
 * 超えたら背景の色そのものだとみなして捨てる**ことで区別する。
 */
function findIconBands(
  isVivid: Uint8Array,
  width: number,
  height: number,
  xStart: number,
  xEnd: number,
  yStart: number,
): Band[] {
  const searchWidth = xEnd - xStart;
  const isIconRow = new Uint8Array(height);
  for (let y = yStart; y < height; y++) {
    const rowOffset = y * width;
    let first = -1;
    let last = -1;
    for (let x = xStart; x < xEnd; x++) {
      if (isVivid[rowOffset + x] === 1) {
        if (first === -1) first = x;
        last = x;
      }
    }
    const span = first === -1 ? 0 : last - first;
    // 塊とみなすのは、ある程度の幅があり（文字の1画のような細い点を除く）、
    // かつ探索幅いっぱいまでは続いていない場合だけ（装飾された背景そのものを除く）。
    if (first !== -1 && span >= searchWidth * 0.3 && span <= searchWidth * 0.8) isIconRow[y] = 1;
  }
  const rows: number[] = [];
  for (let y = yStart; y < height; y++) if (isIconRow[y] === 1) rows.push(y);
  // アイコンの絵柄（走る人の影絵）の内側にある白い隙間で、途中の行だけ判定が
  // 途切れることがある。行の間隔（90px 前後）よりずっと小さいこの隙間はまたぐ。
  const rawBands = groupRowsIntoBands(rows, 30).filter((band) => band.bottom - band.top >= 10);

  // 金色・虹色の縁取りが隣の行まで続いていると、この隙間を埋める処理が複数行を
  // 1つに繋げてしまうことがある。1行ぶんの高さは絵柄次第でけっこう揺れる
  // （44〜75px 前後）ので、それでは見分けが付かない。行の間隔（top どうしの差）
  // の中央値の方が安定するので、それより明らかに高い帯だけを複数行とみなす。
  const pitches: number[] = [];
  for (let i = 1; i < rawBands.length; i++) pitches.push(rawBands[i]!.top - rawBands[i - 1]!.top);
  pitches.sort((a, b) => a - b);
  const pitch = pitches[Math.floor(pitches.length / 2)] ?? 0;

  const bands: Band[] = [];
  for (const band of rawBands) {
    const height_ = band.bottom - band.top;
    const parts = pitch > 0 && height_ > pitch * 1.3 ? Math.round(height_ / pitch) : 1;
    if (parts <= 1) {
      bands.push(band);
      continue;
    }
    const step = height_ / parts;
    for (let i = 0; i < parts; i++) {
      bands.push({ top: Math.round(band.top + i * step), bottom: Math.round(band.top + (i + 1) * step) });
    }
  }

  return bands;
}

interface SkillRowGeometry {
  readonly centerY: number;
  readonly leftText: readonly [number, number];
  readonly rightText: readonly [number, number];
}

/** アイコンを探す幅。実機の1枚では約 7.5% だったので、少し余裕を持たせてある。 */
const ICON_SEARCH_FRACTION = 0.11;

/**
 * 文字だけの帯の左右端。横幅に対する割合で、実機の1枚で目視して合わせた値。
 *
 * アイコンの右端をそのまま文字の始まりに使うと、モデルが学習した切り出し方
 * （アイコンの縁の柔らかい部分を少し含む）とずれて、確信度の高い誤答が増える
 * ことが分かった。そのためアイコン検出は行の Y 位置（何行あるか、どこにあるか）
 * を割り出すためだけに使い、X 方向はこの固定の割合を使う。
 * `bestAroundCenter` の左右への微調整で、解像度の違いなど残る誤差を吸収する。
 */
const LEFT_TEXT_FRACTION: readonly [number, number] = [0.097, 0.49];
const RIGHT_TEXT_FRACTION: readonly [number, number] = [0.561, 0.949];

/**
 * 検出した左列のアイコンの並び（Y 位置だけ使う）から、左右2列ぶんの
 * 「文字だけの帯」を組み立てる。
 *
 * 行の数は左列を基準にする。奇数件のときは最後の行の右側が空になるが、
 * 左は必ず埋まっている（詰めて並ぶ一覧なので、右だけ先に空くことは無い）。
 * 右列のアイコン検出は使わない。空の右側もそのまま分類にかけることになるが、
 * その場合はどのスキルにも強く一致せず、確信度が低いまま返る
 * （`bestAroundCenter` の呼び出し側で、確信度が低ければ捨てればよい）。
 */
function buildRowGeometry(leftIcons: readonly Band[], width: number): SkillRowGeometry[] {
  return leftIcons.map((l) => ({
    centerY: (l.top + l.bottom) / 2,
    leftText: [LEFT_TEXT_FRACTION[0] * width, LEFT_TEXT_FRACTION[1] * width],
    rightText: [RIGHT_TEXT_FRACTION[0] * width, RIGHT_TEXT_FRACTION[1] * width],
  }));
}

export class SkillClassifier {
  private session: Promise<ort.InferenceSession> | null = null;

  private getSession(): Promise<ort.InferenceSession> {
    this.session ??= ort.InferenceSession.create(fileURLToPath(new URL('model.onnx', ASSET_DIR)));
    return this.session;
  }

  /**
   * 画像から行の位置を割り出し、見つかった行ぶんだけ分類する。
   * 「ウマ娘詳細」画面の形をしていない（タブやアイコンの並びが見つからない）
   * 場合は空配列を返す。呼び出し側はその場合 tesseract などに任せてよい。
   */
  async recognize(image: Buffer): Promise<SkillRowPrediction[]> {
    const raw = await sharp(image).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { data, info } = raw;
    const { width, height } = info;
    const pixels = width * height;
    const isGreen = new Uint8Array(pixels);
    const isVivid = new Uint8Array(pixels);
    for (let p = 0; p < pixels; p++) {
      const o = p * info.channels;
      const r = data[o]!;
      const g = data[o + 1]!;
      const b = data[o + 2]!;
      isGreen[p] = isGreenPixel(r, g, b) ? 1 : 0;
      isVivid[p] = isVividPixel(r, g, b) ? 1 : 0;
    }

    const tabBarBottom = findTabBarBottom(isGreen, width, height);
    const searchStart = tabBarBottom ?? 0;

    // アイコンは左列の始まり（横幅の 0〜11%）に来る（実機の1枚で検証した値）。
    // 探す幅を丸いアイコンの実寸に絞ることで、金色・虹色などで飾られた行の
    // 背景そのもの（彩度は高いが探索幅いっぱいまで続く）をアイコンと
    // 誤認しないようにする。行の数は左列だけを基準にする
    // （`buildRowGeometry` を参照。右列は詰めて並ぶので最後の1行だけ空きうる）。
    const iconSearchWidth = Math.round(width * ICON_SEARCH_FRACTION);
    const leftIcons = findIconBands(isVivid, width, height, 0, iconSearchWidth, searchStart);
    if (leftIcons.length === 0) return [];

    const rows = buildRowGeometry(leftIcons, width);
    const session = await this.getSession();
    const predictions: SkillRowPrediction[] = [];
    for (const row of rows) {
      for (const [x0, x1] of [row.leftText, row.rightText]) {
        const best = await this.bestAroundCenter(session, data, width, height, x0, x1, row.centerY);
        predictions.push(best);
      }
    }
    return predictions;
  }

  /**
   * 検出した中心の周りを小さく振って、いちばん確信度が高い切り出しを選ぶ。
   * アイコン検出には数ピクセルの誤差が残るが、正しい位置なら確信度がほぼ
   * 1.0 に達し、ずれていれば大きく下がるという差を利用して吸収する。
   *
   * 横・縦・高さのすべての組み合わせ（元は5×7×4=140通り）を総当たりすると、
   * 一覧が長い（何画面分もつなげた）写真で数千回の推論になり、ゲートウェイの
   * タイムアウトに掛かる。確信度が最大になる位置は横・縦・高さでほぼ独立に
   * 決まるため、縦→高さ→横の順に1つずつ決めていく（7+4+5=16通り）。
   */
  private async bestAroundCenter(
    session: ort.InferenceSession,
    data: Buffer,
    imageWidth: number,
    imageHeight: number,
    x0: number,
    x1: number,
    centerYGuess: number,
  ): Promise<SkillRowPrediction> {
    const width = Math.max(1, Math.round(x1 - x0));
    let best: SkillRowPrediction = { skillId: null, confidence: 0 };
    let bestLeft = Math.round(x0);
    let bestTop = Math.round(centerYGuess - 28 / 2);
    let bestHeight = 28;

    const consider = async (left: number, top: number, cropHeight: number): Promise<void> => {
      if (left < 0 || left + width > imageWidth || top < 0 || top + cropHeight > imageHeight) return;
      const prediction = await this.classifyCrop(session, data, imageWidth, left, top, width, cropHeight);
      if (prediction.confidence > best.confidence) {
        best = prediction;
        bestLeft = left;
        bestTop = top;
        bestHeight = cropHeight;
      }
    };

    // 縦 → 高さ → 横の順に、それまでに見つかった最良の位置を土台にして1つずつ
    // 決めていく。確信度が最大になる位置は3方向でほぼ独立に決まるため、これで
    // 5×7×4=140通りの総当たりとほぼ同じ結果を 7+4+5=16 回の推論で得られる。
    for (const dy of [-6, -4, -2, 0, 2, 4, 6]) {
      await consider(Math.round(x0), Math.round(centerYGuess + dy - bestHeight / 2), bestHeight);
    }
    const fixedCenterY = bestTop + bestHeight / 2;
    for (const cropHeight of [24, 32, 36]) {
      await consider(bestLeft, Math.round(fixedCenterY - cropHeight / 2), cropHeight);
    }
    for (const dx of [-10, -5, 5, 10]) {
      await consider(Math.round(x0 + dx), bestTop, bestHeight);
    }
    return best;
  }

  private async classifyCrop(
    session: ort.InferenceSession,
    data: Buffer,
    imageWidth: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): Promise<SkillRowPrediction> {
    const resized = resizeBilinearRgb(data, imageWidth, x, y, width, height, MODEL_INPUT_WIDTH, MODEL_INPUT_HEIGHT);
    const tensor = new ort.Tensor('uint8', resized, [1, MODEL_INPUT_HEIGHT, MODEL_INPUT_WIDTH, 3]);
    const inputName = session.inputNames[0]!;
    const output = await session.run({ [inputName]: tensor });
    const index = Number(output['index']!.data[0]);
    const confidence = Number(output['confidence']!.data[0]);
    return { skillId: LABEL_MAP[index] ?? null, confidence };
  }
}

/**
 * 生の RGB バッファから矩形を切り出し、バイリニア補間で縮小する。
 * `sharp` のパイプラインを毎回作らずに済むので、較正の総当たりが速い。
 */
function resizeBilinearRgb(
  data: Buffer,
  srcWidth: number,
  cropX: number,
  cropY: number,
  cropWidth: number,
  cropHeight: number,
  outWidth: number,
  outHeight: number,
): Uint8Array {
  const out = new Uint8Array(outWidth * outHeight * 3);
  const scaleX = cropWidth / outWidth;
  const scaleY = cropHeight / outHeight;
  for (let oy = 0; oy < outHeight; oy++) {
    const sy = Math.min(cropHeight - 1, Math.max(0, (oy + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(cropHeight - 1, y0 + 1);
    const fy = sy - y0;
    for (let ox = 0; ox < outWidth; ox++) {
      const sx = Math.min(cropWidth - 1, Math.max(0, (ox + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(cropWidth - 1, x0 + 1);
      const fx = sx - x0;
      const outOffset = (oy * outWidth + ox) * 3;
      for (let c = 0; c < 3; c++) {
        const p00 = data[((cropY + y0) * srcWidth + (cropX + x0)) * 3 + c]!;
        const p10 = data[((cropY + y0) * srcWidth + (cropX + x1)) * 3 + c]!;
        const p01 = data[((cropY + y1) * srcWidth + (cropX + x0)) * 3 + c]!;
        const p11 = data[((cropY + y1) * srcWidth + (cropX + x1)) * 3 + c]!;
        const top = p00 + (p10 - p00) * fx;
        const bottom = p01 + (p11 - p01) * fx;
        out[outOffset + c] = Math.round(top + (bottom - top) * fy);
      }
    }
  }
  return out;
}
