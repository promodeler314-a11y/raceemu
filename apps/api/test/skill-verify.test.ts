import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../../packages/data/src/node.ts';
import { editDistance, normalizeSkillName } from '../../../packages/data/src/skill-match.ts';
import { OcrEngine } from '../src/ocr.ts';
import { classifierSkillIds } from '../src/skill-classifier.ts';
import { ReadingJudge, skillsUnknownToClassifier, SkillVerifier } from '../src/skill-verify.ts';

const data = loadGameData();

function vocabulary(classifierIds: readonly string[]) {
  const unknown = skillsUnknownToClassifier(data.skills, classifierIds);
  const unknownKeys = new Set(unknown.map((skill) => normalizeSkillName(skill.name)));
  const known = data.skills.filter((skill) => !unknownKeys.has(normalizeSkillName(skill.name)));
  return { unknown, unknownKeys, known, judge: new ReadingJudge(data.skills, classifierIds) };
}

/**
 * いま同梱しているモデルの語彙。名前での突き合わせや、読み違えで置き換わりうる
 * 組の数え上げのように、本番の語彙そのものを見る検査に使う。
 */
const live = vocabulary(classifierSkillIds());

/**
 * 判定の論理を確かめるための、2026-09-21 時点のモデル（1832 クラス）の語彙。
 *
 * 配布元は 2026-09-28 にモデルを学習し直し、先導者や急先鋒のような誰でも取れる
 * スキルをすべて覚えた。いまのモデルの語彙で判定を検査すると、語彙に無いスキルが
 * 一部の固有しか残らず、拾い直しを確かめる材料が無くなる。モデルを取り直すたびに
 * 例を差し替えることにもなる。実際、取り直しで 7 件が一度に落ちた。
 *
 * 対応表はこちらで作った ID の並びなので、検査用に固めて置いてよい
 * （docs/ocr-design.md 6.6 節）。
 * データが同じなら、モデルを取り直してもこちらの結果は変わらない。
 */
const frozen = vocabulary(
  (
    JSON.parse(readFileSync('apps/api/test/fixtures/label-map-2026-09-21.json', 'utf8')) as (string | null)[]
  ).filter((id): id is string => id !== null),
);

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

/** 語彙に有る名前と語彙に無い名前で、1 文字しか違わない組（`有る/無い`） */
function oneCharPairs(vocab: ReturnType<typeof vocabulary>): string[] {
  const knownKeys = [...new Set(vocab.known.map((skill) => normalizeSkillName(skill.name)))];
  const pairs: string[] = [];
  for (const u of vocab.unknownKeys) {
    for (const k of knownKeys) {
      if (Math.abs(u.length - k.length) > 1) continue;
      if (editDistance(u, k) === 1) pairs.push(`${k}/${u}`);
    }
  }
  return pairs.sort();
}

/**
 * 1 文字の読み違えで置き換わりうると分かったうえで、受け入れた組。
 *
 * 2026-09-21 のモデルでは 勝負師/勝負勘 があったが、09-28 の学習し直しで
 * 勝負勘 が語彙に入り、消えた。
 */
const REVIEWED_PAIRS = new Set<string>();

