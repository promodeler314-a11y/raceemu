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

/*
 * 事前計算したスキル一覧（#83）は `apps/web/public/skill-list/` にあり、
 * ビルドがそのまま dist へ運ぶので、この偽サーバは何も足さずに配る。
 * **見本を手で作って返すのはやめた。** 手書きの見本は書いた人が思っている形に
 * なるので、生成側が実際に出した形とズレていても気付けない。実際、基準個体が
 * 距離帯ごとに分かれたことに画面が追随できておらず、距離帯とバ場の絞り込みが
 * 実データで全滅していたのに、見本の検査は緑だった。
 *
 * 置いていない配布物のほうは、下の段で `page.route` を使って突く。
 */

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
    // normalize は Windows で区切りを '\' に変えるため、既定のページに落とす判定は
    // 変換前の URL で行う。これを normalize 後の値で見ると、'/' が '\' になって
    // 一致せず、配信の根をそのまま readFile することになる（Windows で 404 になる）。
    const requested = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const path = normalize(requested);
    const file = join(root, requested === '/' ? 'index.html' : path);
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
// 2026-09 時点で本体 1.62 MB、Worker 1.13 MB。全スキルの候補化（#59）で
// 本体が 10 kB 増えた。スキルデータは前から本体に入っているので、
// 候補を広げてもデータは増えない。
// スキル一覧の面（#83）で本体が 21 kB 増えた。**表そのものは入っていない。**
// 数 MB あるので動的に取りに行く（apps/web/src/skillList.ts）。増えたのは
// 画面と集計のぶんだけである。上限まで 40 kB ほどしかないので、次に増やす
// ときは分割を考えること。
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
  // スキル名のうしろに再現度の印（△ や ▲）が付くので、前方一致で引く。
  const row = rows.find((r) => (r[0] ?? '').startsWith('真骨頂'));
  return row === undefined ? NaN : Number.parseFloat(row[1]);
};
// 既定で入っているので、まず外して「順位を無視した」側を測る。
// 名前で引く。面に他の切り替えが増えたときに、先頭の 1 つを掴んで取り違えないようにする。
await page.uncheck('[data-testid=use-field]');
const withoutField = await runOnce();
await page.check('[data-testid=use-field]');
const withField = await runOnce();
console.log(`--- 逃げ + 真骨頂（後方寄り条件）の発動率: 順位無視 ${withoutField}% → フィールドあり ${withField}%`);
if (!(withoutField > 80)) fail('順位を無視したときの発動率が低すぎる');
// 相手を自分と同格にして束ごとに引き直すようになってから、逃げでも後ろに沈む
// 試行が出るので、判定しても 0 にはならない。はっきり落ちるところまでを見る。
// docs/order-field.md 4.3 節。
if (!(withField < withoutField / 2)) fail('フィールドを入れても発動率が落ちていない');
if (!(withField < 40)) fail('フィールドを入れても発動率が落ちていない');
// 以降の節はフィールド無しの速さで書いてあるので、外したままにする。
await page.uncheck('[data-testid=use-field]');
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
// 列は スキル / 単体 / 限界 / pt / ミリ秒/pt
if (referenceRow[3] !== '—') fail(`参考行に pt が入っている: ${referenceRow[3]}`);
if (referenceRow[2] !== '—') fail(`参考行に限界貢献度が入っている: ${referenceRow[2]}`);
const marginalCells = singleRows.slice(1).map((r) => r[2]);
if (marginalCells.length === 0) fail('単体評価の行が無い');
console.log('  限界貢献度の列:', marginalCells.join(' | '));
console.log('  参考行:', referenceRow[0], '/', referenceRow[1]);
await page.locator(optimizeSection).screenshot({ path: 'docs/images/m7-optimize.png' });

// 投げ先: 宛先を入れてサーバを選んでも、口が無ければブラウザに落ちること。
// この偽サーバは POST に HTML の 405 を返す（静的配信だけの版と同じ）。
// 状態番号ではなく中身が JSON かどうかで判断していないと、ここで倒れる。
const statsText = async () => (await page.textContent('[data-testid=optimize-stats]')).trim();
console.log('--- 投げ先（ブラウザで回したとき）:', await statsText());
if (!(await statsText()).startsWith('ブラウザ')) fail('既定でブラウザになっていない');
const targetServer = page.locator('[data-testid=search-target-server]');
if (await targetServer.isEnabled()) fail('宛先が空なのにサーバを選べる');
await page.fill('[data-testid=search-endpoint]', '/');
await targetServer.check();
await page.click('button:has-text("探索する")');
await page.waitForFunction(
  () => ![...document.querySelectorAll('button')].some((b) => b.textContent?.includes('探索中')),
  null,
  { timeout: 300000 },
);
await page.waitForTimeout(300);
const fellBack = await statsText();
console.log('--- 投げ先（サーバを選んだが口が無いとき）:', fellBack);
if (!fellBack.startsWith('ブラウザ')) fail(`口が無いのにブラウザへ落ちていない: ${fellBack}`);
const fallbackBest = await page.textContent(`${optimizeSection} h3`);
if (!/（\d+ pt/.test(fallbackBest)) fail(`落ちたあとに結果が出ていない: ${fallbackBest}`);
// 疎通の確認も、口が無いことを日本語で言って倒れないこと。
await page.click('button:has-text("疎通を確かめる")');
await page.waitForSelector('[data-testid=search-health]', { timeout: 20000 });
const healthText = (await page.textContent('[data-testid=search-health]')).trim();
console.log('--- 疎通の確認（サーバ無し）:', healthText);
if (!healthText.includes('口が無い')) fail(`口が無いことを伝えていない: ${healthText}`);
if (/JSON|Unexpected token/i.test(healthText)) fail(`生の例外が画面に出ている: ${healthText}`);

