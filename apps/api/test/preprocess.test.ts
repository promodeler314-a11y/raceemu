import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { preprocessForOcr } from '../src/preprocess.ts';

describe('OCR 前処理', () => {
  it('グレースケールの二値画像を返す', async () => {
    const image = readFileSync('apps/api/test/fixtures/skill-list.png');
    const processed = await preprocessForOcr(image);
    const meta = await sharp(processed).metadata();
    expect(meta.format).toBe('png');

    // 二値化されているので、ピクセル値は 0 か 255 の 2 種類しか出ない
    const { data } = await sharp(processed).raw().toBuffer({ resolveWithObject: true });
    const values = new Set(data);
    expect([...values].sort((a, b) => a - b)).toEqual([0, 255]);
  });

  it('閾値を変えると結果が変わる', async () => {
    const image = readFileSync('apps/api/test/fixtures/skill-list.png');
    const low = await preprocessForOcr(image, { threshold: 10 });
    const high = await preprocessForOcr(image, { threshold: 245 });
    // 閾値がほぼ 0 なら大半が白、ほぼ 255 なら大半が黒になる
    const whiteRatio = async (buf: Buffer) => {
      const { data } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
      let white = 0;
      for (const v of data) if (v === 255) white++;
      return white / data.length;
    };
    expect(await whiteRatio(low)).toBeGreaterThan(await whiteRatio(high));
  });

  it('壊れた画像なら失敗する（呼び出し側が無加工にフォールバックする前提）', async () => {
    await expect(preprocessForOcr(Buffer.from('これは画像ではない'))).rejects.toThrow();
  });
});
