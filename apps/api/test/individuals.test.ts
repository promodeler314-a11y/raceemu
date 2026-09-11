import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadGameData } from '../../../packages/data/src/node.ts';
import type { Config } from '../src/config.ts';
import { createApiServer } from '../src/http.ts';
import { checkNewIndividual } from '../src/individual-request.ts';
import { IndividualStore, type NewIndividual } from '../src/individuals.ts';
import { JobRunner } from '../src/jobs.ts';
import { RequestError } from '../src/request.ts';

const data = loadGameData();

function uma(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    charaName: 'テスト', speed: 1200, stamina: 1000, power: 900, guts: 600, wisdom: 900,
    condition: 'BEST', style: 'SEN', distanceFit: 'A', surfaceFit: 'A', styleFit: 'A',
    popularity: 1, gateNumber: 5, uniqueLevel: 6,
    ...overrides,
  };
}

function skillId(name: string): string {
  const id = data.skillsByName.get(name)?.[0]?.id;
  if (id === undefined) throw new Error(`知らないスキル: ${name}`);
  return id;
}

function newIndividual(overrides: Record<string, unknown> = {}): NewIndividual {
  return checkNewIndividual(
    { label: 'テスト個体', uma: uma(), skillIds: [skillId('弧線のプロフェッサー')], ...overrides },
    data,
  );
}

describe('個体の検査（checkNewIndividual）', () => {
  it('妥当な入力を通す', () => {
    const result = newIndividual();
    expect(result.label).toBe('テスト個体');
    expect(result.skillIds).toHaveLength(1);
  });

  it('label を省略すると空文字になる', () => {
    const result = checkNewIndividual({ uma: uma(), skillIds: [] }, data);
    expect(result.label).toBe('');
  });

  it('知らないスキル ID は拒む', () => {
    expect(() => newIndividual({ skillIds: ['no-such-skill'] })).toThrow(RequestError);
  });

  it('ステータスが範囲外なら拒む', () => {
    expect(() => newIndividual({ uma: uma({ speed: -1 }) })).toThrow(RequestError);
  });

  it('作戦が知らない値なら拒む', () => {
    expect(() => newIndividual({ uma: uma({ style: 'DASH' }) })).toThrow(RequestError);
  });
});

describe('IndividualStore', () => {
  it(':memory: で保存・一覧・削除ができる', () => {
    const store = new IndividualStore(null);
    try {
      const created = store.create(newIndividual());
      expect(created.id).toMatch(/^[0-9a-f-]{36}$/);

      const listed = store.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]).toEqual(created);

      expect(store.remove(created.id)).toBe(true);
      expect(store.list()).toHaveLength(0);
      expect(store.remove(created.id)).toBe(false);
    } finally {
      store.close();
    }
  });

  it('ファイルに永続化すると、開き直しても残っている', () => {
    const dir = mkdtempSync(join(tmpdir(), 'raceemu-individuals-'));
    try {
      const first = new IndividualStore(dir);
      const created = first.create(newIndividual());
      first.close();

      const second = new IndividualStore(dir);
      try {
        expect(second.list()).toEqual([created]);
      } finally {
        second.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('新しい順に並ぶ', () => {
    const store = new IndividualStore(null);
    try {
      const first = store.create(newIndividual({ label: '1 件目' }));
      const second = store.create(newIndividual({ label: '2 件目' }));
      expect(store.list().map((i) => i.id)).toEqual([second.id, first.id]);
    } finally {
      store.close();
    }
  });
});

describe('/api/individuals', () => {
  const config: Config = {
    port: 0, concurrency: 1, concurrencySource: 'env', maxRunning: 1, maxQueued: 1,
    maxRacesPerJob: 1000, jobTtlMs: 60_000, staticRoot: null,
    tessdataPath: null, maxImageBytes: 1024, ocrThreshold: 128, dataDir: null,
  };
  let base: string;
  let server: ReturnType<typeof createApiServer>;
  let store: IndividualStore;

  beforeAll(async () => {
    store = new IndividualStore(null);
    const runner = new JobRunner(config, data);
    server = createApiServer(config, data, runner, store);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    store.close();
  });

  it('保存すると一覧に出て、削除すると消える', async () => {
    const postRes = await fetch(`${base}/api/individuals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: '相手 A', uma: uma(), skillIds: [] }),
    });
    expect(postRes.status).toBe(201);
    const created = (await postRes.json()) as { id: string };

    const listRes = await fetch(`${base}/api/individuals`);
    const { items } = (await listRes.json()) as { items: { id: string; label: string }[] };
    expect(items.some((i) => i.id === created.id && i.label === '相手 A')).toBe(true);

    const deleteRes = await fetch(`${base}/api/individuals/${created.id}`, { method: 'DELETE' });
    expect(deleteRes.status).toBe(204);

    const listAfter = (await (await fetch(`${base}/api/individuals`)).json()) as { items: { id: string }[] };
    expect(listAfter.items.some((i) => i.id === created.id)).toBe(false);
  });

  it('知らないスキル ID を送ると 400', async () => {
    const res = await fetch(`${base}/api/individuals`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uma: uma(), skillIds: ['no-such-skill'] }),
    });
    expect(res.status).toBe(400);
  });

  it('知らない ID の削除は 404', async () => {
    const res = await fetch(`${base}/api/individuals/${'0'.repeat(36)}`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