// 近似の感度分析: 近似の置き方を半分と倍に振って、短縮量の幅が出ることを確かめる。
// 3 通り × (1 + 候補) 構成を走らせるので、e2e では候補 2 個・50 試行まで落とす。
//
// 軸は 2 つある。距離の軸は順位条件を判定しているときだけ効くので、ここで判定を入れる
// （この段に来るまでに外してある）。軸を切り替えると注意の文が入れ替わることも見る。
const sensitivitySection = 'section:has(h2:text("近似の感度"))';
console.log('--- 近似の感度');
if (!(await page.isChecked('[data-testid=sensitivity-axis-near]'))) {
  fail('既定の軸が「近く」の距離になっていない');
}
const soloNote = (await page.textContent('[data-testid=sensitivity-axis-note]')).trim();
console.log('  距離の軸の注意（順位条件を判定していないとき）:', soloNote);
if (!soloNote.includes('何も動かない')) fail(`距離が効かない旨が出ていない: ${soloNote}`);
await page.check('[data-testid=use-field]');
const nearNote = (await page.textContent('[data-testid=sensitivity-axis-note]')).trim();
console.log('  距離の軸の注意（判定しているとき）:', nearNote);
if (nearNote === soloNote) fail('順位条件を入れても注意が変わらない');
await page.click('[data-testid=sensitivity-axis-rate]');
const rateNote = (await page.textContent('[data-testid=sensitivity-axis-note]')).trim();
console.log('  倍率の軸の注意（判定しているとき）:', rateNote);
if (!rateNote.includes('位置から決まる')) fail(`倍率が効かない旨が出ていない: ${rateNote}`);
await page.click('[data-testid=sensitivity-axis-near]');
const beforeEstimate = (await page.textContent('[data-testid=sensitivity-estimate]')).trim();
console.log('  実行前の見積もり:', beforeEstimate);
if (!/約/.test(beforeEstimate)) fail(`感度分析の見積もりが出ていない: ${beforeEstimate}`);
await page.fill('[data-testid=sensitivity-trials]', '50');
await page.fill('[data-testid=sensitivity-limit]', '2');
await page.click('button:has-text("近似の幅を測る")');
await page.waitForFunction(
  () => ![...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === '測っている'),
  null,
  { timeout: 300000 },
);
await page.waitForSelector('[data-testid=sensitivity-result]', { timeout: 10000 });
const sensitivityRows = await page.$$eval(
  '[data-testid=sensitivity-table] tbody tr',
  (trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((c) => c.textContent?.trim())),
);
for (const row of sensitivityRows) console.log('  幅', row.join(' | '));
if (sensitivityRows.length !== 2) fail(`感度分析の行数が想定と違う: ${sensitivityRows.length}`);
// 列は スキル / 軸に効くか / 振った値 3 通り / 幅 / 幅 ÷ 誤差
if (sensitivityRows[0].length !== 7) fail(`感度分析の列数が想定と違う: ${sensitivityRows[0].length}`);
const verdict = (await page.textContent('[data-testid=sensitivity-verdict]')).trim();
console.log(' ', verdict);
if (verdict.length === 0) fail('感度分析の読み方が出ていない');
// 実測が付いたら「目安」から「見込み」に変わる。
const afterEstimate = (await page.textContent('[data-testid=sensitivity-estimate]')).trim();
console.log('  実行後の見積もり:', afterEstimate);
if (!afterEstimate.startsWith('見込み')) fail(`実測が見積もりに反映されていない: ${afterEstimate}`);
await page.locator(sensitivitySection).screenshot({ path: 'docs/images/m10-sensitivity.png' });
// 順位条件はこの段のために入れたので、あとの段のために戻しておく。
await page.uncheck('[data-testid=use-field]');

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

