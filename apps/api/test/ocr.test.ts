import { existsSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { loadGameData } from '../../../packages/data/src/node.ts';
import { SkillMatcher } from '../../../packages/data/src/skill-match.ts';
import type { Config } from '../src/config.ts';
import { createApiServer } from '../src/http.ts';
import { JobRunner } from '../src/jobs.ts';
import { OcrEngine } from '../src/ocr.ts';

/**
 * 見本の画像は組み立てたものであって、ゲームの画面ではない。
 * ここで測れるのは、口が繋がっていることと、読み取った文字がスキルに戻せることである。
 * 本物の画面での精度は docs/ocr-design.md の 5 節に残してある。
 */
const TESSDATA = process.env['RACEEMU_TESSDATA'] ?? '.tessdata';
const available = existsSync(`${TESSDATA}/jpn.traineddata`);
const data = loadGameData();
const matcher = new SkillMatcher(data.skills);
const engine = available ? new OcrEngine({ tessdataPath: TESSDATA }) : null;

afterAll(async () => {
  await engine?.dispose();
});

const EXPECTED = [
  '弧線のプロフェッサー',
  '円弧のマエストロ',
  '中距離コーナー○',
  '中距離直線○',
  '一匹狼',
  '好転一息',
  '正攻法',
  '真骨頂',
  'スリップストリーム',
  '末脚',
];

describe.skipIf(!available)('画面の読み取り', () => {
  it('見本の画像からスキルを引き当てる', async () => {
    const image = readFileSync('apps/api/test/fixtures/skill-list.png');
    const { text } = await engine!.recognize(image);
    const found = matcher.matchAll(text).map((m) => m.skill.name);
    for (const name of EXPECTED) expect(found).toContain(name);
    // 見本に無いものを拾っていない
    expect(found.length).toBe(EXPECTED.length);
  }, 120000);

  it('依頼を並べても取り違えない', async () => {
    const image = readFileSync('apps/api/test/fixtures/skill-list.png');
    const [a, b] = await Promise.all([engine!.recognize(image), engine!.recognize(image)]);
    expect(b.text).toBe(a.text);
  }, 120000);
});

describe('読み取りの口', () => {
  const config: Config = {
    port: 0, concurrency: 1, concurrencySource: 'env', maxRunning: 1, maxQueued: 1,
    maxRacesPerJob: 1000, jobTtlMs: 60_000, staticRoot: null,
    tessdataPath: null, maxImageBytes: 1024,
  };

  async function withServer(
    overrides: Partial<Config>,
    body: (base: string) => Promise<void>,
  ): Promise<void> {
    const merged = { ...config, ...overrides };
    const runner = new JobRunner(merged, data);
    const server = createApiServer(merged, data, runner);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      await body(`http://127.0.0.1:${port}`);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  }

  it('/api/health に読み取りが使えるかどうかを出す', async () => {
    await withServer({}, async (base) => {
      const off = (await (await fetch(`${base}/api/health`)).json()) as { ocr: boolean };
      expect(off.ocr).toBe(false);
    });
    await withServer({ tessdataPath: TESSDATA }, async (base) => {
      const on = (await (await fetch(`${base}/api/health`)).json()) as { ocr: boolean };
      expect(on.ocr).toBe(true);
    });
  });

  it('学習データの置き場が無ければ 501 を返す', async () => {
    await withServer({}, async (base) => {
      const res = await fetch(`${base}/api/ocr/skills`, {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: new Uint8Array([1, 2, 3]),
      });
      expect(res.status).toBe(501);
    });
  });

  it('画像でない本文は 415 を返す', async () => {
    await withServer({ tessdataPath: TESSDATA }, async (base) => {
      const res = await fetch(`${base}/api/ocr/skills`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(415);
    });
  });

  it('大きすぎる画像は 413 を返す', async () => {
    await withServer({ tessdataPath: TESSDATA, maxImageBytes: 16 }, async (base) => {
      const res = await fetch(`${base}/api/ocr/skills`, {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: new Uint8Array(64),
      });
      expect(res.status).toBe(413);
    });
  });

  it.skipIf(!available)('画像を送るとスキルが返る', async () => {
    await withServer({ tessdataPath: TESSDATA, maxImageBytes: 8 * 1024 * 1024 }, async (base) => {
      const res = await fetch(`${base}/api/ocr/skills`, {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: readFileSync('apps/api/test/fixtures/skill-list.png'),
      });
      expect(res.status).toBe(200);
      const found = (await res.json()) as { matches: { name: string; score: number }[] };
      const names = found.matches.map((m) => m.name);
      for (const name of EXPECTED) expect(names).toContain(name);
      for (const m of found.matches) expect(m.score).toBeGreaterThan(0.6);
    });
  }, 120000);
});
