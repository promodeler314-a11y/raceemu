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
 *
 * ## 失敗の扱い
 *
 * tesseract.js の失敗の伝わり方には二つの落とし穴がある。
 *
 * `errorHandler` を渡さないと、worker からの受け口でそのまま throw する。
 * worker_threads の受け口から出た例外は uncaughtException になり、
 * **プロセスごと落ちる**。読み取りが失敗しただけでレースの計算まで巻き添えになる。
 *
 * 渡すと今度は、`createWorker` の promise が解決も拒否もしないまま残る。
 * 学習データが見つからない場合がこれで、待っている側は永久に返らない。
 *
 * そこで `errorHandler` が受け取った失敗を自前の合図に変えて競争させ、
 * 時間切れも重ねる。**読み取りは必ず終わる**（結果か、理由の付いた失敗）。
 */

export interface OcrOptions {
  /** `jpn.traineddata` を置いた場所 */
  readonly tessdataPath: string;
  readonly lang?: string;
  /** 立ち上げに待つ上限 */
  readonly startupTimeoutMs?: number;
  /** 1 枚の読み取りに待つ上限 */
  readonly recognizeTimeoutMs?: number;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const DEFAULT_RECOGNIZE_TIMEOUT_MS = 120_000;

/** 外から失敗させられる合図。errorHandler が受け取った失敗をこれに変える。 */
interface FailureSignal {
  readonly promise: Promise<never>;
  fail(message: string): void;
  failed(): string | null;
}

function createFailureSignal(): FailureSignal {
  let fail!: (message: string) => void;
  let message: string | null = null;
  const promise = new Promise<never>((_, reject) => {
    fail = (reason) => {
      message ??= reason;
      reject(new Error(reason));
    };
  });
  // 誰も待っていないうちに拒否されても、未処理の拒否として騒がせない
  promise.catch(() => undefined);
  return { promise, fail, failed: () => message };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}が ${ms} ミリ秒で終わらなかった`)), ms);
    // 待っているあいだにプロセスを止められるようにする
    timer.unref?.();
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

export class OcrEngine {
  private worker: Worker | null = null;
  private starting: Promise<Worker> | null = null;
  private signal: FailureSignal | null = null;
  /** 直列に流すための待ち行列。前の読み取りが終わってから次を始める。 */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: OcrOptions) {}

  private async ensureWorker(): Promise<Worker> {
    if (this.worker !== null) return this.worker;
    if (this.starting === null) {
      const signal = createFailureSignal();
      this.signal = signal;
      const created = createWorker(this.options.lang ?? 'jpn', 1, {
        langPath: this.options.tessdataPath,
        gzip: false,
        // 取り込んだ学習データを書き戻さない。読み取り専用で置くことがあるためである。
        cacheMethod: 'none',
        logger: () => {},
        errorHandler: (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error('[ocr] 読み取りに失敗した:', message);
          signal.fail(message);
        },
      });
      // 合図が先に鳴っても、後から立ち上がった worker を残さない
      void created.then((worker) => {
        if (signal.failed() !== null) void worker.terminate().catch(() => undefined);
      }).catch(() => undefined);

      this.starting = withTimeout(
        Promise.race([created, signal.promise]),
        this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
        '読み取りの立ち上げ',
      )
        .then((worker) => {
          this.worker = worker;
          return worker;
        })
        .catch((error: unknown) => {
          // 次の依頼でやり直せるようにする
          this.starting = null;
          this.signal = null;
          throw error;
        });
    }
    return this.starting;
  }

  /**
   * 画像から読み取った文字を返す。依頼は到着順に処理する。
   *
   * 失敗したら worker を畳む。中途半端な状態のまま次の依頼を流すと、
   * 二度目以降が何を返すか分からなくなる。
   */
  async recognize(image: Buffer): Promise<{ text: string; elapsedMs: number }> {
    const run = this.tail.then(async () => {
      try {
        const worker = await this.ensureWorker();
        const signal = this.signal;
        const started = performance.now();
        const work = worker.recognize(image);
        const { data } = await withTimeout(
          signal === null ? work : Promise.race([work, signal.promise]),
          this.options.recognizeTimeoutMs ?? DEFAULT_RECOGNIZE_TIMEOUT_MS,
          '読み取り',
        );
        return { text: data.text, elapsedMs: performance.now() - started };
      } catch (error) {
        await this.dispose().catch(() => undefined);
        const reason = error instanceof Error && error.message !== '' ? error.message : '理由不明';
        throw new Error(`読み取りに失敗した: ${reason}`);
      }
    });
    // 失敗しても行列は止めない
    this.tail = run.catch(() => undefined);
    return run;
  }

  async dispose(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.starting = null;
    this.signal = null;
    if (worker !== null) await worker.terminate();
  }
}
