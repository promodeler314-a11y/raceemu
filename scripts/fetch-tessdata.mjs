/**
 * 画面の読み取りに使う学習データを取ってくる。
 *   node scripts/fetch-tessdata.mjs [置き場]
 *
 * 35 MB あるのでリポジトリには置かない。
 * 開発では既定の .tessdata に、イメージを組むときは /usr/share/tessdata に置く。
 *
 * 標準の tessdata を使う理由は docs/ocr-design.md の 2 節にある。
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const dir = process.argv[2] ?? '.tessdata';
const lang = process.env.RACEEMU_TESSDATA_LANG ?? 'jpn';
const url = `https://raw.githubusercontent.com/tesseract-ocr/tessdata/main/${lang}.traineddata`;
const target = join(dir, `${lang}.traineddata`);

try {
  const found = await stat(target);
  if (found.size > 1_000_000) {
    console.log(`${target} は既にある（${(found.size / 1024 / 1024).toFixed(1)} MB）`);
    process.exit(0);
  }
} catch {
  // 無ければ取りに行く
}

await mkdir(dir, { recursive: true });
const response = await fetch(url);
if (!response.ok) throw new Error(`${url} が ${response.status} を返した`);
const body = Buffer.from(await response.arrayBuffer());
if (body.length < 1_000_000) throw new Error(`取れた中身が小さすぎる: ${body.length} バイト`);
await writeFile(target, body);
console.log(`${target} に置いた（${(body.length / 1024 / 1024).toFixed(1)} MB）`);