// 全スキル: 入手経路を問わず、買えるスキル全体を候補にする。
// デッキのデータは要らないので、読み込みを待たずに数が出る。
await page.click('label:has-text("全スキル") input[type=radio]');
await page.waitForTimeout(200);
// 種類のつまみは育成計画と共有している。前の節で固有の継承版を閉じてあるので、
// ここで 3 つとも開いてから数える。
for (const kind of ['白', '金', '固有の継承版']) {
  await page.check(`label:has-text("${kind}") input[type=checkbox]`);
}
await page.waitForTimeout(200);
const allText = (await page.textContent('[data-testid=plan-candidates]')).trim();
console.log('--- 全スキル');
console.log(' ', allText);
const allCount = Number(/候補 (\d+) 個/.exec(allText)[1]);
if (!(allCount > 200)) fail(`全スキルの候補が少なすぎる: ${allCount}`);
if (allCount > 1200) fail(`サーバの上限を超える候補が既定で出ている: ${allCount}`);
// ▲（条件を落としている）を候補に残すと数が増える。順位条件を判定していない
// いまの設定では、順位と距離差の族がまるごと ▲ なので大きく変わる。
await page.uncheck('[data-testid=exclude-dropped]');
await page.waitForFunction(
  (before) => {
    const text = document.querySelector('[data-testid=plan-candidates]')?.textContent ?? '';
    return Number(/候補 (\d+) 個/.exec(text)?.[1] ?? before) > before;
  },
  allCount,
  { timeout: 10000 },
);
const withDropped = Number(
  /候補 (\d+) 個/.exec(await page.textContent('[data-testid=plan-candidates]'))[1],
);
console.log(`  ▲ を外したとき ${allCount} 個 / 入れたとき ${withDropped} 個`);
await page.check('[data-testid=exclude-dropped]');
await page.click('label:has-text("いま選んでいるスキル") input[type=radio]');

await goTab('設定');
await page.click('button:has-text("すべて外す")');

// 勝率: 全頭を同時に走らせ、着順が出ることを確かめる
// 脚質は前の段で変えてあるので、ここで決め直してから測る
await goTab('設定');
await page.click('[role=radiogroup][aria-label="脚質"] button:has-text("先行")');
// 1 本を開いたときに図へスキルの発動位置が乗ることを見たいので、1 つだけ持たせる
await page.fill('input[placeholder="スキル名で検索"]', '円弧のマエストロ');
await page.click('button:has-text("円弧のマエストロ")');
await page.fill('input[placeholder="スキル名で検索"]', '');
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

// 勝率の面から 1 レースを開く（#57）。
// フレーム列は持ち回っていないので、押すたびに同じ種で走らせ直している。
// 開いた中身が集計と食い違わないことは packages/sim/test/multi.test.ts が固定する。
// ここで見るのは「押すと出るか」「全頭ぶん出るか」「横にあふれないか」である。
const openButtons = await page.$$('button[data-testid^="open-order-"]');
if (openButtons.length === 0) fail('着順から 1 本を開くボタンが無い');
await openButtons[0].click();
await page.waitForSelector('[data-testid=multi-detail-head]', { timeout: 30000 });
await page.waitForTimeout(300);
console.log('--- 1 本を開く:', (await page.textContent('[data-testid=multi-detail-head]')).replace(/\s+/g, ' ').trim());
const detailRows = await readTestTable('multi-detail-table');
if (detailRows.length !== 9) fail(`開いた 1 本の着順表が 9 行でない: ${detailRows.length}`);
const detailOrders = detailRows.map((r) => Number(r[0]));
if ([...detailOrders].sort((a, b) => a - b).join(',') !== '1,2,3,4,5,6,7,8,9') {
  fail(`開いた 1 本の着順が 1 から 9 まで揃っていない: ${detailOrders.join(',')}`);
}
// 自分のスキルの発動位置が図に乗っていること（印があるときだけ出る注記で見る）
const detailText = await page.textContent('section:has([data-testid=multi-detail-head])');
if (!detailText.includes('三角の印')) fail('1 本の図にスキルの発動位置が乗っていない');
// 位置と速度の 2 枚が描けていること（uPlot は canvas に描く）
const detailCanvases = await page.locator('section:has([data-testid=multi-detail-head]) canvas').count();
console.log('--- 1 本の図:', detailCanvases, '枚');
if (detailCanvases < 2) fail(`位置と速度の図が揃っていない: ${detailCanvases} 枚`);
// 前後に移れること
const headBefore = await page.textContent('[data-testid=multi-detail-head]');
await page.click('button[aria-label="次の試行"]');
await page.waitForTimeout(400);
if ((await page.textContent('[data-testid=multi-detail-head]')) === headBefore) {
  fail('「次 →」で別の試行に移らない');
}
// 全頭ぶんの線を引く図は横にあふれやすいので、狭い幅でも見ておく
await page.setViewportSize({ width: 390, height: 900 });
await page.waitForTimeout(400);
const detailOverflow = await page.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
console.log('--- 1 本の中身を開いたまま幅 390:', detailOverflow, 'px');
if (detailOverflow > 0) fail('1 本の中身を開くと小さい画面で横にあふれる');
await page.setViewportSize({ width: 1280, height: 1600 });
await page.waitForTimeout(400);
await page
  .locator('section:has([data-testid=multi-detail-head])')
  .screenshot({ path: 'docs/images/multi-race-detail.png' });

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

// コース横断: 距離とバ場に当たる全コースを走らせ、コースごとに 1 行出ること。
// 押す前に本数と所要時間が出ていることも見る（本数ぶん掛かるので、
// 見積もりが無いと数分かかる条件に気付けない）。
const crossEstimate = async () =>
  ((await page.locator('[data-testid=cross-estimate]').textContent()) ?? '').trim();
