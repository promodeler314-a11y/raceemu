import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimulationCancelled } from '../../../packages/sim/src/parallel/pool.ts';
import {
  hasEndpoint,
  normalizeEndpoint,
  runServerSearch,
  ServerSearchRejected,
  ServerSearchUnavailable,
  type ServerSearchRequest,
} from '../src/searchApi.ts';
import { restorePlan } from '../src/store.ts';

/**
 * サーバ側の探索を叩く経路。
 *
 * いちばん大事なのは**口の無い版で倒れないこと**である。静的ファイルだけを
 * 置いた配布物にはサーバが無く、そこでは今までどおりブラウザで回す
 * （docs/server-design.md 2 節）。`pnpm e2e` の偽サーバが実物で同じことを突くが、
 * 応答の形ごとの振り分けはここで固定する。
 */

const request: ServerSearchRequest = {
  base: {
    uma: {
      charaName: '', speed: 1200, stamina: 1000, power: 900, guts: 600, wisdom: 900,
      condition: 'BEST', style: 'SEN', distanceFit: 'A', surfaceFit: 'A', styleFit: 'A',
      popularity: 1, gateNumber: 5, uniqueLevel: 6,
    },
    track: { location: 10006, course: 10606, condition: 1, gateCount: 9 },
    skillIds: [],
    skillActivateAdjustment: 'NONE',
    randomPosition: 'RANDOM',
    debuffCounts: {},
    positionKeepMode: 'APPROXIMATE',
    positionKeepRate: 100,
  },
  candidates: ['201112', '201102'],
  budget: 300,
  seed: 1,
  field: null,
};

const html = (status: number) =>
  new Response('<!DOCTYPE html><html><body>405</body></html>', {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('宛先の正規化', () => {
  it('空と / は同一オリジンになる', () => {
    expect(normalizeEndpoint('')).toBe('');
    expect(normalizeEndpoint('/')).toBe('');
    expect(normalizeEndpoint('  ')).toBe('');
  });

  it('末尾の / を落とす', () => {
    expect(normalizeEndpoint('https://例.example/raceemu/')).toBe('https://例.example/raceemu');
    expect(normalizeEndpoint(' https://例.example ')).toBe('https://例.example');
  });

  // 空文字は「同一オリジン」ではなく「宛先なし」である。ここを取り違えると、
  // 静的配信だけの版が毎回むだに 1 往復叩くことになる。
  it('空文字は宛先が無いものとして扱う', () => {
    expect(hasEndpoint('')).toBe(false);
    expect(hasEndpoint('  ')).toBe(false);
    expect(hasEndpoint('/')).toBe(true);
  });
});

describe('サーバ側の探索', () => {
  it('HTML が返ったら「サーバが居ない」として投げる（ブラウザに落とす側）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => html(405)));
    await expect(runServerSearch('/', request)).rejects.toBeInstanceOf(ServerSearchUnavailable);
  });

  it('200 でも中身が HTML なら同じ扱いにする', async () => {
    // 認証や proxy の画面が 200 で挟まる経路。状態番号だけで判断すると読みに行って落ちる。
    vi.stubGlobal('fetch', vi.fn(async () => html(200)));
    await expect(runServerSearch('/', request)).rejects.toBeInstanceOf(ServerSearchUnavailable);
  });

  it('宛先に届かなければ「サーバが居ない」として投げる', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(runServerSearch('https://nowhere.invalid', request)).rejects.toBeInstanceOf(
      ServerSearchUnavailable,
    );
  });

  // JSON で理由を返してきた以上サーバは居る。**ブラウザに落としてはならない。**
  // サーバに投げるほど重い探索を黙ってブラウザに回すと数十分固まる。
  it('JSON で断られたら「居るが回せない」として投げる', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(503, { error: '待ち行列がいっぱいである' })));
    await expect(runServerSearch('/', request)).rejects.toBeInstanceOf(ServerSearchRejected);
  });

  it('ジョブが失敗しても、居るが回せない側になる', async () => {
    const calls = [
      json(202, { id: 'a'.repeat(8), status: 'queued', races: 0, progress: [], result: null, error: null }),
      json(200, {
        id: 'a'.repeat(8), status: 'failed', races: 10, progress: [], result: null,
        error: 'レース数の上限を超えたので打ち切った',
      }),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => calls.shift()!));
    await expect(runServerSearch('/', request, { pollMs: 1 })).rejects.toBeInstanceOf(
      ServerSearchRejected,
    );
  });

  it('終わったら結果をそのまま返し、途中の進捗を渡す', async () => {
    const result = { best: ['201112'], cost: 170, races: 4000 };
    const calls = [
      json(202, { id: 'b'.repeat(8), status: 'queued', races: 0, progress: [], result: null, error: null }),
      json(200, { id: 'b'.repeat(8), status: 'running', races: 200, progress: ['単体評価 1/2'], result: null, error: null }),
      json(200, { id: 'b'.repeat(8), status: 'done', races: 4000, progress: ['仕上げ'], result, error: null }),
    ];
    vi.stubGlobal('fetch', vi.fn(async () => calls.shift()!));
    const lines: string[][] = [];
    const got = await runServerSearch('/', request, {
      pollMs: 1,
      onProgress: (progress) => lines.push([...progress]),
    });
    expect(got).toMatchObject(result);
    expect(lines).toEqual([['単体評価 1/2'], ['仕上げ']]);
  });

  it('中断は、ブラウザで回したときと同じ形で返る', async () => {
    const controller = new AbortController();
    const calls = [
      json(202, { id: 'c'.repeat(8), status: 'queued', races: 0, progress: [], result: null, error: null }),
      json(200, { id: 'c'.repeat(8), status: 'cancelled', races: 0, progress: [], result: null, error: null }),
    ];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return json(200, {});
      return calls.shift()!;
    });
    vi.stubGlobal('fetch', fetchMock);
    controller.abort();
    await expect(
      runServerSearch('/', request, { pollMs: 1, signal: controller.signal }),
    ).rejects.toBeInstanceOf(SimulationCancelled);
  });
});

describe('候補の出どころの読み直し', () => {
  // 出どころが 2 通り（真偽値）から 3 通りになった。古い保存を黙って
  // 「いま選んでいるスキル」に戻すと、次の探索で候補がすり替わる。
  it('古い保存の enabled が立っていれば育成計画として読む', () => {
    const restored = restorePlan({ enabled: true } as never);
    expect(restored.source).toBe('plan');
  });

  it('古い保存の enabled が偽なら、いま選んでいるスキルのまま', () => {
    expect(restorePlan({ enabled: false } as never).source).toBe('selected');
  });

  it('新しい保存は source をそのまま使う', () => {
    expect(restorePlan({ source: 'all', enabled: true } as never).source).toBe('all');
  });

  it('保存が無ければ既定（▲ は外す）になる', () => {
    const restored = restorePlan(undefined);
    expect(restored.source).toBe('selected');
    expect(restored.excludeDropped).toBe(true);
  });
});
