/**
 * 裏取り（`apps/api/src/skill-verify.ts`）の検査に使う見本を作る。
 *   node scripts/render-unknown-skill-sample.mjs
 *
 * 分類モデルが名前を知らないスキルを、行の帯として縦に並べただけの絵である。
 * ゲームの画面そのものではないので、本物の写真での精度はこれでは測れない
 * （docs/ocr-design.md の 5 節と同じ立ち位置）。ここで確かめられるのは、
 * 帯を 1 つずつ切り出して読む道筋が通っていることと、モデルの語彙に有る名前を
 * 誤って拾い直さないことである。
 *
 * 行の高さと幅は固定にしてあり、検査側は i 番目の帯を
 * `{ left: 0, top: i * ROW_HEIGHT, width: ROW_WIDTH, height: ROW_HEIGHT }`
 * として切り出す。
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

export const ROW_WIDTH = 400;
export const ROW_HEIGHT = 40;

/** 前半はモデルの語彙に無いもの、最後の 2 件は有るもの（拾ってはいけない）。 */
export const SAMPLE_ROWS = [
  '先導者',
  '急先鋒',
  'レースメイカー',
  '奥の手',
  'ダブルアクセル',
  'ポイントマン',
  '一石二鳥',
  '末脚',
  '正攻法',
];

const html = `<html><body style="margin:0;background:#fff;font-family:'IPAGothic','Noto Sans JP',sans-serif">
${SAMPLE_ROWS.map(
  (name) => `<div style="width:${ROW_WIDTH}px;height:${ROW_HEIGHT}px;display:flex;align-items:center;padding-left:8px;box-sizing:border-box;font-size:22px;color:#4a3f2f">${name}</div>`,
).join('')}
</body></html>`;

const bundled = '/opt/pw-browsers/chromium';
const browser = await chromium.launch({
  executablePath: existsSync(bundled) ? bundled : undefined,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({
  viewport: { width: ROW_WIDTH, height: SAMPLE_ROWS.length * ROW_HEIGHT },
});
await page.setContent(html);
await page.screenshot({ path: 'apps/api/test/fixtures/unknown-skill-rows.png' });
await browser.close();
console.log(`apps/api/test/fixtures/unknown-skill-rows.png に ${SAMPLE_ROWS.length} 行を描いた`);
