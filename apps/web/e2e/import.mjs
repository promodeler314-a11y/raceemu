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

  await page.locator(section).screenshot({ path: 'docs/images/m10-import.png' });
  console.log('エラー:', errors.length === 0 ? 'なし' : errors);
  if (errors.length > 0) fail('コンソールにエラーが出た');
} finally {
  await browser.close();
  server.kill('SIGTERM');
}
