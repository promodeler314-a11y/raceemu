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
  // 静的配信だけの環境と同じ振る舞いにする。POST は受け付けず、本文は HTML で返す。
  // 「JSON が返る前提」で書いた画面があると、ここで初めて露見する。
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.resume();
    res.writeHead(405, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!DOCTYPE html><html><body><h1>405</h1></body></html>');
    return;
  }
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
  if (m.type() !== 'error') return;
  // 外部からの読み込みの失敗はアプリの誤りではない。書体は CDN から取っており、
  // 取れなければ代替の書体で動く。取れないこと自体を検査で落とすと、
  // 外に出られない環境でこの検査が通らなくなる。
  if (m.text().startsWith('Failed to load resource')) return;
  errors.push(m.text());
});

await page.goto('http://localhost:4173/', { waitUntil: 'load' });
// ヘッダにタブが入ったので、面を移ってから触る。
// 実行すると自動で「結果」に移るため、設定を触る前には毎回戻る必要がある。
const tabOf = async (target, label) => {
  await target.click(`nav button:has-text("${label}")`);
  await target.waitForTimeout(120);
};
const goTab = (label) => tabOf(page, label);

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

// 結果の主数字とスキルの表は、見出しの文言ではなく data-testid で拾う。
// モックへ寄せる作業で見出しは変わるが、ここで見たいものは変わらないため。
const readTestTable = async (testId) =>
  page.$$eval(`[data-testid="${testId}"] tbody tr`, (trs) =>
    trs.map((tr) => [...tr.querySelectorAll('th,td')].map((c) => c.textContent?.trim())),
  );
const digits = (text) => (text ?? '').replace(/[^0-9]/g, '');

console.log('--- 結果');
const averageTime = await page.textContent('[data-testid=average-time]');
const trialCount = digits(await page.textContent('[data-testid=trial-count]'));
console.log('  平均タイム', averageTime, '/ 試行回数', trialCount);
if (trialCount !== '2000') fail(`試行回数が合わない: ${trialCount}`);
if (averageTime === null || averageTime.trim() === '') fail('平均タイムが出ていない');

const skillRows = await readTestTable('skill-table');
console.log('--- スキルごとの発動');
for (const row of skillRows) console.log(' ', row.join(' | '));
// 上で足した 2 つ。tbody だけを見るので、以前のようにヘッダ行は数に入らない。
if (skillRows.length !== 2) fail(`スキルの行数が想定と違う: ${skillRows.length}`);

await goTab('詳細');
console.log('uPlot の図の数:', await page.locator('.u-wrap').count());

// 固有スキル: 一覧には出ず、キャラを選んで取る
await goTab('設定');
await page.fill('input[placeholder="スキル名で検索"]', 'シューティングスター');
const sameName = await page.locator('ul li button:has-text("シューティングスター")').allTextContents();
// 固有と継承版は名前が同じで、一覧に出てよいのは継承版だけである。
if (sameName.length !== 1 || !sameName[0].includes('inherit')) {
  fail(`一覧に固有が出ている: ${sameName.join(' / ')}`);
}
await page.fill('input[placeholder="スキル名で検索"]', '');

const charaSelect = page.getByLabel('キャラ（固有と進化）');
await charaSelect.selectOption('[スペシャルドリーマー]スペシャルウィーク');
const heldNames = async () =>
  (await page.$$eval('[data-testid="held-skills"] tbody tr th', (ths) =>
    ths.map((th) => th.textContent?.trim() ?? ''),
  ));
const withUnique = await heldNames();
console.log('--- キャラを選んだあとの所持スキル:', withUnique.join(' / '));
if (!withUnique.some((name) => name.startsWith('シューティングスター') && name.includes('固有'))) {
  fail('キャラを選んでも固有が入らない');
}
await charaSelect.selectOption('');
const withoutUnique = await heldNames();
if (withoutUnique.some((name) => name.startsWith('シューティングスター'))) {
  fail('キャラを未選択に戻しても固有が残っている');
}