await page.selectOption('select[aria-label="距離"]', 'c:LONG');
await page.waitForTimeout(150);
const longEstimate = await crossEstimate();
await page.selectOption('select[aria-label="距離"]', 'd:3000');
await page.waitForTimeout(150);
const shortEstimate = await crossEstimate();
console.log('--- コース横断の見積もり: 長距離', longEstimate, '/ 芝3000m', shortEstimate);
if (!/(見込み|目安)/.test(shortEstimate)) fail('コース横断の実行前に所要時間が出ていない');
if (!/\d+ コース/.test(shortEstimate)) fail('コース横断で当たる本数が出ていない');
if (longEstimate === shortEstimate) fail('距離を変えてもコース横断の見積もりが変わらない');

await page.fill('input[aria-label="コース 1 本あたりの試行回数"]', '100');
await page.click('button:has-text("コースを走らせる")');
await page.waitForFunction(
  () => ![...document.querySelectorAll('button')].some((b) => b.textContent?.includes('計算中')),
  null,
  { timeout: 180000 },
);
await page.waitForTimeout(300);
const crossRows = await page.$$eval('[data-testid=cross-table] tbody tr', (trs) =>
  trs.map((tr) => [...tr.querySelectorAll('th,td')].map((c) => c.textContent?.trim())),
);
console.log('--- コース横断');
for (const row of crossRows) console.log(' ', row.join(' | '));
// 芝3000m は 2 コースある。距離が 1 つだけなので区切りの行は出ない。
if (crossRows.length !== 2) fail(`コース横断の行数が想定と違う: ${crossRows.length}`);
if (!crossRows.some((row) => row.includes('最速'))) fail('最速のコースに印が付いていない');
const crossNote = await page.locator('section:has(h2:text("コース横断")) p').last().textContent();
if (!/順位条件/.test(crossNote ?? '')) fail('コース横断に順位条件の扱いが書かれていない');
await page.locator('section:has(h2:text("コース横断"))').screenshot({
  path: 'docs/images/cross-course.png',
});

// スキル一覧（#83）: 事前に計算した表を読んで並べる面。
// **配ってある実データ（apps/web/public/skill-list/）をそのまま読む。**
// ここでは 1 レースも走らせない。
//
// **軸はコースであって距離帯ではない。** 一覧（index.json）でどのコースが
// 置いてあるかを知り、選ばれた 1 枚だけを取りに行く。
await goTab('スキル表');
await page.waitForSelector('[data-testid=skill-list-table]', { timeout: 60000 });
const skillListSection = 'section:has(h2:text("スキル一覧"))';
const skillListCount = async () => {
  const text = (await page.textContent('[data-testid=skill-list-count]')).trim();
  return Number(/^([\d,]+) 件中/.exec(text)[1].replace(/,/g, ''));
};
const defaultCount = await skillListCount();
console.log('--- スキル一覧（実データ）:', defaultCount, 'スキル');
if (!(defaultCount > 100)) fail(`スキル一覧の件数が少なすぎる: ${defaultCount}`);
const skillListRows = await readTestTable('skill-list-table');
for (const row of skillListRows.slice(0, 3)) console.log(' ', row.join(' | '));
// 一度に出すのは 50 行まで。全スキルを一度に描くと絞り込みのたびに固まる。
if (skillListRows.length !== 50) fail(`スキル一覧の行数が想定と違う: ${skillListRows.length}`);
// 列は スキル / 短縮 / バ身 / 発動率 / 発動時 / pt / ミリ秒/pt
if (skillListRows[0].length !== 7) fail(`スキル一覧の列数が想定と違う: ${skillListRows[0].length}`);
// バ身は秒から換算している。0 にはならない。
if (!(Number.parseFloat(skillListRows[0][2]) > 0)) fail('バ身が出ていない');
// 版と、何から作ったかが画面に出ていること（値は相手の分布に依る）
const skillListVersion = (await page.textContent('[data-testid=skill-list-version]')).trim();
console.log('--- スキル一覧の版:', skillListVersion.replace(/\s+/g, ' ').slice(0, 110));
if (!/版 \S+/.test(skillListVersion)) fail(`版が出ていない: ${skillListVersion}`);
if (!skillListVersion.includes('指紋')) fail('何から作ったかの指紋が出ていない');
// 表の読み方。単体であって限界ではないこと、バ身が裏取り前であること、
// 行が無いことに 2 通りあることを、画面が言っていること。
const skillListNotes = (await page.textContent(skillListSection)).replace(/\s+/g, '');
for (const phrase of ['「単体」であって「限界」ではない', 'バ身は目安である', '行が無いことには2通りある', 'コースごとに']) {
  if (!skillListNotes.includes(phrase)) fail(`スキル一覧に「${phrase}」が書かれていない`);
}
// 測ってあるコースの数を画面が言っていること。全 137 コースは 20 時間を超えるので、
// 一部だけ置いてあるのが普通の状態である。「無い」と「測っていない」を混同させない。
const coverage = (await page.textContent('[data-testid=skill-list-coverage]')).replace(/\s+/g, '');
console.log('--- 測ってあるコース:', coverage.slice(0, 60));
if (!/測ってあるのは\d+コース/.test(coverage)) fail(`測ってあるコース数が出ていない: ${coverage}`);

