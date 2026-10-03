import { describe, expect, it } from 'vitest';
import { loadGameData } from '../src/node.ts';
import { SkillResolver } from '../src/skill-resolve.ts';

const data = loadGameData();
const resolver = new SkillResolver(data.skills);

/** 名前から採ったスキルの種別。解決できなければ null。 */
function rarityOf(name: string): string | null {
  const hit = resolver.resolve(name);
  return hit.status === 'resolved' ? hit.skill.rarity : null;
}

describe('名前の揺れは正規化で消える', () => {
  it('波ダッシュと全角チルダ', () => {
    // 画像を書き起こすと 〜（波ダッシュ）になる。データは ～（全角チルダ）。
    const hit = resolver.resolve('あま〜い幻惑');
    expect(hit.status).toBe('resolved');
    if (hit.status === 'resolved') expect(hit.skill.name).toBe('あま～い幻惑');
  });

  it('涛と濤、ヘとへ', () => {
    const a = resolver.resolve('怒涛のポロロッカ');
    expect(a.status === 'resolved' && a.skill.name).toBe('怒濤のポロロッカ');
    const b = resolver.resolve('ミンナノアタシヘ！');
    expect(b.status === 'resolved' && b.skill.name).toBe('ミンナノアタシへ！');
  });

  it('丸印の書き分けは吸収するが、○ と ◎ は別のスキルのまま', () => {
    const one = resolver.resolve('右回り○');
    const two = resolver.resolve('右回り◎');
    expect(one.status === 'resolved' && two.status === 'resolved').toBe(true);
    if (one.status === 'resolved' && two.status === 'resolved') expect(one.skill.id).not.toBe(two.skill.id);
  });
});

describe('同じ名前が複数あるときの選び方', () => {
  it('他のウマ娘の固有スキルは、継承版を採る', () => {
    expect(rarityOf('Joy to the World')).toBe('inherit');
    expect(rarityOf('勝利の鼓動')).toBe('inherit');
  });

  it('自分の固有は、持ち主が合うときだけ固有として採る', () => {
    const own = resolver.resolveLineup({ chara: 'ファインモーション', unique: 'Fairy tale', skills: [] });
    expect(own.warnings).toEqual([]);
    const hit = own.entries[0]!;
    expect(hit.status).toBe('resolved');
    if (hit.status === 'resolved') {
      expect(hit.asUnique).toBe(true);
      expect(hit.skill.rarity).toBe('unique');
      expect(hit.skill.holder).toContain('ファインモーション');
    }
  });

  it('勝負服まで書いたときは、その勝負服の固有だけが当たる', () => {
    const full = resolver.resolveLineup({
      chara: '[Noble Seamair]ファインモーション',
      unique: 'Fairy tale',
      skills: [],
    });
    expect(full.warnings).toEqual([]);
    const wrong = resolver.resolveLineup({
      chara: '[違う勝負服]ファインモーション',
      unique: 'Fairy tale',
      skills: [],
    });
    // 持ち主が合わないので固有として採れない。継承版に落ちたことを警告する。
    expect(wrong.warnings.map((w) => w.code)).toContain('unique_unresolved');
  });

  it('持ち主が違う固有は、継承版に落ちて警告が付く', () => {
    const result = resolver.resolveLineup({ chara: 'エルコンドルパサー', unique: 'Fairy tale', skills: [] });
    const hit = result.entries[0]!;
    expect(hit.status === 'resolved' && hit.asUnique).toBe(false);
    expect(result.warnings.map((w) => w.code)).toContain('unique_unresolved');
  });

  it('継承版と継承進化版があるものは、継承版を採って知らせる', () => {
    // 「黄金を訪ねて」は継承版と特別な版を持つ。画像では見分けられない。
    const result = resolver.resolveLineup({ skills: ['黄金を訪ねて'] });
    const hit = result.entries[0]!;
    expect(hit.status === 'resolved' && hit.skill.rarity).toBe('inherit');
    expect(result.warnings.map((w) => w.code)).toContain('ambiguous_variant');
  });

  it('ID（数字）で直接指せる', () => {
    const special = data.skills.find((s) => s.name === '黄金を訪ねて' && s.rarity === 'special')!;
    const hit = resolver.resolve(special.id);
    expect(hit.status === 'resolved' && hit.skill.id).toBe(special.id);
  });
});

