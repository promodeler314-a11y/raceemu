import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadGameData } from '../../../packages/data/src/node.ts';
import type { Config } from '../src/config.ts';
import { createApiServer } from '../src/http.ts';
import { IndividualStore } from '../src/individuals.ts';
import { JobRunner } from '../src/jobs.ts';

/**
 * サブパスに置いたとき、手前の reverse proxy がその接頭辞を外さずに
 * 転送してくることがある（自前の k3s で実際に起きた。/raceemu の下に
 * 置いたのに真っ白になった）。この場合サーバから見える経路は
 * "/raceemu/assets/x.js" のようになり、資産は 1 段浅い場所にある。
 */
describe('静的ファイルの配信', () => {
  const data = loadGameData();
  let root: string;
  let base: string;
  let server: ReturnType<typeof createApiServer>;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'raceemu-static-'));
    writeFileSync(join(root, 'index.html'), '<html><body>index</body></html>');
    const config: Config = {
      port: 0, concurrency: 1, concurrencySource: 'env', maxRunning: 1, maxQueued: 1,
      maxRacesPerJob: 1000, jobTtlMs: 60_000, staticRoot: root,
      tessdataPath: null, maxImageBytes: 1024, ocrThreshold: 128, dataDir: null,
    };
    const runner = new JobRunner(config, data);
    server = createApiServer(config, data, runner, new IndividualStore(null));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  });

  /** 生の HTTP で叩いて、応答のヘッダと実際に流れた大きさをそのまま見る。 */
  function rawGet(
    path: string,
    encoding: string,
  ): Promise<{ headers: IncomingHttpHeaders; bytes: number }> {
    return new Promise((done, fail) => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const req = request(
        { host: '127.0.0.1', port, path, headers: { 'accept-encoding': encoding } },
        (res) => {
          let bytes = 0;
          res.on('data', (chunk: Buffer) => (bytes += chunk.length));
          res.on('end', () => done({ headers: res.headers, bytes }));
        },
      );
      req.on('error', fail);
      req.end();
    });
  }

  it('根の index.html を返す', async () => {
    const res = await fetch(`${base}/`);
    expect(await res.text()).toContain('index');
  });

  it('拡張子の無い未知の経路は index.html に落ちる', async () => {
    const res = await fetch(`${base}/raceemu`);
    expect(await res.text()).toContain('index');
  });

  it('接頭辞を外さない proxy 越しでも、資産を 1 段浅い場所から見つける', async () => {
    writeFileSync(join(root, 'app.js'), 'console.log("real")');
    const res = await fetch(`${base}/raceemu/app.js`);
    const text = await res.text();
    expect(text).toBe('console.log("real")');
    // 見つからず index.html に落ちていないことも確かめる
    expect(text).not.toContain('index');
  });

  it('資産が本当に無ければ、それでも index.html に落ちる', async () => {
    const res = await fetch(`${base}/raceemu/does-not-exist.js`);
    expect(await res.text()).toContain('index');
  });

  /**
   * スキル一覧の表（issue #83）は apps/web/public/skill-list/<版>.json に置かれ、
   * pnpm build が dist/skill-list/<版>.json に写す。画面はそれを動的に取る。
   * ここでは同じ経路をサーバ側からも取れることと、大きさへの手当てを見る。
   */
  describe('スキル一覧の表', () => {
    // 縮める下限（64 kB）を超える大きさにする。数字の並びなのでよく縮む。
    const body = JSON.stringify({ format: 1, columns: { mean: Array.from({ length: 20_000 }, (_, i) => i / 7) } });

    beforeAll(() => {
      mkdirSync(join(root, 'skill-list'), { recursive: true });
      writeFileSync(join(root, 'skill-list', 'abc123.json'), body);
      writeFileSync(
        join(root, 'skill-list', 'index.json'),
        JSON.stringify({ latest: 'abc123.json', generations: ['abc123.json'] }),
      );
    });

    it('版をパスに含んだまま取れる', async () => {
      const res = await fetch(`${base}/skill-list/abc123.json`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(await res.text()).toBe(body);
    });

    it('版がパスに入るので、いつまでも持っていてよいと言う', async () => {
      const res = await fetch(`${base}/skill-list/abc123.json`);
      expect(res.headers.get('cache-control')).toContain('immutable');
    });

    /**
     * **版を教える 1 枚だけは名前が変わらない。**
     * 不変として配ると、新しい版を置いても画面は古い名前を取りに行き続ける。
     * 版がパスに入っている効き目が、入口のところで消える。
     */
    it('版を教える 1 枚は不変にしない', async () => {
      const res = await fetch(`${base}/skill-list/index.json`);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-cache');
      expect(((await res.json()) as { latest: string }).latest).toBe('abc123.json');
    });

    /**
     * 表は数 MB あり、縮めずに出すと他の資産の合計より大きくなる。
     * `fetch` は content-encoding を見て自分で戻してしまうので、
     * 縮んでいることを見るには生の HTTP で叩く必要がある。
     */
    it('大きい JSON は縮めて出す', async () => {
      const gzipped = await rawGet('/skill-list/abc123.json', 'gzip');
      expect(gzipped.headers['content-encoding']).toBe('gzip');
      expect(gzipped.headers['vary']).toContain('accept-encoding');
      // 数字の並びなので、いちばん弱い段でも半分よりずっと小さくなる。
      expect(gzipped.bytes).toBeLessThan(body.length / 2);

      // 縮められない相手には、長さを付けてそのまま出す。
      const plain = await rawGet('/skill-list/abc123.json', 'identity');
      expect(plain.headers['content-encoding']).toBeUndefined();
      expect(plain.headers['content-length']).toBe(String(body.length));
    });

    /**
     * **無い版が HTML の 200 で返ると、読む側は JSON.parse が投げるまで気付けない。**
     * 版を取り違えたのか配り忘れたのかも分からなくなる。
     */
    it('無い版は index.html ではなく 404 になる', async () => {
      const res = await fetch(`${base}/skill-list/no-such-version.json`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('<html>');
    });
  });
});