// コースの選択欄。**ここが距離帯の選択欄に取って代わった。**
// 場ごとの optgroup に入っていて、値は `<場>-<コース>` の鍵である。
const courseOptions = await page.$$eval('[data-testid=skill-list-course] option', (os) =>
  os.map((o) => ({ value: o.value, label: o.textContent?.trim() ?? '' })),
);
const courseGroups = await page.$$eval('[data-testid=skill-list-course] optgroup', (gs) =>
  gs.map((g) => g.label),
);
console.log('--- コースの選択欄:', courseOptions.length, '本 /', courseGroups.length, '場');
if (courseOptions.length === 0) fail('コースの選択欄が空である');
if (courseGroups.length === 0) fail('コースが場でまとめられていない');
for (const { value } of courseOptions) {
  if (!/^\d+-\d+$/.test(value)) fail(`コースの鍵の形が違う: ${value}`);
}
// 版の欄にいま開いているコース名が出ていること（どのコースの表かを取り違えない）
const selectedCourse = await page.inputValue('[data-testid=skill-list-course]');
const selectedName = (courseOptions.find((o) => o.value === selectedCourse)?.label ?? '').split('（')[0];
if (selectedName === '' || !skillListVersion.includes(selectedName)) {
  fail(`開いているコース（${selectedName}）が版の欄に出ていない: ${skillListVersion.slice(0, 60)}`);
}

// コースを切り替えると別の表になる。**距離帯で畳んでいたら同じ値になるはずである。**
if (courseOptions.length > 1) {
  const firstTop = (await readTestTable('skill-list-table'))[0];
  const other = courseOptions.find((o) => o.value !== selectedCourse);
  await page.selectOption('[data-testid=skill-list-course]', other.value);
  await page.waitForSelector('[data-testid=skill-list-table]', { timeout: 30000 });
  await page.waitForTimeout(400);
  const otherCount = await skillListCount();
  const otherTop = (await readTestTable('skill-list-table'))[0];
  console.log(`--- コースを ${other.label} に切り替え:`, otherCount, 'スキル / 先頭', otherTop.slice(0, 2).join(' | '));
  if (!(otherCount > 0)) fail(`コース ${other.label} で 0 件になった`);
  if (firstTop[0] === otherTop[0] && firstTop[1] === otherTop[1]) {
    fail(`コースを変えても表が変わらない: ${firstTop.slice(0, 2).join(' | ')}`);
  }
  // 元に戻す。あとの段は既定のコースを前提にしている。
  await page.selectOption('[data-testid=skill-list-course]', selectedCourse);
  await page.waitForSelector('[data-testid=skill-list-table]', { timeout: 30000 });
  await page.waitForTimeout(400);
} else {
  console.log('--- 置いてあるコースが 1 本なので、コースの切り替えは飛ばす');
}

// 脚質で絞る。どの脚質でも 0 件にならないこと。
const styleOptions = await page.$$eval('[data-testid=skill-list-style] option', (os) =>
  os.map((o) => o.value),
);
for (const value of styleOptions.filter((v) => v !== 'ALL')) {
  await page.selectOption('[data-testid=skill-list-style]', value);
  await page.waitForTimeout(250);
  const count = await skillListCount();
  console.log(`--- 脚質 ${value}:`, count, 'スキル');
  if (!(count > 0)) fail(`脚質 ${value} で 0 件になった`);
}
await page.selectOption('[data-testid=skill-list-style]', 'ALL');
await page.waitForTimeout(250);

// 基準の個体は普通／強いの 2 段だけ。スタミナは併記する。
// **両段ともスタミナは育成の上限である。** 段の違いは速さ・パワー・根性・賢さだけで、
// スタミナを段の軸に混ぜていたころは上位が回復スキルで埋まっていた。
const tierOptions = await page.$$eval('[data-testid=skill-list-baseline] option', (os) =>
  os.map((o) => ({ value: o.value, label: o.textContent?.trim() ?? '' })),
);
console.log('--- 基準の個体の選択欄:', tierOptions.map((o) => `${o.value}=${o.label}`).join(' / '));
if (tierOptions.length !== 2) fail(`段が 2 つでない: ${tierOptions.length}`);
if (tierOptions.map((o) => o.value).join(',') !== 'normal,strong') {
  fail(`段の id が normal / strong でない: ${tierOptions.map((o) => o.value).join(',')}`);
}
if (!tierOptions.every((o) => /スタミナ\s*\d+/.test(o.label))) {
  fail(`スタミナが併記されていない: ${tierOptions.map((o) => o.label).join(' / ')}`);
}
// 段でスタミナが変わらないこと（変わっていたら段の軸が 2 つある）。
const tierStamina = [...new Set(tierOptions.map((o) => /スタミナ\s*(\d+)/.exec(o.label)[1]))];
console.log('--- 段ごとのスタミナ:', tierStamina.join(' / '));
if (tierStamina.length !== 1) fail(`段でスタミナが変わっている: ${tierStamina.join(' / ')}`);
if (!skillListNotes.includes('基準の個体はスタミナが足りている')) {
  fail('スタミナが足りている前提であることが書かれていない');
}
const normalTop = (await readTestTable('skill-list-table'))[0];
await page.selectOption('[data-testid=skill-list-baseline]', 'strong');
await page.waitForTimeout(300);
const strongCount = await skillListCount();
const strongTop = (await readTestTable('skill-list-table'))[0];
console.log('--- 段を強いに切り替え:', strongCount, 'スキル / 先頭', strongTop.slice(0, 2).join(' | '));
if (!(strongCount > 0)) fail('段を切り替えると 0 件になる');
if (normalTop[1] === strongTop[1] && normalTop[0] === strongTop[0]) {
  fail('段を切り替えても値が変わらない');
}
await page.selectOption('[data-testid=skill-list-baseline]', 'normal');
await page.waitForTimeout(300);