describe('モデルの語彙に無いスキルの洗い出し', () => {
  it('学習した時点より後のスキルは、誰でも取れるものでも取り残される', () => {
    // モデルは学習した時点のスキルしか知らない（docs/ocr-design.md 6.6 節）。
    // 2026-09-21 時点のモデルは、ふつうに使われるこれらを知らなかった。
    const names = new Set(frozen.unknown.map((skill) => skill.name));
    expect(names.has('先導者')).toBe(true);
    expect(names.has('急先鋒')).toBe(true);
    expect(names.has('レースメイカー')).toBe(true);
  });

  it('モデルが知っているスキルは入らない', () => {
    const names = new Set(live.unknown.map((skill) => skill.name));
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

    const unknownIds = new Set(live.unknown.map((skill) => skill.id));
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
 * 先頭の 7 件は、2026-09-21 時点のモデルが知らなかったスキルである。
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
    const verdict = frozen.judge.judge('先導者', STAND_IN);
    expect(verdict.kind).toBe('replace');
    if (verdict.kind === 'replace') expect(verdict.skill.name).toBe('先導者');
  });

  it('3 文字の名前を 1 文字読み違えても、分類器の答えとの差がはっきりしていれば拾う', () => {
    // 合成見本で実際に出た読み違え（鋒を鋳）。以前は 3 文字に完全一致を
    // 求めていたので捨てていた。
    const verdict = frozen.judge.judge('急先鋳', STAND_IN);
    expect(verdict.kind).toBe('replace');
    if (verdict.kind === 'replace') {
      expect(verdict.skill.name).toBe('急先鋒');
      // 1 文字違いなので一致の度合いは 1 に届かず、画面では要確認になる
      expect(verdict.score).toBeLessThan(0.9);
    }
  });

  it('2 文字の名前は 1 文字でも違えば拾わない', () => {
    // 2 文字の 1 文字違い（0.5）は、別の 2 文字の名前とも同じくらい近い
    expect(frozen.judge.judge(misread('超然', 1), STAND_IN).kind).not.toBe('replace');
  });

  it('いまの語彙で、1 文字の読み違えで語彙に無い名前になりうる組は、見たものに限る', () => {
    // 語彙に有るスキルの行を壊しうるのは、読み違えた結果が**実在する語彙に無い名前**に
    // 近づく場合だけである。どの名前にも無い文字に崩れるなら、いちばん近いのは
    // 元の名前のままで判定は動かない。1 文字違いの組は置き換えにまで届くので、
    // 見ていない組が出たら落とす。データの取り直しで増えたらここが落ちるので、
    // 組を見て REVIEWED_PAIRS に足してよいか決める（docs/ocr-design.md 6.7 節）。
    // モデルの取り直しで組が減るぶんには落とさない。
    expect(oneCharPairs(live).filter((pair) => !REVIEWED_PAIRS.has(pair))).toEqual([]);
  });

  it('1 文字の読み違えが語彙に無い名前にぴったり重なれば、置き換わる', () => {
    // 上の検査が見張っている危険の実例。2026-09-21 の語彙では 勝負師/勝負勘 が
    // その組だった。師を勘と読み違えれば、勝負勘に置き換わる。
    expect(oneCharPairs(frozen)).toContain('勝負師/勝負勘');
    expect(frozen.judge.judge('勝負勘', skillNamed('勝負師')).kind).toBe('replace');
  });

  it('語彙に有るスキルどうしの読み違えでは、答えを疑わない', () => {
    // 分類器は語彙に有るスキルをほぼ確実に当てる。◎ を ○ と読み違えた程度で
    // 正しい答えを要確認にすると、既定で選ばれなくなる。
    expect(live.judge.judge('右回り○', skillNamed('右回り◎'))).toEqual({ kind: 'keep' });
    expect(live.judge.judge('正攻法', skillNamed('末脚'))).toEqual({ kind: 'keep' });
  });

  it('語彙に有る名前を、どの名前にも無い文字に読み違えても動かない', () => {
    // 読み取りの雑音の検査。いちばん近いのが元の名前のままなので、判定は動かないはずである。
    const touched: string[] = [];
    for (const skill of live.known) {
      const text = misread(skill.name, 0);
      if (live.judge.judge(text, skill).kind !== 'keep') touched.push(`${skill.name} ← ${text}`);
    }
    expect(touched).toEqual([]);
  });

  it('語彙に無い名前を 1 文字読み違えたとき、別の名前には置き換えない', () => {
    // **取りこぼしより誤りのほうが重い。** 拾えなくてもよいが、拾うなら正しく。
    // 語彙に無いスキルが多いほうが確かめになるので、固めた語彙で見る。
    let picked = 0;
    let tried = 0;
    for (const skill of frozen.unknown) {
      const length = [...skill.name].length;
      for (let i = 0; i < length; i++) {
        tried++;
        const verdict = frozen.judge.judge(misread(skill.name, i), STAND_IN);
        if (verdict.kind !== 'replace') continue;
        expect(normalizeSkillName(verdict.skill.name)).toBe(normalizeSkillName(skill.name));
        picked++;
      }
    }
    // 取りこぼすのは 2 文字の名前くらいである
    expect(picked / tried).toBeGreaterThan(0.9);
  });

  it('語彙に無い名前らしいが紛らわしければ、要確認にする', () => {
    // 「勝負□」は 勝負師（語彙に有る）と 勝負勘（語彙に無い）のちょうど中間にある
    const verdict = frozen.judge.judge(misread('勝負勘', 2), STAND_IN);
    expect(verdict.kind).toBe('doubt');
    if (verdict.kind === 'doubt') {
      expect(verdict.skill.name).toBe('勝負勘');
      expect(verdict.margin).toBe(0);
    }
    // 分類器が 勝負師 と答えていれば、読めた文字はそれと矛盾しないので疑わない
    expect(frozen.judge.judge(misread('勝負勘', 2), skillNamed('勝負師'))).toEqual({ kind: 'keep' });
  });

  it('読めなかった行、崩れて何も指さない行には手を出さない', () => {
    expect(frozen.judge.judge('', STAND_IN)).toEqual({ kind: 'keep' });
    // 丸いアイコンと装飾つきの背景に壊された読み（docs/ocr-design.md 5.1 節）
    expect(frozen.judge.judge('( mo ロ ラ ェ ッ ッ ー', STAND_IN)).toEqual({ kind: 'keep' });
  });

  it('分類器の答えが無い行は、既知のスキルに読めても足さない', () => {
    // 確信度が低い行は、ふつう一覧の末尾の空欄である。
    expect(frozen.judge.judge('正攻法', null)).toEqual({ kind: 'keep' });
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
      const readings = await new SkillVerifier(ocr, frozen.judge).read(image, rows);
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
      const verifier = new SkillVerifier(ocr, frozen.judge);
      const readings = await verifier.read(image, [
        { crop: { left: 0, top: 100_000, width: ROW_WIDTH, height: ROW_HEIGHT }, predicted: STAND_IN },
      ]);
      expect(readings).toEqual([{ text: '', verdict: { kind: 'keep' } }]);
    } finally {
      await ocr.dispose();
    }
  });
});
