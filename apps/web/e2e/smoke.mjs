/**
 * ビルドした成果物を実際のブラウザで動かして確かめる。
 *   pnpm build && pnpm e2e
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const root = 'apps/web/dist';
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const fail = (message) => {
  console.error('失敗:', message);
  process.exitCode = 1;
};

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

// バンドルの大きさ。減らしたものが黙って戻らないように上限を置く。
// 2026-09 時点で本体 1.44 MB、Worker 1.14 MB。
{
  const { readdir, stat } = await import('node:fs/promises');
  const files = await readdir(join(root, 'assets'));
  const sizeOf = async (match) => {
    const name = files.find((f) => f.startsWith(match) && f.endsWith('.js'));
    return name === undefined ? 0 : (await stat(join(root, 'assets', name))).size;
  };
  const main = await sizeOf('index-');
  const worker = await sizeOf('browser-worker-');
  const mb = (n) => (n / 1024 / 1024).toFixed(2);
  console.log(`--- バンドル: 本体 ${mb(main)} MB / Worker ${mb(worker)} MB`);
  if (main > 1.7 * 1024 * 1024) fail(`本体のバンドルが大きい: ${mb(main)} MB`);
  if (worker > 1.4 * 1024 * 1024) fail(`Worker のバンドルが大きい: ${mb(worker)} MB`);
}

// 開発コンテナには Chromium が置いてあるので、あればそれを使う。
// CI のランナーには無く、`playwright install` が入れた先を Playwright 自身が知っているので、
// その場合は指定しない。決め打ちにすると CI で起動できない。
const bundled = '/opt/pw-browsers/chromium';
const browser = await chromium.launch({
  executablePath: existsSync(bundled) ? bundled : undefined,
  args: ['--no-sandbox'],
});
// 永続化を確かめるため、主画面のタブは 1 つのコンテキストにまとめる。
// browser.newPage() はタブごとにコンテキストが分かれ、IndexedDB を共有しない。
const context = await browser.newContext({ viewport: { width: 1280, height: 1600 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

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

// 順位条件: フィールドを入れると、脚質と噛み合わないスキルの発動率が落ちる
await page.fill('input[placeholder="スキル名で検索"]', '真骨頂');
await page.click('button:has-text("真骨頂")');
await page.fill('input[placeholder="スキル名で検索"]', '');
await page.selectOption('select >> nth=4', 'NIGE');
const runOnce = async () => {
  await page.click('button:has-text("実行")');
  await page.waitForFunction(
    () => ![...document.querySelectorAll('button')].some((b) => b.textContent?.includes('実行中')),
    null,
    { timeout: 180000 },
  );
  await page.waitForTimeout(200);
  const rows = await readTable('スキルごとの発動');
  const row = rows.find((r) => r[0] === '真骨頂');
  return row === undefined ? NaN : Number.parseFloat(row[1]);
};
const withoutField = await runOnce();
await page.check('input[type=checkbox]');
const withField = await runOnce();
console.log(`--- 逃げ + 真骨頂（後方寄り条件）の発動率: 順位無視 ${withoutField}% → フィールドあり ${withField}%`);
if (!(withoutField > 80)) fail('順位を無視したときの発動率が低すぎる');
if (!(withField < 10)) fail('フィールドを入れても発動率が落ちていない');
await page.uncheck('input[type=checkbox]');
await page.click('button[aria-label="真骨頂 を外す"]');

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

// 組み合わせ探索: 候補を選び、予算に収まる構成が返ることを確かめる
await page.click('button:has-text("すべて外す")');
for (const skillName of ['中距離コーナー○', '中距離直線○', '一匹狼']) {
  await page.fill('input[placeholder="スキル名で検索"]', skillName);
  await page.click(`button:has-text("${skillName}")`);
  await page.fill('input[placeholder="スキル名で検索"]', '');
}
await page.fill('input[type=number][max="20000"][step="50"]', '250');
await page.click('button:has-text("探索する")');
await page.waitForFunction(
  () => ![...document.querySelectorAll('button')].some((b) => b.textContent?.includes('探索中')),
  null,
  { timeout: 300000 },
);
await page.waitForTimeout(300);
const optimizeSection = 'section:has(h2:text("組み合わせ探索"))';
const bestText = await page.textContent(`${optimizeSection} p:has(strong)`);
const bestCost = Number(/（(\d+) pt/.exec(await page.textContent(`${optimizeSection} h3`))[1]);
console.log('--- 組み合わせ探索');
console.log(' ', (await page.textContent(`${optimizeSection} h3`)).trim());
console.log(' ', bestText.trim());
const singleRows = await page.$$eval(
  `${optimizeSection} table >> nth=1 >> tr`,
  (trs) => trs.slice(1).map((tr) => [...tr.querySelectorAll('td')].map((c) => c.textContent?.trim())),
);
for (const row of singleRows) console.log('  単体', row.join(' | '));
if (!(bestCost <= 250)) fail(`予算を超えた構成が返った: ${bestCost} pt`);
// 先頭は位置取り調整の参考行、続いて候補 3 つ
if (singleRows.length !== 4) fail(`単体評価の行数が想定と違う: ${singleRows.length}`);
const referenceRow = singleRows[0];
if (!referenceRow[0].includes('位置取り調整')) fail('位置取り調整の参考行がない');
if (!referenceRow[0].includes('買えない')) fail('参考行に買えない旨が出ていない');
if (referenceRow[2] !== '—') fail(`参考行に pt が入っている: ${referenceRow[2]}`);
console.log('  参考行:', referenceRow[0], '/', referenceRow[1]);
await page.locator(optimizeSection).screenshot({ path: 'docs/images/m7-optimize.png' });
await page.click('button:has-text("すべて外す")');

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

// 永続化: 別のタブで開き直しても設定とスナップショットが残ること
await page.waitForTimeout(800); // 書き込みはまとめてから行う
const reopened = await context.newPage();
await reopened.goto('http://localhost:4173/', { waitUntil: 'load' });
await reopened.waitForTimeout(600);
const keptSpeed = await reopened.inputValue('input[type=number][max="2500"] >> nth=0');
const keptColumns = await reopened.evaluate(() => {
  const section = [...document.querySelectorAll('section')].find((el) =>
    el.querySelector('h2')?.textContent?.includes('比較'),
  );
  return section?.querySelectorAll('thead th').length ?? 0;
});
console.log('--- 開き直したときのスピード:', keptSpeed, '/ 比較の列数:', keptColumns);
if (keptSpeed !== '1400') fail(`設定が残っていない: ${keptSpeed}`);
if (keptColumns !== 3) fail(`スナップショットが残っていない: 列数 ${keptColumns}`);
await reopened.close();

// 実行オプション: 画面から変えられることと、共有 URL に載ることを確かめる
await page.selectOption('label:has-text("スキル発動率") select', 'ALL');
await page.fill('input[type=number][max="12"] >> nth=0', '2');
const optionState = await page.evaluate(() => ({
  adjust: [...document.querySelectorAll('select')]
    .map((el) => el.value)
    .filter((v) => v === 'ALL').length,
}));
if (optionState.adjust === 0) fail('スキル発動率の選択が反映されていない');

// 共有: URL に載せて開き直し、設定が戻ることを確かめる
await page.click('button:has-text("設定を URL に")');
const shared = page.url();
if (!shared.includes('#s=')) fail('共有 URL が作られていない');
const fresh = await browser.newPage();
await fresh.goto(shared, { waitUntil: 'load' });
const restored = await fresh.inputValue('input[type=number][max="2500"] >> nth=0');
console.log('--- 共有 URL から復元したスピード:', restored);
if (restored !== '1400') fail(`復元した値が違う: ${restored}`);
const restoredDebuff = await fresh.inputValue('input[type=number][max="12"] >> nth=0');
const restoredAdjust = await fresh.evaluate(
  () => [...document.querySelectorAll('select')].filter((el) => el.value === 'ALL').length,
);
console.log('--- 共有 URL から復元したデバフ個数:', restoredDebuff, '/ 発動率固定:', restoredAdjust > 0);
if (restoredDebuff !== '2') fail(`デバフの個数が復元されていない: ${restoredDebuff}`);
if (restoredAdjust === 0) fail('スキル発動率の設定が復元されていない');
await fresh.close();

// 壊れた共有 URL: 黙って既定値で開かず、読み取れなかったことを伝える
const broken = await browser.newPage();
await broken.goto('http://localhost:4173/#s=zzzz-not-a-real-state', { waitUntil: 'load' });
await broken.waitForTimeout(500);
const alertText = (await broken.locator('[role=alert]').first().textContent()) ?? '';
console.log('--- 壊れた共有 URL の知らせ:', alertText.slice(0, 40));
if (!alertText.includes('読み取れませんでした')) fail('壊れた共有 URL が黙って無視されている');
await broken.close();

// キーボード操作: Ctrl+Enter で実行できる
await page.keyboard.press('Control+Enter');
await page.waitForTimeout(300);
const startedByKey = await page.evaluate(() =>
  [...document.querySelectorAll('button')].some((b) => b.textContent?.includes('実行中')),
);
console.log('--- Ctrl+Enter で実行が始まった:', startedByKey);
if (!startedByKey) fail('Ctrl+Enter で実行が始まらない');
await page.keyboard.press('Escape');
await page.waitForFunction(
  () => ![...document.querySelectorAll('button')].some((b) => b.textContent?.includes('実行中')),
  null,
  { timeout: 60000 },
);
console.log('--- Esc で中断できた');

// 名前のないボタンが残っていないこと
const unnamed = await page.evaluate(
  () =>
    [...document.querySelectorAll('button')].filter(
      (b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim().length <= 1,
    ).length,
);
console.log('--- 名前のないボタン:', unnamed, '件');
if (unnamed > 0) fail(`読み上げで区別できないボタンが ${unnamed} 件ある`);

// ライセンス: ソースへのリンクが画面にあること（AGPL v3 の要求）
const sourceLink = await page.locator('footer a[href*="github.com"]').count();
console.log('--- フッタのソースリンク:', sourceLink, '件');
if (sourceLink < 2) fail('フッタに移植元とソースへのリンクが揃っていない');

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
