import type { UmaStatus } from '../../../packages/sim/src/setting.ts';

/**
 * サーバに保存する個体（ステータス+スキル構成）。
 *
 * `/api/individuals`（apps/api）を叩く。GitHub Pages に置いた版にはサーバが
 * 無いので、その場合は口が無いことを伝える。読み取り（Import.tsx）と同じ
 * 考え方で、事前に `/api/health` を確かめたりはせず、実際に叩いてみて
 * 応答が JSON かどうかで判断する。
 */

export interface Individual {
  readonly id: string;
  readonly label: string;
  readonly uma: UmaStatus;
  readonly skillIds: readonly string[];
  readonly createdAt: string;
}

export interface NewIndividual {
  readonly label: string;
  readonly uma: UmaStatus;
  readonly skillIds: readonly string[];
}

const NO_ENDPOINT =
  '個体を保存する口が無い。GitHub Pages に置いた版はサーバを持たないので、この機能は自前で立てた版でだけ使える。';

function explainNonJson(res: Response): string {
  if (res.redirected) {
    return `個体の口ではなく別の画面に飛ばされた（最終 ${res.status}）。認証が切れていないか確かめる。`;
  }
  if (res.status === 404 || res.status === 405) return NO_ENDPOINT;
  return (
    `サーバが JSON ではない応答を返した（${res.status}）。` +
    'サーバの版が古いか、途中に認証や proxy の画面が挟まっている。/api/health を開くと切り分けられる。'
  );
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) throw new Error(explainNonJson(res));
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(explainNonJson(res));
  }
  if (!res.ok) {
    const message =
      typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `失敗した（${res.status}）`;
    throw new Error(message);
  }
  return body as T;
}

export async function listIndividuals(): Promise<readonly Individual[]> {
  const body = await fetchJson<{ items: Individual[] }>('/api/individuals');
  return body.items;
}

export async function saveIndividual(input: NewIndividual): Promise<Individual> {
  return fetchJson<Individual>('/api/individuals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export async function removeIndividual(id: string): Promise<void> {
  const res = await fetch(`/api/individuals/${id}`, { method: 'DELETE' });
  if (res.status === 204) return;
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) throw new Error(explainNonJson(res));
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  throw new Error(body?.error ?? `削除に失敗した（${res.status}）`);
}
