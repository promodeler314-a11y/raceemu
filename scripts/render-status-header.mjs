/**
 * ステータスの読み取りの検査に使う見本の画像を作る。
 *   node scripts/render-status-header.mjs
 *
 * ゲームの画面そのものではない。`apps/api/src/status-header.ts` の割合どおりの
 * 位置に、数字と適性の文字を置いただけの絵である。
 *
 * **これで測れるのは経路だけである。** 切り出しの割合そのものは、この見本を
 * 同じ割合から描いている以上、正しさの証明にならない。読み取りが数字と記号に
 * 化けること、当てはめが効くことまでを見るためのものである。
 * docs/ocr-design.md の 7 節を参照。
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

export const SAMPLE_STATUS = [1247, 986, 1103, 642, 878];
export const SAMPLE_APTITUDES = ['A', 'G', 'F', 'B', 'A', 'C', 'A', 'B', 'D', 'E'];

// 実機に近い縦横比（9:16 より縦長のスマートフォン）にしておく。
const WIDTH = 1080;
const HEIGHT = 2400;

const STATUS = [
  [0.1074, 0.4833, 0.2111, 0.5111],
  [0.2926, 0.4833, 0.3963, 0.5111],
  [0.4778, 0.4833, 0.5815, 0.5111],
  [0.663, 0.4833, 0.7667, 0.5111],
  [0.8481, 0.4833, 0.9518, 0.5111],
];

const APTITUDE = [
  [0.3407, 0.5648, 0.3685, 0.5926],
  [0.5241, 0.5648, 0.5519, 0.5926],
  [0.3407, 0.6204, 0.3685, 0.6481],
  [0.5241, 0.6204, 0.5519, 0.6481],
  [0.7074, 0.6204, 0.7352, 0.6481],
  [0.8907, 0.6204, 0.9185, 0.6481],
  [0.3407, 0.6759, 0.3685, 0.7037],
  [0.5241, 0.6759, 0.5519, 0.7037],
  [0.7074, 0.6759, 0.7352, 0.7037],
  [0.8907, 0.6759, 0.9185, 0.7037],
];

/** 割合を画素に直す。縦も横幅で割る（status-header.ts と同じ）。 */
const box = ([l, t, r, b]) => ({
  left: l * WIDTH,
  top: t * WIDTH,
  width: (r - l) * WIDTH,
  height: (b - t) * WIDTH,
});

const cell = (rect, text, size) => {
  const { left, top, width, height } = box(rect);
  return `<div style="position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;
    display:flex;align-items:center;justify-content:center;color:#3c3226;font-size:${size}px;
    font-family:'IPAGothic','Noto Sans JP',sans-serif;font-weight:700">${text}</div>`;
};

const html = `<html><body style="margin:0;background:#f6f1e6;width:${WIDTH}px;height:${HEIGHT}px;position:relative">
${STATUS.map((rect, i) => cell(rect, SAMPLE_STATUS[i], 34)).join('')}
${APTITUDE.map((rect, i) => cell(rect, SAMPLE_APTITUDES[i], 30)).join('')}
</body></html>`;

const bundled = '/opt/pw-browsers/chromium';
const browser = await chromium.launch({
  executablePath: existsSync(bundled) ? bundled : undefined,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
await page.setContent(html);
await page.screenshot({ path: 'apps/api/test/fixtures/status-header.png' });
await browser.close();
console.log('apps/api/test/fixtures/status-header.png を描いた');
