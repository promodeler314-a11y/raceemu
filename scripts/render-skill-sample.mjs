/**
 * 読み取りの検査に使う見本の画像を作る。
 *   node scripts/render-skill-sample.mjs
 *
 * ゲームの画面そのものではない。スキル名が縦に並んだ絵を組み立てているだけである。
 * 本物の画面での精度は、これでは測れない。docs/ocr-design.md の 5 節を参照。
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

export const SAMPLE_NAMES = [
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

const html = `<html><body style="margin:0;background:#f2ede2;font-family:'IPAGothic','Noto Sans JP',sans-serif">
<div style="padding:24px">
${SAMPLE_NAMES.map(
  (name) => `<div style="display:flex;align-items:center;gap:12px;margin:10px 0;background:#fff;border-radius:10px;padding:10px 16px;width:560px">
  <div style="width:44px;height:44px;border-radius:50%;background:#dcd4c2"></div>
  <div style="font-size:22px;color:#4a3f2f">${name}</div>
</div>`,
).join('')}
</div></body></html>`;

const bundled = '/opt/pw-browsers/chromium';
const browser = await chromium.launch({
  executablePath: existsSync(bundled) ? bundled : undefined,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 620, height: 40 + SAMPLE_NAMES.length * 74 } });
await page.setContent(html);
await page.screenshot({ path: 'apps/api/test/fixtures/skill-list.png' });
await browser.close();
console.log(`apps/api/test/fixtures/skill-list.png に ${SAMPLE_NAMES.length} 件を描いた`);
