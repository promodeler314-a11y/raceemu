import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../../packages/data/src/node.ts';
import { normalizeSkillName } from '../../../packages/data/src/skill-match.ts';
import { OcrEngine } from '../src/ocr.ts';
import { classifierSkillIds } from '../src/skill-classifier.ts';
import { ReadingJudge, skillsUnknownToClassifier, SkillVerifier } from '../src/skill-verify.ts';

const data = loadGameData();
const unknown = skillsUnknownToClassifier(data.skills, classifierSkillIds());
const unknownKeys = new Set(unknown.map((skill) => normalizeSkillName(skill.name)));
const known = data.skills.filter((skill) => !unknownKeys.has(normalizeSkillName(skill.name)));
const judge = new ReadingJudge(data.skills, classifierSkillIds());

function skillNamed(name: string) {
  const skill = data.skills.find((candidate) => candidate.name === name);
  if (skill === undefined) throw new Error(`${name} がデータに無い`);
  return skill;
}

/** 分類器が語彙に無いスキルの代わりに返した、いちばん近い既知のスキルの役 */
const STAND_IN = skillNamed('弧線のプロフェッサー');

/** i 文字目を、どの名前にも無い文字に読み違えた形 */
function misread(name: string, ...indices: number[]): string {
  return [...name].map((char, i) => (indices.includes(i) ? '□' : char)).join('');
}

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

describe('読めた文字と分類器の答えの突き合わせ', () => {
  // 帯を読まずに判定だけを見る。学習データが無くても走る。

  it('語彙に無いスキルは、読めた文字が名前どおりなら置き換える', () => {
    const verdict = judge.judge('先導者', STAND_IN);
    expect(verdict.kind).toBe('replace');
    if (verdict.kind === 'replace') expect(verdict.skill.name).toBe('先導者');
  });

  it('3 文字の名前を 1 文字読み違えても、分類器の答えとの差がはっきりしていれば拾う', () => {
    // 合成見本で実際に出た読み違え（鋒を鋳）。以前は 3 文字に完全一致を
    // 求めていたので捨てていた。
    const verdict = judge.judge('急先鋳', STAND_IN);
    expect(verdict.kind).toBe('replace');
    if (verdict.kind === 'replace') {
      expect(verdict.skill.name).toBe('急先鋒');
      // 1 文字違いなので一致の度合いは 1 に届かず、画面では要確認になる
      expect(verdict.score).toBeLessThan(0.9);
    }
  });

  it('2 文字の名前は 1 文字でも違えば拾わない', () => {
    // 2 文字の 1 文字違い（0.5）は、別の 2 文字の名前とも同じくらい近い
    expect(judge.judge(misread('超然', 1), STAND_IN).kind).not.toBe('replace');
  });

  it('語彙に有る名前は、どこを 1 文字読み違えても置き換えも要確認もしない', () => {
    // 分類器は語彙に有るスキルをほぼ確実に当てる。文字認識の読み違えで
    // 正しい答えを壊すのが、いちばん避けたい誤りである。
    const touched: string[] = [];
    for (const skill of known) {
      const length = [...skill.name].length;
      for (let i = 0; i < length; i++) {
        const text = misread(skill.name, i);
        if (judge.judge(text, skill).kind !== 'keep') touched.push(`${skill.name} ← ${text}`);
      }
    }
    expect(touched).toEqual([]);
  });

  it('語彙に有る名前は、2 文字読み違えても置き換えない', () => {
    // 総当たりすると 1 万通りを超えて重いので、名前ごとに 1 か所だけ崩す。
    // 位置を変えて総当たりしても置き換えが 0 件なのは、手元で確かめてある。
    const replaced: string[] = [];
    for (const skill of known) {
      const length = [...skill.name].length;
      if (length < 4) continue;
      const i = Math.floor((length - 3) / 2);
      const text = misread(skill.name, i, i + 2);
      if (judge.judge(text, skill).kind === 'replace') replaced.push(`${skill.name} ← ${text}`);
    }
    expect(replaced).toEqual([]);
  });

  it('語彙に無い名前を 1 文字読み違えたとき、別の名前には置き換えない', () => {
    // **取りこぼしより誤りのほうが重い。** 拾えなくてもよいが、拾うなら正しく。
    let picked = 0;
    let tried = 0;
    for (const skill of unknown) {
      const length = [...skill.name].length;
      for (let i = 0; i < length; i++) {
        tried++;
        const verdict = judge.judge(misread(skill.name, i), STAND_IN);
        if (verdict.kind !== 'replace') continue;
        expect(normalizeSkillName(verdict.skill.name)).toBe(normalizeSkillName(skill.name));
        picked++;
      }
    }
    // 取りこぼすのは 2 文字の名前くらいである
    expect(picked / tried).toBeGreaterThan(0.9);
  });

  it('読めた文字が別の既知のスキルをはっきり指していれば、答えはそのままに要確認にする', () => {
    const verdict = judge.judge('正攻法', skillNamed('末脚'));
    expect(verdict.kind).toBe('doubt');
    if (verdict.kind === 'doubt') expect(verdict.candidate.name).toBe('正攻法');
  });

  it('読めなかった行、崩れて何も指さない行には手を出さない', () => {
    expect(judge.judge('', STAND_IN)).toEqual({ kind: 'keep' });
    // 丸いアイコンと装飾つきの背景に壊された読み（docs/ocr-design.md 5.1 節）
    expect(judge.judge('( mo ロ ラ ェ ッ ッ ー', STAND_IN)).toEqual({ kind: 'keep' });
  });

  it('分類器の答えが無い行は、既知のスキルに読めても足さない', () => {
    // 確信度が低い行は、ふつう一覧の末尾の空欄である。
    expect(judge.judge('正攻法', null)).toEqual({ kind: 'keep' });
  });
});

