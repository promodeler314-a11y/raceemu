import { existsSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { loadGameData } from '../../../packages/data/src/node.ts';
import { SkillMatcher } from '../../../packages/data/src/skill-match.ts';
import type { Config } from '../src/config.ts';
import { createApiServer } from '../src/http.ts';
import { IndividualStore } from '../src/individuals.ts';
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

/** 実際に読み取りを試した実機の画面に写っていた、21 件のスキル名。 */
const HARD_EXPECTED = [
  '聖夜のミラクルラン！',
  'ワクワククライマックス',
  'スカーレットリリィの高揚',
  'アド・アストラ',
  '夏ウマ娘○',
  '弧線のプロフェッサー',
  'ハヤテ一文字',
  '中距離直線○',
  '差し直線○',
  '十万バリキ',
  '小休憩',
  'スリーセブン',
  'ウマ好み',
  '尻尾の滝登り',
  '下り坂巧者',
  '食らいつき',
  '連鎖反応',
  '活路を拓く！',
  '千鍛万錬',
  '前人未到',
  '奮い立つ心',
];

describe.skipIf(!available)('画面の読み取り', () => {
  it('見本の画像からスキルを引き当てる', async () => {
    const image = readFileSync('apps/api/test/fixtures/skill-list.png');
    const { text } = await engine!.recognize(image);
    const found = matcher.matchAll(text);
    for (const name of EXPECTED) {
      const match = found.find((m) => m.skill.name === name);
      expect(match, `${name} が見つからない`).toBeDefined();
      // 前処理の閾値がずれると、正しいスキルは引けても確信度が落ちて
      // 画面で「要確認」の扱いになる。ここで確信度の劣化も検出する。
      expect(match!.score, `${name} の確信度が低い`).toBeGreaterThanOrEqual(0.99);
    }
    // 見本に無いものを拾っていない
    expect(found.length).toBe(EXPECTED.length);
  }, 120000);

  it('依頼を並べても取り違えない', async () => {
    const image = readFileSync('apps/api/test/fixtures/skill-list.png');
    const [a, b] = await Promise.all([engine!.recognize(image), engine!.recognize(image)]);
    expect(b.text).toBe(a.text);
  }, 120000);

  /**
   * 実機同等の難しさ（背景の模様、丸いアイコン、装飾つきの金枠、縦に長い一覧）
   * を持つ見本で、二値化の前処理が効いていることを確かめる。
   *
   * この前処理を入れる前は、この見本で 21 件中 14 件しか引き当てられなかった。
   * docs/ocr-design.md の 5 節に実測の経緯がある。
   */
  it('実機同等の難しさの見本でも、大半のスキルを引き当てる', async () => {
    const image = readFileSync('apps/api/test/fixtures/hard-skill-list.png');
    const { text } = await engine!.recognize(image);
    const found = new Set(matcher.matchAll(text).map((m) => m.skill.name));
    const missed = HARD_EXPECTED.filter((name) => !found.has(name));
    expect(missed, `引き当てられなかった: ${missed.join('、')}`).toEqual([]);
  }, 120000);
});

describe('読み取りの失敗', () => {
  // tesseract.js は errorHandler を渡さないと worker の受け口で throw し、
  // uncaughtException になってプロセスごと落ちる。渡すと今度は promise が
  // 解決も拒否もしないまま残る。どちらでもないことを押さえる。
  it('学習データが無ければ、理由の付いた失敗になる', async () => {
    const broken = new OcrEngine({
      tessdataPath: '/does-not-exist',
      startupTimeoutMs: 20_000,
      recognizeTimeoutMs: 20_000,
    });
    try {
      await expect(broken.recognize(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).rejects.toThrow(
        /読み取りに失敗した/,
      );
    } finally {
      await broken.dispose();
    }
  }, 60000);

  it.skipIf(!available)('失敗しても次の依頼は通る', async () => {
    const engine2 = new OcrEngine({ tessdataPath: TESSDATA, startupTimeoutMs: 60_000 });
    try {
      // 画像として読めないものを送って失敗させる
      await expect(engine2.recognize(Buffer.from('画像ではない'))).rejects.toThrow();
      // worker を畳んで作り直しているので、次は通る
      const { text } = await engine2.recognize(readFileSync('apps/api/test/fixtures/skill-list.png'));
      expect(text).toContain('狼');
    } finally {
      await engine2.dispose();
    }
  }, 120000);
});

describe('読み取りの口', () => {
  const config: Config = {
    port: 0, concurrency: 1, concurrencySource: 'env', maxRunning: 1, maxQueued: 1,
    maxRacesPerJob: 1000, jobTtlMs: 60_000, staticRoot: null,
    tessdataPath: null, maxImageBytes: 1024, ocrThreshold: 128, dataDir: null,
  };

  async function withServer(
    overrides: Partial<Config>,
    body: (base: string) => Promise<void>,
  ): Promise<void> {
    const merged = { ...config, ...overrides };
    const runner = new JobRunner(merged, data);
    const server = createApiServer(merged, data, runner, new IndividualStore(null));
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

  // 「ウマ娘詳細」画面のスキル一覧は分類器（skill-classifier.ts）が先に試し、
  // 学習データ（tessdata）が無くても効く。文字認識に落ちるのは、分類器がその
  // 形の画面ではないと判断したときだけである。
  it('分類器の形に合わない画像は、学習データが無ければ空の一覧を返す', async () => {
    await withServer({ maxImageBytes: 8 * 1024 * 1024 }, async (base) => {
      const res = await fetch(`${base}/api/ocr/skills`, {
        method: 'POST',
        headers: { 'content-type': 'image/png' },
        body: readFileSync('apps/api/test/fixtures/skill-list.png'),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { matches: unknown[] };
      expect(body.matches).toEqual([]);
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

  it('読み取りが失敗しても JSON を返す（HTML にしない）', async () => {
    await withServer(
      { tessdataPath: '/does-not-exist', maxImageBytes: 8 * 1024 * 1024 },
      async (base) => {
        const res = await fetch(`${base}/api/ocr/skills`, {
          method: 'POST',
          headers: { 'content-type': 'image/png' },
          body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        });
        expect(res.status).toBe(500);
        expect(res.headers.get('content-type')).toContain('application/json');
        const body = (await res.json()) as { error: string };
        expect(body.error).toMatch(/読み取りに失敗した/);
      },
    );
  }, 60000);

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
