/**
 * 読み取りの検査に使う、実機同等の難易度の見本を作る。
 *   node scripts/render-hard-skill-sample.mjs
 *
 * ゲームの画面そのものではないが、背景の模様、丸いアイコン、装飾つきの
 * 金枠、縦に長い一覧といった、実機で精度が落ちた要因を再現している。
 * スキル名は実際に送られてきた画面に写っていたものと同じ 21 件である。
 * docs/ocr-design.md の 5 節を参照。
 */
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

export const HARD_SAMPLE_NAMES = [
  '聖夜のミラクルラン！',
  'ワクワククライマックス',
  'スカーレットリリィの高揚',
  'アド・アストラ',
  '夏ウマ娘○',
  '弧線のプロフェッサー',
  'ハヤテ一文字',
  '中距離直線○',
  '差し直線○',
  '十万バリキ',
  '小休憩',
  'スリーセブン',
  'ウマ好み',
  '尻尾の滝登り',
  '下り坂巧者',
  '食らいつき',
  '連鎖反応',
  '活路を拓く！',
  '千鍛万錬',
  '前人未到',
  '奮い立つ心',
];

const html = `<html><body style="margin:0;font-family:'IPAGothic',sans-serif;background:
  repeating-linear-gradient(45deg, #b8e08a 0 20px, #a8d878 20px 40px);">
<div style="background:linear-gradient(90deg,#7fd858,#5cc040);padding:16px;text-align:center;
  color:#fff;font-size:28px;font-weight:bold;letter-spacing:4px;">ウマ娘詳細</div>
<div style="display:flex;gap:16px;padding:16px;background:#fffaf0;align-items:center;">
  <div style="width:180px;height:180px;border-radius:50%;
    background:radial-gradient(circle at 35% 30%, #eee 0%, #99a 40%, #557 100%);
    border:6px solid gold;"></div>
  <div>
    <div style="display:inline-block;background:#ffd700;border-radius:50%;width:70px;height:70px;
      text-align:center;line-height:70px;font-weight:bold;color:#a00;">SS<br>RANK</div>
    <div style="font-size:22px;color:#333;margin-top:8px;">[キセキの白星]<br><b>テスト娘</b></div>
  </div>
</div>
<div style="display:flex;gap:8px;padding:8px 16px;background:#e8f5d8;flex-wrap:wrap;">
  ${['スピード 1220', 'スタミナ 698', 'パワー 967', '根性 551', '賢さ 804']
    .map((s) => `<div style="background:#fff;border-radius:20px;padding:6px 14px;font-size:16px;">${s}</div>`)
    .join('')}
</div>
<div style="padding:12px 16px;">
${HARD_SAMPLE_NAMES.map(
  (name, i) => `<div style="display:flex;align-items:center;gap:10px;margin:6px 0;
  background:${i % 5 === 0 ? 'linear-gradient(90deg,#ffe27a,#ffcf40)' : '#e5e0f5'};
  border-radius:10px;padding:10px 16px;box-shadow:0 1px 3px rgba(0,0,0,.2);">
  <div style="width:40px;height:40px;border-radius:50%;
    background:radial-gradient(circle,#ffb347,#ff8c00);flex:none;"></div>
  <div style="font-size:19px;color:#4a3f2f;">${name}</div>
</div>`,
).join('')}
</div>
</body></html>`;

const bundled = '/opt/pw-browsers/chromium';
const browser = await chromium.launch({
  executablePath: existsSync(bundled) ? bundled : undefined,
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 978, height: 2400 }, deviceScaleFactor: 2 });
await page.setContent(html);
await page.screenshot({ path: 'apps/api/test/fixtures/hard-skill-list.png', fullPage: true });
await browser.close();
console.log(`apps/api/test/fixtures/hard-skill-list.png に ${HARD_SAMPLE_NAMES.length} 件を描いた`);
