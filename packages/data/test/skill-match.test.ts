import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/node.ts';
import { editDistance, normalizeSkillName, SkillMatcher } from '../src/skill-match.ts';

const data = loadGameData();
const matcher = new SkillMatcher(data.skills);
const nameOf = (line: string) => matcher.match(line)?.skill.name ?? null;

describe('読み取った名前の正規化', () => {
  it('丸印の書き分けを 1 つに寄せる', () => {
    expect(normalizeSkillName('中距離コーナー〇')).toBe(normalizeSkillName('中距離コーナー○'));
    expect(normalizeSkillName('中距離コーナー◯')).toBe(normalizeSkillName('中距離コーナー○'));
  });

  it('文字のあいだの空白を落とす', () => {
    // 標準のモデルは 1 文字ずつ空けて返してくる
    expect(normalizeSkillName('弧 線 の プ ロ フ ェ ッ サ ー')).toBe(
      normalizeSkillName('弧線のプロフェッサー'),
    );
  });

  it('長音と横棒と漢数字の一を寄せる', () => {
    expect(normalizeSkillName('コーナー')).toBe(normalizeSkillName('コ－ナ—'));
    // 読み取りでこの 2 つは入れ替わる。名前 2106 件でこう寄せても衝突しない。
    expect(normalizeSkillName('ー匹狼')).toBe(normalizeSkillName('一匹狼'));
  });
});

describe('編集距離', () => {
  it('同じなら 0、1 文字違えば 1', () => {
    expect(editDistance('一匹狼', '一匹狼')).toBe(0);
    expect(editDistance('ー忠狼', '一匹狼')).toBe(2);
    expect(editDistance('', 'あい')).toBe(2);
  });
});

describe('スキルの引き当て', () => {
  it('そのままの名前が引ける', () => {
    expect(nameOf('弧線のプロフェッサー')).toBe('弧線のプロフェッサー');
    expect(nameOf('スリップストリーム')).toBe('スリップストリーム');
  });

  it('実際に読み取れた崩れ方が引ける', () => {
    // tessdata の標準モデルが返した形をそのまま入れる
    expect(nameOf('中 距 離 コ ー ナ ー 〇')).toBe('中距離コーナー○');
    expect(nameOf('弧 線 の プ ロ フ ェ ッ サ ー')).toBe('弧線のプロフェッサー');
    expect(nameOf('好 転 一 息')).toBe('好転一息');
    expect(nameOf('一 匹 狼')).toBe('一匹狼');
  });

  it('関係のない文字列は拾わない', () => {
    expect(nameOf('スキル')).toBe(null);
    expect(nameOf('所持スキル一覧を表示する')).toBe(null);
    expect(nameOf('12345')).toBe(null);
  });

  it('短い名前には厳しい一致を求める', () => {
    // 3 文字は 1 文字違うだけで別のスキルと同じくらい近くなる
    // 「ー忠狼」は正規化しても 1 文字違い（score 0.67）で残る
    const loose = new SkillMatcher(data.skills, { minScore: 0.5, shortNameMinScore: 0.5 });
    const strict = new SkillMatcher(data.skills);
    expect(loose.match('ー忠狼')?.skill.name).toBe('一匹狼');
    expect(strict.match('ー忠狼')).toBe(null);
  });

  it('紛らわしい一致には 2 番目の候補が付く', () => {
    const found = matcher.match('中 距 離 直 線 〇');
    expect(found?.skill.name).toBe('中距離直線○');
    expect(found?.runnerUp).not.toBe(null);
    expect(found?.margin).toBeGreaterThan(0);
  });

  it('全文から拾い、同じスキルは 1 度だけ返す', () => {
    const text = [
      'スキル一覧',
      '弧 線 の プ ロ フ ェ ッ サ ー',
      '円 弧 の マ エ ス ト ロ',
      '中 距 離 コ ー ナ ー 〇',
      '一 匹 狼',
      '一 匹 狼',
      '好 転 一 息',
      '正 攻 法',
      '真 骨 頂',
      'ス リ ッ プ ス ト リ ー ム',
    ].join('\n');
    const found = matcher.matchAll(text);
    const names = found.map((m) => m.skill.name).sort();
    expect(names).toEqual(
      ['一匹狼', '中距離コーナー○', '円弧のマエストロ', '好転一息', '弧線のプロフェッサー', '正攻法', '真骨頂', 'スリップストリーム'].sort(),
    );
    expect(new Set(found.map((m) => m.skill.id)).size).toBe(found.length);
  });
});
