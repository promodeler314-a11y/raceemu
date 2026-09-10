import sharp from 'sharp';

/**
 * OCR に渡す前に画像を整える。
 *
 * tesseract は渡された画像を自前で二値化してから読む。
 * この自動二値化（Otsu 法に近いもの）が、色つきのアイコンや模様のある
 * 背景では失敗する。実測では、何もしない場合とグレースケール化しただけの
 * 場合とで結果が変わり、後者のほうが悪化した。
 *
 *   無加工                    14/21 一致
 *   グレースケールのみ          0/21 一致
 *   グレー + 固定閾値で二値化   21/21 一致
 *
 * グレースケール化そのものは人の目には正しく見えるが、背景の明るさが
 * 場所によって違う画像では、tesseract 側の自動二値化が破綻するらしい。
 * 二値化まで済ませて渡せば、tesseract はその判断をしなくてよくなる。
 *
 * 閾値は 170 を既定にしている。165 から 190 の範囲で振って、簡単な見本
 * （M10 の 10 件）と難しい見本（実機同等の 21 件）の両方を測った。
 *
 *   165  簡単は全件検出するが確信度が下がるものがある  難:21/21
 *   170  簡単は全件を確信度 1.0 で検出              難:21/21
 *   175  同上                                       難:21/21
 *   180  簡単は問題ないが                            難:8/21（急に崩れる）
 *
 * 170 から 175 が両方で最も良く、170 を選んでいる。
 *
 * 明るさの正規化（`normalize`）は試した結果、無いほうが良かったので入れて
 * いない。撮り方による露出のばらつきに弱いままである可能性があり、本物の
 * 写真で確かめていない。docs/ocr-design.md の 5 節を参照。
 */

export interface PreprocessOptions {
  /** 二値化の閾値。0 から 255。 */
  readonly threshold?: number;
}

const DEFAULT_THRESHOLD = 170;

export async function preprocessForOcr(image: Buffer, options: PreprocessOptions = {}): Promise<Buffer> {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  return sharp(image).grayscale().threshold(threshold).png().toBuffer();
}