// 持っていないもののうち効率の高いものを勧める（探索の面への入口）
const recommendCount = await page.locator('[data-testid=skill-list-recommend] button').count();
console.log('--- 勧めているスキル:', recommendCount, '件');
if (recommendCount !== 5) fail(`勧めの件数が想定と違う: ${recommendCount}`);
// 上位互換のグループは差額と効果差で並ぶ
const groupRows = await readTestTable('skill-list-groups');
for (const row of groupRows.slice(0, 4)) console.log('  グループ', row.join(' | '));
if (groupRows.length < 2) fail(`上位互換のグループが出ていない: ${groupRows.length}`);
if (!groupRows.some((row) => (row[1] ?? '').startsWith('+'))) fail('上位が差額で出ていない');

// 設定の面で持っているスキル（円弧のマエストロ）に印が付く
await page.fill('input[aria-label="スキル名で絞る"]', '円弧のマエストロ');
await page.waitForTimeout(250);
const heldRows = await readTestTable('skill-list-table');
console.log('--- 持っているスキルの行:', heldRows.map((r) => r[0]).join(' / '));
if (!heldRows.some((row) => row[0].includes('✓'))) {
  fail(`持っているスキルに印が付いていない: ${heldRows.map((r) => r[0]).join(' / ')}`);
}
// 持っていないものだけに絞ると、その行が落ちる
await page.check('[data-testid=skill-list-only-missing]');
await page.waitForTimeout(250);
if ((await skillListCount()) !== 0) fail('持っていないものだけに絞れていない');
await page.uncheck('[data-testid=skill-list-only-missing]');
await page.fill('input[aria-label="スキル名で絞る"]', '');
await page.waitForTimeout(250);

// 行を押すと脚質ごとの内訳に降りる。
// **表がコースごとになったので、内訳はコースではなく脚質である。**
const firstRowButton = page.locator('[data-testid=skill-list-table] tbody tr th button').first();
const firstLabel = await firstRowButton.getAttribute('aria-label');
const firstName = firstLabel.replace(' の脚質ごとの内訳', '');
if ((await readTestTable('skill-list-table'))[0][0].includes('✓')) {
  fail(`先頭のスキルを既に持っている（この段の前提が崩れた）: ${firstName}`);
}
await firstRowButton.click();
await page.waitForSelector('[data-testid=skill-list-breakdown]', { timeout: 10000 });
const breakdownRows = await page.$$eval('[data-testid=skill-list-breakdown] tbody tr', (trs) =>
  trs.map((tr) => [...tr.querySelectorAll('th,td')].map((c) => c.textContent?.trim())),
);
console.log('--- 内訳:', firstName);
for (const row of breakdownRows) console.log('  ', row.join(' | '));
// 脚質は 4 つとも並ぶ。絞り込みで 1 つに決めていても、比べられるように全部出す。
// **測った行が無い脚質も並ぶ。** 脚質の条件を持つスキルは、当たらない脚質では
// 走らせる前に落としてあり、そう書いてある（0 と書き分ける）。
if (breakdownRows.length !== styleOptions.length - 1) {
  fail(`脚質ごとの内訳の行数が想定と違う: ${breakdownRows.length}`);
}
const dropped = breakdownRows.filter((row) => (row[1] ?? '').includes('走らせずに落とした'));
console.log('--- 内訳のうち走らせずに落とした脚質:', dropped.length, '件');
if (!breakdownRows.some((row) => !(row[1] ?? '').includes('走らせずに落とした'))) {
  fail('内訳がすべて「落とした」になっている');
}
const breakdownNote = await page.textContent('[data-testid=skill-list-breakdown]');
if (!breakdownNote.includes('発動位置の分布はここには出せない')) {
  fail('発動位置を出せないことが書かれていない');
}
// 内訳の見出しに、どのコースの話かが出ていること
if (!breakdownNote.includes('脚質ごとの内訳')) fail('内訳が脚質ごとだと書かれていない');

// 探索の面への入口。押すと所持に加わり、面が移る。
await page.locator(skillListSection).screenshot({ path: 'docs/images/skill-list.png' });
await page.click(`[data-testid=skill-list-breakdown] button[aria-label="${firstName} を所持に加えて探索の面へ"]`);
await page.waitForTimeout(300);
const movedTo = await page.evaluate(
  () => document.querySelector('nav button[aria-current="page"]')?.textContent?.trim() ?? '',
);
console.log('--- 勧めから移った先の面:', movedTo);
if (!movedTo.includes('探索')) fail(`探索の面へ移らない: ${movedTo}`);
await goTab('設定');
const addedNames = await heldNames();
if (!addedNames.some((name) => name.startsWith(firstName))) {
  fail(`スキル一覧から所持に加わらない: ${addedNames.join(' / ')}`);
}
// あとの段のために戻しておく
await page.click(`button[aria-label="${firstName} を外す"]`);

