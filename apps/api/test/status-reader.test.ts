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
const SAMPLE_STATUS = [2165, 1240, 1326, 1653, 1464];
const SAMPLE_APTITUDES = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'A', 'S'];

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

/**
 * 実機の「ウマ娘詳細」画面での検査。
 *
 * 画面はゲームの著作物なので、リポジトリには置かない（umacapture 側の
 * `labels.json` を置かないのと同じ理由）。持っている人だけが、写真を置いた
 * 場所を指して走らせる。
 *
 *   RACEEMU_REAL_SCREENSHOT_DIR=~/shots pnpm test
 *
 * その場所に `case-1.png` から `case-3.png` の名前で置く。どれがどれかは
 * 下の期待値のとおりで、docs/ocr-design.md の 7 節にも書いてある。
 * 無い番号は飛ばすので、1 枚だけ持っている人も走らせられる。
 */
const SHOT_DIR = process.env['RACEEMU_REAL_SCREENSHOT_DIR'];

interface RealCase {
  readonly file: string;
  readonly size: string;
  readonly status: readonly number[];
  readonly aptitudes: Record<string, string>;
}

const REAL_CASES: readonly RealCase[] = [
  {
    file: 'case-1.png',
    size: '608×2340',
    status: [2165, 1240, 1326, 1653, 1464],
    aptitudes: {
      turf: 'A', dirt: 'G',
      sprint: 'A', mile: 'S', middle: 'B', long: 'G',
      nige: 'F', sen: 'A', sasi: 'A', oi: 'S',
    },
  },
  {
    file: 'case-2.png',
    size: '810×2789',
    status: [2106, 884, 1702, 1264, 1602],
    aptitudes: {
      turf: 'S', dirt: 'F',
      sprint: 'A', mile: 'D', middle: 'F', long: 'G',
      nige: 'D', sen: 'S', sasi: 'D', oi: 'G',
    },
  },
  {
    file: 'case-3.png',
    size: '810×2454',
    status: [1361, 1195, 694, 1467, 1826],
    aptitudes: {
      turf: 'A', dirt: 'E',
      sprint: 'G', mile: 'A', middle: 'A', long: 'A',
      nige: 'C', sen: 'A', sasi: 'E', oi: 'G',
    },
  },
];

describe.skipIf(!available || SHOT_DIR === undefined)('実機の画面', () => {
  for (const real of REAL_CASES) {
    const path = `${SHOT_DIR}/${real.file}`;
    it.skipIf(!existsSync(path))(`${real.size} のステータスと適性をすべて当てる`, async () => {
      const reading = await readStatusHeader(readFileSync(path), engine!);
      expect(reading.status).toEqual(real.status);
      expect(reading.aptitudes).toEqual(real.aptitudes);
    });
  }
});
