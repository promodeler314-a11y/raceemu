import { SimulationCancelled } from '../../../packages/sim/src/parallel/pool.ts';
import type { SerializableRaceSetting } from '../../../packages/sim/src/parallel/protocol.ts';
import type { OptimizeResult } from '../../../packages/solver/src/optimize.ts';

/**
 * サーバ側の探索（`/api/search`）を叩く。
 *
 * 候補を数百に広げると 25 万レース規模になり、スマホの数コアでは回らない。
 * [サーバ側で探索を回す設計](../../../docs/server-design.md)の 1 節を参照。
 *
 * **サーバは加速装置であって、依存先ではない**（同 2 節）。静的ファイルだけを
 * 置いた版には口が無いので、ここが失敗したら呼び出し側はブラウザの Worker に
 * 落とす。落とせるように、失敗は「サーバが使えない」ことがはっきり分かる形で
 * 投げる。読み取り（individualsApi.ts と Import.tsx）と同じ考え方で、事前に
 * `/api/health` を確かめたりはせず、**実際に叩いてみて応答が JSON かどうか**で
 * 判断する。状態番号で判断すると、認証や proxy が 200 で HTML を返す経路に
 * 引っかかる。
 */

/** 進捗を出す間隔。1 本が分単位なので、細かく引く意味が無い。 */
const POLL_MS = 1000;

/** サーバに投げる本文。形は docs/server-design.md 7 節にある。 */
export interface ServerSearchRequest {
  readonly base: SerializableRaceSetting;
  readonly candidates: readonly string[];
  readonly budget: number;
  readonly seed: number;
  /** 順位条件を判定するなら出走頭数。相手の中身はサーバ側が作る。 */
  readonly field: { readonly gateCount: number } | null;
  readonly hintLevels?: Readonly<Record<string, number>>;
}

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface SearchJobView {
  readonly id: string;
  readonly status: JobStatus;
  readonly races: number;
  readonly progress: readonly string[];
  readonly result: OptimizeResult | null;
  readonly error: string | null;
}

/**
 * 宛先にサーバが居ないこと。呼び出し側はこれを見てブラウザに落とす。
 *
 * 静的配信だけの版（口が無い）、宛先の書き間違い、回線断がここに来る。
 * どれも「サーバが答えていない」ので、今までどおりブラウザで回せばよい。
 */
export class ServerSearchUnavailable extends Error {}

/**
 * サーバは居るが、この探索は回らないこと。**ブラウザに落としてはならない。**
 *
 * 候補が多すぎる、混んでいる、レース数の上限を超えた、といった理由がここに来る。
 * どれもサーバに投げるほど重い探索なので、黙ってブラウザに回すと数十分固まる。
 * 理由を出して止め、条件を変えるか投げ先を選び直してもらう。
 */
export class ServerSearchRejected extends Error {}

/**
 * 宛先を正規化する。
 *
 * 空と `/` は同一オリジン（サーバがアプリも配っている形）を指す。
 * 末尾の `/` は落とす。`https://例.example/raceemu` のようにサブパスに
 * 置いた場合も、そのまま前に付ければよい形にする。
 */
export function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '/') return '';
  return trimmed.replace(/\/+$/, '');
}

/** 宛先が設定されているか。空文字は「同一オリジン」ではなく「無し」である。 */
export function hasEndpoint(raw: string): boolean {
  return raw.trim() !== '';
}

function explainNonJson(res: Response): string {
  if (res.redirected) {
    return `探索の口ではなく別の画面に飛ばされました（最終 ${res.status}）。認証が切れていないか確かめてください。`;
  }
  if (res.status === 404 || res.status === 405) {
    return '宛先に探索の口がありません。静的ファイルだけを置いた版はサーバを持ちません。';
  }
  return (
    `サーバが JSON ではない応答を返しました（${res.status}）。` +
    'サーバの版が古いか、途中に認証や proxy の画面が挟まっています。/api/health を開くと切り分けられます。'
  );
}

/**
 * JSON を取る。JSON でなければ `ServerSearchUnavailable` にする。
 *
 * `fetch` 自体が投げる場合（宛先が無い、CORS、回線断）も同じ型に揃える。
 * 呼び出し側が「落とすかどうか」を型 1 つで決められるようにするためである。
 */
async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (error) {
    throw new ServerSearchUnavailable(
      `サーバに届きませんでした（${error instanceof Error ? error.message : String(error)}）。`,
    );
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) throw new ServerSearchUnavailable(explainNonJson(res));
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ServerSearchUnavailable(explainNonJson(res));
  }
  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `失敗しました（${res.status}）。`;
    // JSON で理由を返してきた以上、サーバは居る。断られたのであって、
    // 使えないのではない。
    throw new ServerSearchRejected(message);
  }
  return body as T;
}

export interface ServerHealth {
  readonly concurrency: number;
  readonly concurrencySource: string;
  readonly maxRacesPerJob: number;
  readonly running: number;
  readonly queued: number;
}

/** 宛先の疎通を見る。押した人に「いま繋がるか」を返すためだけのもの。 */
export async function checkHealth(endpoint: string): Promise<ServerHealth> {
  return fetchJson<ServerHealth>(`${normalizeEndpoint(endpoint)}/api/health`);
}

export interface ServerSearchHooks {
  /** 進捗。サーバは直近 50 行しか持たないので、そのときの全体を渡す。 */
  readonly onProgress?: (lines: readonly string[], races: number) => void;
  readonly signal?: AbortSignal;
  readonly pollMs?: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * 探索を 1 本投げて、終わるまで待つ。
 *
 * 受け付けと結果の取得を分けてあるのは、1 本が分単位で走るためである
 * （docs/server-design.md 3.1 節）。中断は口の DELETE に回し、
 * ブラウザで回したときと同じ `SimulationCancelled` にして返す。
 */
export async function runServerSearch(
  endpoint: string,
  request: ServerSearchRequest,
  hooks: ServerSearchHooks = {},
): Promise<OptimizeResult> {
  const base = normalizeEndpoint(endpoint);
  const signal = hooks.signal;
  // 関数にしておく。式のままだと、最初の判定のあと「常に偽」に絞り込まれる。
  const aborted = (): boolean => signal?.aborted === true;
  if (aborted()) throw new SimulationCancelled();

  const submitted = await fetchJson<SearchJobView>(`${base}/api/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });

  const url = `${base}/api/search/${submitted.id}`;
  let cancelling = false;
  for (;;) {
    if (aborted() && !cancelling) {
      cancelling = true;
      // 投げっぱなしにすると、こちらが見るのをやめたあともサーバの枠を
      // 埋め続ける。返事は待たない（消えていても構わない）。
      void fetch(url, { method: 'DELETE' }).catch(() => undefined);
    }
    await sleep(hooks.pollMs ?? POLL_MS, cancelling ? undefined : signal);
    const job = await fetchJson<SearchJobView>(url);
    hooks.onProgress?.(job.progress, job.races);
    if (job.status === 'done') {
      if (job.result === null) throw new ServerSearchRejected('終わったのに結果が入っていません。');
      return job.result;
    }
    if (job.status === 'cancelled') throw new SimulationCancelled();
    if (job.status === 'failed') {
      throw new ServerSearchRejected(job.error ?? 'サーバ側で失敗しました。');
    }
  }
}
