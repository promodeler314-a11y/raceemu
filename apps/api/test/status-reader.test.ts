import { existsSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { OcrEngine } from '../src/ocr.ts';
import { readStatusHeader, StatusOutOfFrameError } from '../src/status-reader.ts';

/**
 * 見本の画像は組み立てたものであって、ゲームの画面ではない。しかも
 * `scripts/render-status-header.mjs` が切り出しと同じ割合から描いている。
 *
 * **したがって、ここで割合の正しさは測れない。** 測れるのは、切り出した絵が
 * 数字と記号として読めること、丸囲み数字の直しが効くこと、上半分の写っていない
 * 画像を断ることである。実機での精度は docs/ocr-design.md の 7 節に残してある。
 */
/** `scripts/render-status-header.mjs` が描いた値。あちらを変えたらここも変える。 */
const SAMPLE_STATUS = [1247, 986, 1103, 642, 878];
const SAMPLE_APTITUDES = ['A', 'G', 'F', 'B', 'A', 'C', 'A', 'B', 'D', 'E'];

const TESSDATA = process.env['RACEEMU_TESSDATA'] ?? '.tessdata';
const available = existsSync(`${TESSDATA}/jpn.traineddata`);
const engine = available ? new OcrEngine({ tessdataPath: TESSDATA }) : null;

afterAll(async () => {
  await engine?.dispose();
});

describe.skipIf(!available)('ステータスの読み取り', () => {
  it('見本のステータスと適性を読む', async () => {
    const image = readFileSync('apps/api/test/fixtures/status-header.png');
    const reading = await readStatusHeader(image, engine!);
    expect(reading.status).toEqual(SAMPLE_STATUS);
    expect(Object.values(reading.aptitudes)).toEqual(SAMPLE_APTITUDES);
  });

  it('黒帯の無い画像では全体が内容領域になる', async () => {
    const image = readFileSync('apps/api/test/fixtures/status-header.png');
    const reading = await readStatusHeader(image, engine!);
    expect(reading.content).toEqual({ left: 0, top: 0, width: 1080, height: 2400 });
  });

  it('別の画面（スキル一覧）は断る', async () => {
    // 縦さえ足りていれば矩形は収まってしまうので、位置だけでは見分けられない。
    // 数字として読めた枠の数で断っている。
    const image = readFileSync('apps/api/test/fixtures/skill-list.png');
    await expect(readStatusHeader(image, engine!)).rejects.toBeInstanceOf(StatusOutOfFrameError);
  });
});
