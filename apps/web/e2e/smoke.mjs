import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = '/home/user/raceemu/apps/web/dist';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const file = join(root, path === '/' ? 'index.html' : path);
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});
await new Promise((r) => server.listen(4173, r));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
console.log('タイトル:', await page.textContent('h1'));
console.log('hardwareConcurrency:', await page.evaluate(() => navigator.hardwareConcurrency));

// スキルを 2 つ入れる
for (const name of ['弧線のプロフェッサー', '円弧のマエストロ']) {
  await page.fill('input[placeholder="スキル名で検索"]', name);
  await page.click(`button:has-text("${name}")`);
}
await page.fill('input[placeholder="スキル名で検索"]', '');

const started = Date.now();
await page.click('button:has-text("実行")');
await page.waitForSelector('td:text-matches("秒$")', { timeout: 180000 });
const elapsed = Date.now() - started;

const rows = await page.$$eval('section table tr', (trs) =>
  trs.map((tr) => [tr.querySelector('th')?.textContent, tr.querySelector('td')?.textContent]),
);
console.log('--- 結果');
for (const [k, v] of rows) console.log(' ', k, v);
console.log('--- 実測: 2000 試行を', elapsed, 'ms（UI 操作込み）');
console.log('uPlot の図の数:', await page.locator('.u-wrap').count());
await page.click('button:has-text("最遅")');
await page.waitForTimeout(500);
await page.screenshot({ path: 'docs/images/m3-screenshot.png', fullPage: true });
console.log('エラー:', errors.length === 0 ? 'なし' : errors);
await browser.close();
server.close();
