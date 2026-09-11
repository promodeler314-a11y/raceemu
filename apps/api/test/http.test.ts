import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadGameData } from '../../../packages/data/src/node.ts';
import type { Config } from '../src/config.ts';
import { createApiServer } from '../src/http.ts';
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
      tessdataPath: null, maxImageBytes: 1024, ocrThreshold: 128,
    };
    const runner = new JobRunner(config, data);
    server = createApiServer(config, data, runner);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  });

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
});
