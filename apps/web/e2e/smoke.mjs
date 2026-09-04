/**
 * ビルドした成果物を実際のブラウザで動かして確かめる。
 *   pnpm build && pnpm e2e
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = 'apps/web/dist';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const file = join(root, path === '/' ? 'index.html' : path);
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(4173, r));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

const fail = (message) => {
  console.error('失敗:', message);
  process.exitCode = 1;
};

await page.goto('http://localhost:4173/', { waitUntil: 'load' });
console.log('タイトル:', await page.textContent('h1'));
console.log('hardwareConcurrency:', await page.evaluate(() => navigator.hardwareConcurrency));

for (const name of ['弧線のプロフェッサー', '円弧のマエストロ']) {
  await page.fill('input[placeholder="スキル名で検索"]', name);
  await page.click(`button:has-text("${name}")`);
}
await page.fill('input[placeholder="スキル名で検索"]', '');

const started = Date.now();
await page.click('button:has-text("実行")');
await page.waitForFunction(
  () => ![...document.querySelectorAll('button')].some((b) => b.textContent?.includes('実行中')),
  null,
  { timeout: 180000 },
);
await page.waitForTimeout(300);
console.log('2000 試行:', Date.now() - started, 'ms（UI 操作込み）');

const readTable = async (heading) =>
  page.$$eval(
    `section:has(h2:text("${heading}")) table tr`,
    (trs) => trs.map((tr) => [...tr.querySelectorAll('th,td')].map((c) => c.textContent?.trim())),
  );

const summaryRows = Object.fromEntries((await readTable('結果')).map(([k, v]) => [k, v]));
console.log('--- 結果');
for (const [k, v] of Object.entries(summaryRows)) console.log(' ', k, v);
if (summaryRows['試行回数'] !== '2000') fail('試行回数が合わない');

const skillRows = await readTable('スキルごとの発動');
console.log('--- スキルごとの発動');
for (const row of skillRows) console.log(' ', row.join(' | '));
if (skillRows.length !== 3) fail(`スキルの行数が想定と違う: ${skillRows.length}`);

console.log('uPlot の図の数:', await page.locator('.u-wrap').count());

// 逆算: 最大スパートに必要なスタミナを求める
await page.selectOption('select:below(:text("目標"))', { index: 0 }).catch(() => {});
await page.fill('input[type=number][max="20000"]', '300');
await page.click('button:has-text("逆算する")');
await page.waitForFunction(
  () => ![...document.querySelectorAll('button')].some((b) => b.textContent?.includes('計算中')),
  null,
  { timeout: 180000 },
);
await page.waitForTimeout(300);
const inverseRows = await readTable('逆算');
console.log('--- 逆算（最大スパートに必要なスタミナ）');
for (const row of inverseRows) console.log(' ', row.join(' | '));
if (inverseRows.length < 5) fail('逆算の表が出ていない');
const values = inverseRows.slice(1).map((r) => Number(r[1]));
for (let i = 1; i < values.length; i++) {
  if (values[i] < values[i - 1]) fail('達成率が上がったのに必要な値が下がっている');
}

// 比較: 設定を変えてもう一度実行し、2 列並ぶことを確かめる
await page.click('button:has-text("いまの結果を保存")');
await page.fill('input[type=number][max="2500"] >> nth=0', '1400');
await page.click('button:has-text("実行")');
await page.waitForFunction(
  () => ![...document.querySelectorAll('button')].some((b) => b.textContent?.includes('実行中')),
  null,
  { timeout: 180000 },
);
await page.click('button:has-text("いまの結果を保存")');
const compareRows = await readTable('比較');
console.log('--- 比較');
for (const row of compareRows.slice(0, 8)) console.log(' ', row.join(' | '));
if (compareRows[0].length !== 3) fail('比較の列数が想定と違う');

// 共有: URL に載せて開き直し、設定が戻ることを確かめる
await page.click('button:has-text("設定を URL に")');
const shared = page.url();
if (!shared.includes('#s=')) fail('共有 URL が作られていない');
const fresh = await browser.newPage();
await fresh.goto(shared, { waitUntil: 'load' });
const restored = await fresh.inputValue('input[type=number][max="2500"] >> nth=0');
console.log('--- 共有 URL から復元したスピード:', restored);
if (restored !== '1400') fail(`復元した値が違う: ${restored}`);
await fresh.close();

await page.click('button:has-text("最遅")');
await page.waitForTimeout(400);
await page.screenshot({ path: 'docs/images/m3-screenshot.png', fullPage: true });

const mobile = await browser.newPage({ viewport: { width: 390, height: 900 } });
await mobile.goto('http://localhost:4173/', { waitUntil: 'load' });
await mobile.waitForTimeout(300);
const overflow = await mobile.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
console.log('--- 幅 390 での横あふれ:', overflow, 'px');
if (overflow > 0) fail('小さい画面で横にあふれている');
await mobile.screenshot({ path: 'docs/images/m4-mobile.png', fullPage: true });
await mobile.close();

console.log('エラー:', errors.length === 0 ? 'なし' : errors);
if (errors.length > 0) fail('コンソールにエラーが出た');

await browser.close();
server.close();
