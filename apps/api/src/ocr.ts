import { createWorker, type Worker } from 'tesseract.js';

/**
 * 画面の写真から文字を読む。
 *
 * tesseract を Worker として 1 本だけ立て、依頼を並べて順に流す。
 * 立ち上げに数百ミリ秒かかるので使い回し、読み取り自体は直列にする。
 * 中では 1 スレッドしか使わないため、並べても速くならない。
 *
 * 学習データは `tessdata` の標準のものを使う。
 * `tessdata_fast` は軽いが `一匹狼` を `ー忠狼` と読み違えた。
 * `tessdata_best` は SIMD を要求する版でしか動かない。
 * docs/ocr-design.md を参照。
 */

export interface OcrOptions {
  /** `jpn.traineddata` を置いた場所 */
  readonly tessdataPath: string;
  readonly lang?: string;
}

export class OcrEngine {
  private worker: Worker | null = null;
  private starting: Promise<Worker> | null = null;
  /** 直列に流すための待ち行列。前の読み取りが終わってから次を始める。 */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: OcrOptions) {}

  private async ensureWorker(): Promise<Worker> {
    if (this.worker !== null) return this.worker;
    this.starting ??= createWorker(this.options.lang ?? 'jpn', 1, {
      langPath: this.options.tessdataPath,
      gzip: false,
      // 取り込んだ学習データを書き戻さない。読み取り専用で置くことがあるためである。
      cacheMethod: 'none',
      logger: () => {},
    }).then((worker) => {
      this.worker = worker;
      return worker;
    });
    return this.starting;
  }

  /** 画像から読み取った文字を返す。依頼は到着順に処理する。 */
  async recognize(image: Buffer): Promise<{ text: string; elapsedMs: number }> {
    const run = this.tail.then(async () => {
      const worker = await this.ensureWorker();
      const started = performance.now();
      const { data } = await worker.recognize(image);
      return { text: data.text, elapsedMs: performance.now() - started };
    });
    // 失敗しても行列は止めない
    this.tail = run.catch(() => undefined);
    return run;
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.starting = null;
    if (worker !== null) await worker.terminate();
  }
}