describe('解決できなかった名前は当てずに候補を返す', () => {
  it('読み違えた名前は、近い名前を候補にするだけで採らない', () => {
    const hit = resolver.resolve('送る月流星');
    expect(hit.status).toBe('unresolved');
    if (hit.status === 'unresolved') {
      expect(hit.reason).toBe('not_found');
      expect(hit.candidates[0]!.name).toBe('迸る月流星');
      expect(hit.candidates.length).toBeLessThanOrEqual(3);
    }
  });

  it('データに無いスキルも候補付きで返る（デバフ）', () => {
    const result = resolver.resolveLineup({ skills: ['先行ためらい', '王手'] });
    expect(result.unresolved.map((u) => u.input)).toEqual(['先行ためらい']);
    // 解決できたものだけが採られる。
    expect(result.skills.map((s) => s.name)).toEqual(['王手']);
  });

  it('候補は同じ名前で枠を使い切らない', () => {
    const candidates = resolver.nearest('勝利の鼓動');
    const names = candidates.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('他のウマ娘の固有で継承版が無いものは、解決できなかったものとして返る', () => {
    const onlyUnique = data.skills.find(
      (s) => s.rarity === 'unique' && !data.skills.some((o) => o.name === s.name && o.rarity !== 'unique'),
    );
    if (onlyUnique === undefined) return; // データに無ければ検査できない
    const hit = resolver.resolve(onlyUnique.name);
    expect(hit.status).toBe('unresolved');
    if (hit.status === 'unresolved') expect(hit.reason).toBe('unique_only');
  });
});

describe('点検', () => {
  it('同じスキルが 2 回あれば 1 つに畳んで警告する', () => {
    const result = resolver.resolveLineup({ skills: ['追込コーナー◎', 'ウマ好み', '追込コーナー◎'] });
    expect(result.skills.map((s) => s.name)).toEqual(['追込コーナー◎', 'ウマ好み']);
    const dup = result.warnings.filter((w) => w.code === 'duplicate');
    expect(dup).toHaveLength(1);
    expect(dup[0]!.names).toEqual(['追込コーナー◎']);
    // 入力の順は、畳む前のまま残る（画像と見比べるため）。
    expect(result.entries).toHaveLength(3);
  });

  it('同じグループのスキルを 2 つ持っていれば警告する', () => {
    const result = resolver.resolveLineup({ skills: ['右回り○', '右回り◎'] });
    const warning = result.warnings.find((w) => w.code === 'same_group');
    expect(warning).toBeDefined();
    expect(warning!.names).toEqual(['右回り○', '右回り◎']);
    // 警告にとどめて、どちらも採る。どちらが正しいかは分からない。
    expect(result.skills).toHaveLength(2);
  });

  it('普通の出走表は警告が出ない', () => {
    const result = resolver.resolveLineup({
      chara: 'エルコンドルパサー',
      unique: 'プランチャ☆ガナドール',
      skills: ['恵福バルカローレ', 'あっぱれ大盤振る舞い！', '右回り○', '根幹距離○', '円弧のマエストロ', '地固め', '王手'],
    });
    expect(result.unresolved).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.skills).toHaveLength(8);
    expect(result.skills[0]!.rarity).toBe('unique');
  });
});

describe('search', () => {
  it('完全一致を先に、続いて部分一致、最後に近い名前を返す', () => {
    expect(resolver.search('王手').every((c) => c.name === '王手')).toBe(true);
    const partial = resolver.search('マエストロ');
    expect(partial.length).toBeGreaterThan(1);
    expect(partial.every((c) => c.name.includes('マエストロ'))).toBe(true);
    // どれにも含まれない文字列は、近い名前を返す。
    expect(resolver.search('迸るげつりゅうせい').length).toBeGreaterThan(0);
  });
});
