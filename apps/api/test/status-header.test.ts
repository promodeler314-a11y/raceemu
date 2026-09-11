import { describe, expect, it } from 'vitest';
import {
  APTITUDE_KEYS,
  APTITUDE_RECTS,
  detectContentRect,
  fitsInside,
  STATUS_RECTS,
  toPixelRect,
} from '../src/status-header.ts';

/**
 * 切り出しの座標だけを見る（画像も読み取りも要らない）。
 *
 * 割合そのものの正しさは、ここでは測れない。umacapture の設定から写した値で
 * あり、答え合わせは実機の写真でしかできない。ここで見るのは、その割合を
 * 画素に直す計算（**縦も横幅で割る**）と、はみ出しの判定である。
 */

describe('切り出しの座標', () => {
  it('縦も横幅で割る', () => {
    // 縦横比の違う 2 枚で、同じ割合が同じ画素に落ちる。縦を高さで割っていたら
    // ここがずれる。
    const wide = toPixelRect(STATUS_RECTS[0]!, { left: 0, top: 0, width: 1080, height: 1920 });
    const tall = toPixelRect(STATUS_RECTS[0]!, { left: 0, top: 0, width: 1080, height: 2400 });
    expect(wide).toEqual(tall);
  });

  it('内容領域の左上ぶんだけずれる', () => {
    const base = toPixelRect(STATUS_RECTS[0]!, { left: 0, top: 0, width: 1000, height: 2000 });
    const moved = toPixelRect(STATUS_RECTS[0]!, { left: 40, top: 100, width: 1000, height: 2000 });
    expect(moved.left - base.left).toBe(40);
    expect(moved.top - base.top).toBe(100);
    expect(moved.width).toBe(base.width);
  });

  it('ステータスは横に 5 つ並ぶ', () => {
    const content = { left: 0, top: 0, width: 1080, height: 2400 };
    const rects = STATUS_RECTS.map((r) => toPixelRect(r, content));
    expect(rects).toHaveLength(5);
    for (let i = 1; i < rects.length; i++) {
      expect(rects[i]!.top).toBe(rects[0]!.top);
      expect(rects[i]!.left).toBeGreaterThan(rects[i - 1]!.left + rects[i - 1]!.width);
    }
  });

  it('適性は 2・4・4 の 3 段に並ぶ', () => {
    const content = { left: 0, top: 0, width: 1080, height: 2400 };
    const rects = APTITUDE_RECTS.map((r) => toPixelRect(r, content));
    expect(rects).toHaveLength(APTITUDE_KEYS.length);
    const rows = new Map<number, number>();
    for (const rect of rects) rows.set(rect.top, (rows.get(rect.top) ?? 0) + 1);
    expect([...rows.values()]).toEqual([2, 4, 4]);
  });

  it('上半分が写っていない画像でははみ出す', () => {
    // スキル一覧だけを切り抜いた画像（縦が短い）を渡された場合。
    const content = { left: 0, top: 0, width: 620, height: 300 };
    const rects = [...STATUS_RECTS, ...APTITUDE_RECTS].map((r) => toPixelRect(r, content));
    expect(rects.every((rect) => fitsInside(rect, 620, 300))).toBe(false);
  });
});

describe('内容領域', () => {
  /** 一様な色で埋めた画像を作る。`fill` は上下に足す黒帯の高さ。 */
  function image(width: number, height: number, tone: number, band: number) {
    const pixels = new Uint8Array(width * height * 3).fill(tone);
    for (let y = 0; y < band; y++) {
      for (let x = 0; x < width * 3; x++) {
        pixels[y * width * 3 + x] = 0;
        pixels[(height - 1 - y) * width * 3 + x] = 0;
      }
    }
    return pixels;
  }

  it('黒帯を落とす', () => {
    const content = detectContentRect(image(100, 200, 180, 20), 100, 200, 3);
    expect(content).toEqual({ left: 0, top: 20, width: 100, height: 160 });
  });

  it('淡い背景は落とさない', () => {
    // この画面の背景はクリーム色で、明るく一様である。明るい行も縁とみなして
    // いたときは、画面全部を削り落としていた。
    const content = detectContentRect(image(100, 200, 240, 0), 100, 200, 3);
    expect(content).toEqual({ left: 0, top: 0, width: 100, height: 200 });
  });
});
