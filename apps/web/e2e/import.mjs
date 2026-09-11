/**
 * 取り込みの面を、実際のサーバとブラウザで確かめる。
 *   pnpm build && node scripts/fetch-tessdata.mjs && pnpm e2e:import
 *
 * 静的ファイルと /api を同じオリジンから配る形（deploy/Dockerfile と同じ）で立てる。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

const fail = (message) => {
  console.error('失敗:', message);
  process.exitCode = 1;
};

if (!existsSync('.tessdata/jpn.traineddata')) {
  console.log('学習データが無いので飛ばす（node scripts/fetch-tessdata.mjs で取れる）');
  process.exit(0);
}

const port = 4174;
const server = spawn('node', ['--import', 'tsx', 'apps/api/src/main.ts'], {
  env: {
    ...process.env,
    PORT: String(port),
    RACEEMU_STATIC_ROOT: 'apps/web/dist',
    RACEEMU_TESSDATA: '.tessdata',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const ready = new Promise((resolve) => {
  server.stdout.on('data', (chunk) => {
    const line = String(chunk);
    process.stdout.write(`  [api] ${line}`);
    if (line.includes('listening')) resolve();
  });
});
await Promise.race([ready, new Promise((_, r) => setTimeout(() => r(new Error('サーバが立たない')), 30000))]);

const bundled = '/opt/pw-browsers/chromium';
const browser = await chromium.launch({
  executablePath: existsSync(bundled) ? bundled : undefined,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
});

try {
  // サブパスに置いたとき、末尾の "/" が無いと資産の相対参照が親の階層から
  // 解決されて真っ白になる（自前の k3s で実際に起きた）。手前の proxy が
  // 接頭辞を外さずに転送してくる場合も想定し、apps/api の実サーバで確かめる。
  {
    const subPage = await browser.newPage();
    const subErrors = [];
    subPage.on('pageerror', (e) => subErrors.push(String(e)));
    await subPage.goto(`http://localhost:${port}/raceemu`, { waitUntil: 'load' });
    const landed = new URL(subPage.url()).pathname;
    if (landed !== '/raceemu/') fail(`末尾に "/" が付け直されていない: ${landed}`);
    const heading = await subPage.textContent('h1').catch(() => null);
    if (heading === null || heading.trim() === '') fail('サブパスから開くと画面が真っ白になる');
    if (subErrors.length > 0) fail(`サブパスから開くとエラーが出る: ${subErrors.join(', ')}`);
    await subPage.close();
  }

  await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' });
  // 左の面全体も section なので、内側のパネルを取る
  const section = 'section.rounded-sm:has(h2:text("画面から取り込む"))';
  await page.setInputFiles(`${section} input[type=file]`, 'apps/api/test/fixtures/skill-list.png');
  await page.waitForSelector(`${section} table`, { timeout: 120000 });

  const rows = await page.$$eval(`${section} table tbody tr`, (trs) =>
    trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent?.trim())),
  );
  console.log('--- 読み取った候補');
  for (const row of rows) console.log(' ', row.slice(1).join(' | '));
  const expected = [
    '弧線のプロフェッサー', '円弧のマエストロ', '中距離コーナー○', '中距離直線○',
    '一匹狼', '好転一息', '正攻法', '真骨頂', 'スリップストリーム', '末脚',
  ];
  // 確信度が低い行は、同じセルに読み取った文字と紛らわしい候補の名前が続けて入る
  // （Import.tsx の「要確認」の注記）。前方一致で見る。
  const names = rows.map((r) => (r[1] ?? '').replace('（所持済み）', ''));
  for (const name of expected) {
    if (!names.some((n) => n.startsWith(name))) fail(`${name} が候補に出ていない`);
  }

  const before = await page.locator('button:has-text("選んだ")').textContent();
  console.log('--- 取り込みボタン:', before?.trim());
  await page.click('button:has-text("選んだ")');
  await page.waitForTimeout(300);
  const held = await page.$$eval('[data-testid="held-skills"] tbody tr th', (ths) =>
    ths.map((th) => th.textContent?.trim() ?? ''),
  );
  console.log('--- 所持スキル:', held.join(' / '));
  for (const name of expected) {
    if (!held.some((h) => h.startsWith(name))) fail(`${name} が所持スキルに入っていない`);
  }

  // ステータスと適性の取り込み。見本は合成したもの（scripts/render-status-header.mjs）で、
  // 8 階級すべての色を入れてある。実機の写真はゲームの著作物なので置いていない。
  {
    const statusSection = 'section.rounded-sm:has(h2:text("画面からステータスを取り込む"))';
    await page.setInputFiles(
      `${statusSection} input[type=file]`,
      'apps/api/test/fixtures/status-header.png',
    );
    await page.waitForSelector(`${statusSection} table`, { timeout: 120000 });
    const read = await page.$$eval(`${statusSection} table tr`, (trs) =>
      trs.map((tr) => [...tr.querySelectorAll('th,td')].map((c) => c.textContent?.trim()).join('=')),
    );
    console.log('--- 読み取ったステータスと適性:', read.join(' '));

    await page.click(`${statusSection} button:has-text("設定に入れる")`);
    await page.waitForTimeout(300);

    // 見本の値。逆算の面にも同じ名前の入力があるので、最初の 1 つを取る。
    const expectedStats = [
      ['スピード', '2165'], ['スタミナ', '1240'], ['パワー', '1326'],
      ['根性', '1653'], ['賢さ', '1464'],
    ];
    const stats = [];
    for (const [label, expected] of expectedStats) {
      const value = await page.locator(`label:has-text("${label}") input[type=number]`).first().inputValue();
      stats.push(`${label}=${value}`);
      if (value !== expected) fail(`${label} が ${value}（${expected} のはず）`);
    }
    console.log('--- 入った数値:', stats.join(' / '));

    // 既定のコースは東京 芝2400m（芝・中距離）、脚質は先行。見本では順に S・D・G。
    const fits = {};
    for (const label of ['距離適性', 'バ場適性', '脚質適性']) {
      fits[label] = await page.locator(`label:has-text("${label}") select`).inputValue();
    }
    console.log('--- 入った適性:', Object.entries(fits).map(([k, v]) => `${k}=${v}`).join(' '));
    if (fits['バ場適性'] !== 'S') fail(`バ場適性が ${fits['バ場適性']}（S のはず）`);
    if (fits['距離適性'] !== 'D') fail(`距離適性が ${fits['距離適性']}（D のはず）`);
    if (fits['脚質適性'] !== 'G') fail(`脚質適性が ${fits['脚質適性']}（G のはず）`);
  }

  await page.locator(section).screenshot({ path: 'docs/images/m10-import.png' });
  console.log('エラー:', errors.length === 0 ? 'なし' : errors);
  if (errors.length > 0) fail('コンソールにエラーが出た');
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
