import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../../packages/data/src/node.ts';
import { normalizeSkillName } from '../../../packages/data/src/skill-match.ts';
import { OcrEngine } from '../src/ocr.ts';
import { classifierSkillIds } from '../src/skill-classifier.ts';
import { skillsUnknownToClassifier, SkillVerifier } from '../src/skill-verify.ts';

const data = loadGameData();
const unknown = skillsUnknownToClassifier(data.skills, classifierSkillIds());

describe('モデルの語彙に無いスキルの洗い出し', () => {
  it('誰でも取れるスキルが取り残されている', () => {
    // モデルは学習した時点のスキルしか知らない。配布元が配っているものが
    // 既に手元のものと同じなので、取り直しても埋まらない差である
    // （docs/ocr-design.md 6.6 節）。数はデータの更新で増えうる。
    const names = new Set(unknown.map((skill) => skill.name));
    expect(names.has('先導者')).toBe(true);
    expect(names.has('急先鋒')).toBe(true);
    expect(names.has('レースメイカー')).toBe(true);
  });

  it('モデルが知っているスキルは入らない', () => {
    const names = new Set(unknown.map((skill) => skill.name));
    expect(names.has('末脚')).toBe(false);
    expect(names.has('正攻法')).toBe(false);
    expect(names.has('弧線のプロフェッサー')).toBe(false);
  });

  it('名前で突き合わせる。継承版しか対応表に無い固有を取りこぼさない', () => {
    // 対応表は名前が同じものの片方（継承版、ID が "9" 始まり）しか指さない。
    // ID で突き合わせると、モデルが見た目を知っている固有まで
    // 「知らない」側に落ちてしまう。
    const mapped = new Set(classifierSkillIds());
    const byName = new Map<string, string[]>();
    for (const skill of data.skills) {
      const key = normalizeSkillName(skill.name);
      byName.set(key, [...(byName.get(key) ?? []), skill.id]);
    }
    const pairedButUnmapped = [...byName.values()].filter(
      (ids) => ids.length > 1 && ids.some((id) => mapped.has(id)) && ids.some((id) => !mapped.has(id)),
    );
    expect(pairedButUnmapped.length).toBeGreaterThan(0);

    const unknownIds = new Set(unknown.map((skill) => skill.id));
    for (const ids of pairedButUnmapped) {
      for (const id of ids) expect(unknownIds.has(id)).toBe(false);
    }
  });
});

const TESSDATA = process.env['TESSDATA_PATH'] ?? '.tessdata';
const available = existsSync(`${TESSDATA}/jpn.traineddata`);

/**
 * 見本は本物の画面ではなく、スキル名を並べただけの絵である
 * （`scripts/render-unknown-skill-sample.mjs`）。ここで確かめられるのは、
 * 帯を 1 つずつ切り出して読む道筋が通っていることと、モデルの語彙に有る名前を
 * 誤って拾い直さないことだけである。実機での精度はこれでは測れない。
 */
const ROW_WIDTH = 400;
const ROW_HEIGHT = 40;
const SAMPLE = [
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

describe.skipIf(!available)('帯ごとの裏取り', () => {
  const image = readFileSync('apps/api/test/fixtures/unknown-skill-rows.png');
  const crops = SAMPLE.map((_, i) => ({
    left: 0,
    top: i * ROW_HEIGHT,
    width: ROW_WIDTH,
    height: ROW_HEIGHT,
  }));

  it('語彙に無いスキルを拾い、語彙に有るスキルには手を出さない', async () => {
    const ocr = new OcrEngine({ tessdataPath: TESSDATA });
    try {
      const readings = await new SkillVerifier(ocr, unknown).read(image, crops);
      const picked = readings.map((reading) => reading.skill?.name ?? null);

      // 語彙に有る 2 件（末脚・正攻法）は拾わない。読めていても手を出さない。
      expect(picked.slice(7)).toEqual([null, null]);

      // 拾ったものが間違っていないこと。**取りこぼしより誤りのほうが重い。**
      for (const [index, name] of picked.entries()) {
        if (name !== null) expect(name).toBe(SAMPLE[index]);
      }

      // 語彙に無い 7 件のうち 6 件を拾う。落ちるのは「急先鋒」で、鋒を鋳と読み違える。
      // 3 文字の名前には完全一致を要求しているので、1 文字違えば捨てられる
      // （`SHORT_NAME_MIN_SCORE`）。緩めれば拾えるが、別の 3 文字の名前を
      // 誤って拾う危険と引き換えになる。
      expect(picked.filter((name) => name !== null).length).toBe(6);
      expect(picked[1]).toBeNull();
    } finally {
      await ocr.dispose();
    }
  });

  it('画像からはみ出す帯は、黙って諦める', async () => {
    const ocr = new OcrEngine({ tessdataPath: TESSDATA });
    try {
      const verifier = new SkillVerifier(ocr, unknown);
      const readings = await verifier.read(image, [
        { left: 0, top: 100_000, width: ROW_WIDTH, height: ROW_HEIGHT },
      ]);
      expect(readings).toEqual([{ text: '', skill: null, score: 0 }]);
    } finally {
      await ocr.dispose();
    }
  });
});