describe.skipIf(!available)('帯ごとの裏取り', () => {
  const image = readFileSync('apps/api/test/fixtures/unknown-skill-rows.png');
  const crops = SAMPLE.map((_, i) => ({
    left: 0,
    top: i * ROW_HEIGHT,
    width: ROW_WIDTH,
    height: ROW_HEIGHT,
  }));
  // 語彙に無い 7 件には、分類器が代わりに返す既知のスキルを置く。
  // 語彙に有る 2 件は分類器が正しく当てた想定にする。
  const rows = crops.map((crop, i) => ({
    crop,
    predicted: i < 7 ? STAND_IN : skillNamed(SAMPLE[i]!),
  }));

  it('語彙に無いスキルを拾い、語彙に有るスキルには手を出さない', async () => {
    const ocr = new OcrEngine({ tessdataPath: TESSDATA });
    try {
      const readings = await new SkillVerifier(ocr, judge).read(image, rows);
      const picked = readings.map((reading) =>
        reading.verdict.kind === 'replace' ? reading.verdict.skill.name : null,
      );

      // 語彙に有る 2 件（末脚・正攻法）は分類器の答えのまま。要確認も付けない。
      expect(readings.slice(7).map((reading) => reading.verdict)).toEqual([{ kind: 'keep' }, { kind: 'keep' }]);

      // 拾ったものが間違っていないこと。**取りこぼしより誤りのほうが重い。**
      for (const [index, name] of picked.entries()) {
        if (name !== null) expect(name).toBe(SAMPLE[index]);
      }

      // 語彙に無い 7 件をすべて拾う。「急先鋒」は鋒を鋳と読み違えるが、
      // 分類器の答えとの差がはっきりしているので拾える。
      expect(picked.slice(0, 7)).toEqual(SAMPLE.slice(0, 7));
    } finally {
      await ocr.dispose();
    }
  });

  it('画像からはみ出す帯は、黙って諦める', async () => {
    const ocr = new OcrEngine({ tessdataPath: TESSDATA });
    try {
      const verifier = new SkillVerifier(ocr, judge);
      const readings = await verifier.read(image, [
        { crop: { left: 0, top: 100_000, width: ROW_WIDTH, height: ROW_HEIGHT }, predicted: STAND_IN },
      ]);
      expect(readings).toEqual([{ text: '', verdict: { kind: 'keep' } }]);
    } finally {
      await ocr.dispose();
    }
  });
});