// 順位条件: フィールドを入れると、脚質と噛み合わないスキルの発動率が落ちる
await goTab('設定');
await page.fill('input[placeholder="スキル名で検索"]', '真骨頂');
await page.click('button:has-text("真骨頂")');
await page.fill('input[placeholder="スキル名で検索"]', '');
// 脚質は分割ボタンになった。役割と名前で引く。
await page.click('[role=radiogroup][aria-label="脚質"] button:has-text("逃げ")');
const runOnce = async () => {
  await page.click('button:has-text("実行")');
  await page.waitForFunction(
    () => ![...document.querySelectorAll('button')].some((b) => b.textContent?.includes('実行中')),
    null,
    { timeout: 180000 },
  );
  await page.waitForTimeout(200);
  await goTab('結果');
  const rows = await readTestTable('skill-table');
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
await goTab('設定');
await page.click('button[aria-label="真骨頂 を外す"]');

// 逆算: 最大スパートに必要なスタミナを求める
await page.selectOption('select:below(:text("目標"))', { index: 0 }).catch(() => {});
await goTab('探索');
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
await goTab('設定');
await page.click('button:has-text("すべて外す")');
for (const skillName of ['中距離コーナー○', '中距離直線○', '一匹狼']) {
  await page.fill('input[placeholder="スキル名で検索"]', skillName);
  await page.click(`button:has-text("${skillName}")`);
  await page.fill('input[placeholder="スキル名で検索"]', '');
}
await goTab('探索');
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

// 育成計画: 候補を手持ちではなく入手経路から組み立てる。
// サポートカードと育成ウマ娘のデータは別の塊に切ってあるので、
// 切り替えたあとに読み込みを待つ。
await page.click('label:has-text("育成計画") input[type=radio]');
await page.waitForSelector('[data-testid=plan-candidates]', { timeout: 60000 });
const planText = (await page.textContent('[data-testid=plan-candidates]')).trim();
console.log('--- 育成計画');
console.log(' ', planText);
const planCount = Number(/候補 (\d+) 個/.exec(planText)[1]);
// 手持ち 3 個から、白と固有の継承版が開いた数に変わる。
if (!(planCount > 100)) fail(`育成計画の候補が少なすぎる: ${planCount}`);
await page.click('label:has-text("固有の継承版") input[type=checkbox]');
await page.waitForFunction(
  (before) => {
    const text = document.querySelector('[data-testid=plan-candidates]')?.textContent ?? '';
    return Number(/候補 (\d+) 個/.exec(text)?.[1] ?? before) < before;
  },
  planCount,
  { timeout: 10000 },
);
console.log(' ', (await page.textContent('[data-testid=plan-candidates]')).trim());
await page.click('label:has-text("いま選んでいるスキル") input[type=radio]');

await goTab('設定');
await page.click('button:has-text("すべて外す")');

// 勝率: 全頭を同時に走らせ、着順が出ることを確かめる
// 脚質は前の段で変えてあるので、ここで決め直してから測る
await goTab('設定');
await page.click('[role=radiogroup][aria-label="脚質"] button:has-text("先行")');
await goTab('勝率');
await page.waitForTimeout(300);
await page.fill('input[type=number][max="50000"]', '200');
const multiStarted = Date.now();
await page.click('button:has-text("勝率を出す")');
await page.waitForFunction(
  () => ![...document.querySelectorAll('button')].some((b) => b.textContent?.includes('計算中')),
  null,
  { timeout: 300000 },
);
await page.waitForTimeout(300);
console.log('--- 勝率（9 頭同時、200 試行）:', Date.now() - multiStarted, 'ms（UI 操作込み）');
const orderRows = await readTable('着順');
for (const row of orderRows) console.log(' ', row.join(' | '));
if (orderRows.length !== 10) fail(`着順の行数が想定と違う: ${orderRows.length}`);
const cells = orderRows.slice(1).map((r) => r.map((c) => Number.parseFloat(c)));
const winSum = cells.reduce((a, r) => a + r[1], 0);
if (Math.abs(winSum - 100) > 0.6) fail(`勝率の合計が 100 % にならない: ${winSum}`);
// 平均着順の平均は (頭数 + 1) / 2 になる
const meanOfMeanOrder = cells.reduce((a, r) => a + r[4], 0) / cells.length;
if (Math.abs(meanOfMeanOrder - 5) > 0.05) fail(`平均着順の平均が 5 にならない: ${meanOfMeanOrder}`);
// 複勝率 >= 連対率 >= 勝率 は常に成り立つ
for (const r of cells) {
  if (!(r[3] >= r[2] && r[2] >= r[1])) fail(`複勝率と連対率と勝率の大小が合わない: ${r.join(' ')}`);
}
// 自分は相手より強くしてあるので、勝率は 1/9 より高い
if (!(cells[0][1] > 11.1)) fail(`自分の勝率が低すぎる: ${cells[0][1]}`);
await page.locator('section:has(h2:text("相手"))').screenshot({ path: 'docs/images/m9-field.png' });
// 相手の入力欄もステータスと同じ上限を持つので、設定に戻してから次へ進む
await goTab('設定');

// 比較: 設定を変えてもう一度実行し、2 列並ぶことを確かめる
await page.click('button:has-text("スナップショットを保存")');
await page.fill('input[type=number][max="2500"] >> nth=0', '1400');
await page.click('button:has-text("実行")');
await page.waitForFunction(
  () => ![...document.querySelectorAll('button')].some((b) => b.textContent?.includes('実行中')),
  null,
  { timeout: 180000 },
);
await page.click('button:has-text("スナップショットを保存")');
await goTab('比較');
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
await tabOf(reopened, '比較');
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
await goTab('設定');
await page.selectOption('label:has-text("スキル発動率") select', 'ALL');
await page.fill('input[type=number][max="12"] >> nth=0', '2');
const optionState = await page.evaluate(() => ({
  adjust: [...document.querySelectorAll('select')]
    .map((el) => el.value)
    .filter((v) => v === 'ALL').length,
}));
if (optionState.adjust === 0) fail('スキル発動率の選択が反映されていない');

// 読み取り: 静的配信だけの環境では、口が無いことを伝えて終わる。
// 状態番号ではなく中身が JSON かどうかで判断していないと、HTML を読もうとして落ちる。
await goTab('設定');
const importSection = 'section.rounded-sm:has(h2:text("画面から取り込む"))';
await page.setInputFiles(`${importSection} input[type=file]`, 'apps/api/test/fixtures/skill-list.png');
await page.waitForTimeout(1200);
const importNotes = await page.$$eval(`${importSection} p`, (ps) => ps.map((p) => p.textContent?.trim() ?? ''));
const importNote = importNotes[importNotes.length - 1];
console.log('--- 読み取り（サーバ無し）:', importNote);
if (!importNote.includes('読み取りの口が無い')) {
  fail(`口が無いことを伝えていない: ${importNote}`);
}
if (/JSON|Unexpected token/i.test(importNote)) fail(`生の例外が画面に出ている: ${importNote}`);

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