// スキル一覧が置いていない配布物で倒れないこと。
// 静的配信だけの版には数 MB の表を載せないことがあり、そこでは 404 か、
// 画面に落とす設定なら HTML が返る。どちらでも日本語で言って終わること。
for (const [label, handler] of [
  ['HTML が返る', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!DOCTYPE html><html><body>index</body></html>' })],
  ['404 が返る', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' })],
]) {
  const without = await browser.newPage();
  const withoutErrors = [];
  without.on('pageerror', (e) => withoutErrors.push(String(e)));
  await without.route('**/skill-list/**', handler);
  await without.goto('http://localhost:4173/#tab=skills', { waitUntil: 'load' });
  await without.waitForSelector('[data-testid=skill-list-error]', { timeout: 20000 });
  const missingText = (await without.textContent('[data-testid=skill-list-error]')).trim();
  console.log(`--- スキル一覧が無いとき（${label}）:`, missingText.slice(0, 60));
  if (/JSON|Unexpected token|undefined/i.test(missingText)) {
    fail(`生の例外が画面に出ている: ${missingText}`);
  }
  if (missingText.length < 10) fail(`無いことを伝えていない: ${missingText}`);
  // 他の面は表に依らないので、そのまま使えること
  await tabOf(without, '設定');
  if ((await without.locator('button:has-text("実行")').count()) === 0) {
    fail('スキル一覧が無いと他の面まで壊れる');
  }
  if (withoutErrors.length > 0) fail(`スキル一覧が無いとき例外が出た: ${withoutErrors.join(' / ')}`);
  await without.close();
}

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
await tabOf(reopened, '探索');
const keptEndpoint = await reopened.inputValue('[data-testid=search-endpoint]');
console.log('--- 開き直したときのスピード:', keptSpeed, '/ 比較の列数:', keptColumns, '/ 宛先:', keptEndpoint);
if (keptEndpoint !== '/') fail(`探索の宛先が残っていない: ${keptEndpoint}`);
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
if (!shared.includes('s=')) fail('共有 URL が作られていない');
if (!shared.includes('tab=')) fail(`共有 URL に面が載っていない: ${shared}`);
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

// 面を URL に載せる: タブが履歴を持ち、面を直接共有できる
await goTab('設定');
const hashOf = () => page.evaluate(() => location.hash);
await goTab('探索');
const solveHash = await hashOf();
console.log('--- 探索の面に移ったあとのハッシュ:', solveHash.slice(0, 40));
if (!solveHash.includes('tab=solve')) fail(`面がハッシュに載っていない: ${solveHash}`);
await goTab('比較');
if (!(await hashOf()).includes('tab=compare')) fail('面を移してもハッシュが変わらない');
// 戻ると面も戻る。
await page.goBack();
await page.waitForTimeout(250);
const backHash = await hashOf();
const backTab = await page.evaluate(
  () => document.querySelector('nav button[aria-current="page"]')?.textContent?.trim() ?? '',
);
console.log('--- 戻ったあとのハッシュと面:', backHash.slice(0, 20), '/', backTab);
if (!backHash.includes('tab=solve')) fail(`戻ってもハッシュが戻らない: ${backHash}`);
if (!backTab.includes('探索')) fail(`戻っても面が戻らない: ${backTab}`);
// 進むと元に戻る。
await page.goForward();
await page.waitForTimeout(250);
if (!(await hashOf()).includes('tab=compare')) fail('進んでも面が戻らない');

// 面だけを書いたリンクを直接開けること。
const direct = await browser.newPage();
await direct.goto('http://localhost:4173/#tab=solve', { waitUntil: 'load' });
await direct.waitForTimeout(400);
const directTab = await direct.evaluate(
  () => document.querySelector('nav button[aria-current="page"]')?.textContent?.trim() ?? '',
);
console.log('--- #tab=solve で開いた面:', directTab);
if (!directTab.includes('探索')) fail(`面を指すリンクで開けない: ${directTab}`);
await direct.close();
await goTab('設定');

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

// 見積もり: 押す前に待ち時間が出ていること
await goTab('設定');
const estimateText = (await page.locator('[data-testid=run-estimate]').textContent()) ?? '';
console.log('--- 実行前の見積もり:', estimateText.trim());
if (!/(見込み|目安)/.test(estimateText)) fail('実行前に所要時間が出ていない');
// 1 回走らせてあるので、目安ではなく実測に置き換わっているはず。
if (!estimateText.includes('見込み')) fail('走らせたあとも実測に置き換わっていない');
// 回数を増やすと見積もりも伸びる。
const estimateOf = async () =>
  ((await page.locator('[data-testid=run-estimate]').textContent()) ?? '').trim();
const countInput = page.locator('input[type=number][max="200000"]').first();
await countInput.fill('2000');
await page.waitForTimeout(150);
const small = await estimateOf();
await countInput.fill('200000');
await page.waitForTimeout(150);
const large = await estimateOf();
console.log(`--- 2000 試行 ${small} / 200000 試行 ${large}`);
if (small === large) fail('試行回数を 100 倍にしても見積もりが変わらない');
await countInput.fill('2000');

// 本家形式の受け渡し: 読み込みと書き出し
const transfer = page.locator('textarea[aria-label="本家の設定文字列"]');
await transfer.fill('スペシャルウィーク,1111,1222,1333,444,555,B,C,S,円弧のマエストロ,そんなスキルは無い');
await page.click('button:has-text("読み込む")');
await page.waitForTimeout(250);
const readBack = await page.getByLabel('スピード', { exact: true }).inputValue();
console.log('--- 本家形式を読み込んだあとのスピード:', readBack);
if (readBack !== '1111') fail(`本家形式のステータスが入っていない: ${readBack}`);
const transferSkills = await heldNames();
console.log('--- 読み込んだあとの所持スキル:', transferSkills.join(' / '));
if (!transferSkills.some((name) => name.startsWith('円弧のマエストロ'))) {
  fail('本家形式のスキルが入っていない');
}
if (!transferSkills.some((name) => name.startsWith('シューティングスター'))) {
  fail('キャラ名から固有が入っていない');
}
const warnText = (await page.locator('[data-testid=transfer-unknown]').textContent()) ?? '';
if (!warnText.includes('そんなスキルは無い')) fail('引き当てられなかった語が知らされていない');
console.log('--- 取りこぼしの知らせ:', warnText.trim().slice(0, 40));

await page.click('button:has-text("いまの設定を書き出す")');
await page.waitForTimeout(250);
const written = await transfer.inputValue();
console.log('--- 書き出した 1 行:', written);
if (!written.includes('1111,1222,1333,444,555,B,C,S')) fail(`書き出した値がずれている: ${written}`);
if (written.includes('シューティングスター')) fail('固有を書き出している');
// 書き出したものを読み直しても取りこぼしが出ないこと
await transfer.fill(written);
await page.click('button:has-text("読み込む")');
await page.waitForTimeout(250);
if ((await page.locator('[data-testid=transfer-unknown]').count()) > 0) {
  const left = await page.locator('[data-testid=transfer-unknown]').textContent();
  fail(`書き出したものを読み直すと取りこぼしが出る: ${left}`);
}
console.log('--- 書き出して読み直せた');

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
// 動かしている版と push してある版のズレを見分けられること（AGPL 13 条、
// docs/server-design.md 6 節）。版が取れない所で組むと空になるので、
// 出ているときだけ形を見る。
const commitCount = await page.locator('[data-testid=commit-sha]').count();
if (commitCount > 0) {
  const commit = (await page.textContent('[data-testid=commit-sha]')).trim();
  const commitHref = await page.getAttribute('footer a:has-text("ソースはこちら")', 'href');
  console.log('--- フッタのコミット:', commit, '/', commitHref);
  if (!/^[0-9a-f]{7,12}$/.test(commit)) fail(`コミットの形がおかしい: ${commit}`);
  if (!commitHref.endsWith(commit)) fail(`ソースのリンクがその版を指していない: ${commitHref}`);
} else {
  console.log('--- フッタのコミット: 無し（版が取れない所で組んだ）');
}

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
// 狭い幅の設定の面から実行できるか。横あふれが無いことと、使えることは別である。
// 以前は設定の列が高さを取り切って <main> が高さ 0 になり、実行バーごと消えていた
// （docs/ui-audit-race-emulator.md 第3節 B-1）。設定の列の最後まで送っても
// 押せることを見る。
await mobile.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
await mobile.waitForTimeout(200);
const mobileRun = mobile.getByRole('button', { name: '実行', exact: true });
const mobileRunBox = await mobileRun.boundingBox();
const mobileViewport = mobile.viewportSize();
console.log('--- 幅 390 の設定の面、最下部での実行ボタン:', mobileRunBox);
if (
  mobileRunBox === null ||
  mobileRunBox.height === 0 ||
  mobileRunBox.y < 0 ||
  mobileRunBox.y + mobileRunBox.height > mobileViewport.height
) {
  fail('小さい画面の設定の面で、実行ボタンが画面に出ていない');
} else {
  await mobileRun.click();
  await mobile.waitForSelector('[data-testid=average-time]', { timeout: 60000 });
}
// 探索の面は表が多い。開いた面だけを見ていると、あふれを見落とす。
await mobile.goto('http://localhost:4173/#tab=solve', { waitUntil: 'load' });
await mobile.waitForTimeout(300);
const solveOverflow = await mobile.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
console.log('--- 幅 390 での横あふれ（探索の面）:', solveOverflow, 'px');
if (solveOverflow > 0) fail('小さい画面の探索の面で横にあふれている');
// スキル一覧は列が 7 つある。狭い幅でいちばんあふれやすい面である。
await mobile.goto('http://localhost:4173/#tab=skills', { waitUntil: 'load' });
await mobile.waitForSelector('[data-testid=skill-list-table]', { timeout: 20000 });
await mobile.waitForTimeout(300);
const skillListOverflow = await mobile.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
console.log('--- 幅 390 での横あふれ（スキル一覧の面）:', skillListOverflow, 'px');
if (skillListOverflow > 0) fail('小さい画面のスキル一覧の面で横にあふれている');
await mobile.screenshot({ path: 'docs/images/skill-list-mobile.png', fullPage: true });
await mobile.close();

console.log('エラー:', errors.length === 0 ? 'なし' : errors);
if (errors.length > 0) fail('コンソールにエラーが出た');

await browser.close();
server.close();
