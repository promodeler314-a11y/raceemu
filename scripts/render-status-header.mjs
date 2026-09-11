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

export const SAMPLE_STATUS = [2165, 1240, 1326, 1653, 1464];

/**
 * 実機の 1 枚に写っていたのと同じ並び。
 *
 * 階級ごとの色も実機で測った色相に合わせる（`apps/api/src/status-reader.ts` の
 * `RANK_HUES`）。色で階級を決める道筋を、見本でも通せるようにするためである。
 * C・D・E は実機の写真に写っておらず色が分からないので、見本にも入れない。
 */
export const SAMPLE_APTITUDES = ['A', 'G', 'A', 'S', 'B', 'G', 'F', 'A', 'A', 'S'];

/** 実機で測った色相。G だけは彩度が無い（灰色）。 */
const RANK_COLORS = {
  S: 'hsl(41, 85%, 45%)',
  A: 'hsl(24, 85%, 45%)',
  B: 'hsl(342, 75%, 50%)',
  F: 'hsl(245, 60%, 55%)',
  G: '#8a8a8a',
};

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

const cell = (rect, text, size, color = '#3c3226') => {
  const { left, top, width, height } = box(rect);
  return `<div style="position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;
    display:flex;align-items:center;justify-content:center;color:${color};font-size:${size}px;
    font-family:'IPAGothic','Noto Sans JP',sans-serif;font-weight:700">${text}</div>`;
};

const html = `<html><body style="margin:0;background:#f6f1e6;width:${WIDTH}px;height:${HEIGHT}px;position:relative">
${STATUS.map((rect, i) => cell(rect, SAMPLE_STATUS[i], 34)).join('')}
${APTITUDE.map((rect, i) => cell(rect, SAMPLE_APTITUDES[i], 30, RANK_COLORS[SAMPLE_APTITUDES[i]])).join('')}
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
