import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SkillClassifier } from '../src/skill-classifier.ts';

/**
 * 実機の「ウマ娘詳細」画面での精度は、この場にコミットしていない実物の写真で
 * 手作業により確かめた（docs/ocr-design.md 6 節）。ここで検査できるのは、
 * その形をしていない画像で誤って行を捏造しないことと、壊れた画像で
 * 例外を投げることだけである。
 */
describe('スキル分類', () => {
  it('「ウマ娘詳細」画面の形をしていない画像では、行を見つけない', async () => {
    const image = readFileSync('apps/api/test/fixtures/skill-list.png');
    const classifier = new SkillClassifier();
    const found = await classifier.recognize(image);
    expect(found).toEqual([]);
  });

  it('壊れた画像なら失敗する（呼び出し側が文字認識にフォールバックする前提）', async () => {
    const classifier = new SkillClassifier();
    await expect(classifier.recognize(Buffer.from('これは画像ではない'))).rejects.toThrow();
  });
});

describe('番号→スキル ID の対応表', () => {
  it('1832 件ぶんあり、大半がうちのスキルに対応付いている', () => {
    const map: readonly (string | null)[] = JSON.parse(
      readFileSync('apps/api/assets/skill-classifier/label-map.json', 'utf8'),
    );
    expect(map.length).toBe(1832);
    const matched = map.filter((id) => id !== null).length;
    // 対応が無いのは対戦相手にしか掛からない debuff など（57 件）。
    // scripts/build-skill-classifier-labels.ts の出力を参照。
    expect(matched).toBeGreaterThan(1700);
  });
});
