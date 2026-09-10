import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../../packages/data/src/node.ts';
import { buildSkillIndex, NO_CHARA } from '../src/skills.ts';

const data = loadGameData();
const index = buildSkillIndex(data);

const SPE = '[スペシャルドリーマー]スペシャルウィーク';
const SUZUKA = '[サイレントイノセンス]サイレンススズカ';

/** シューティングスター。スペの固有と、その継承版。名前は同じで ID が違う。 */
const UNIQUE_SPE = '100011';
const INHERIT_SPE = '900011';
const UNIQUE_SUZUKA = '100021';
/** 夢叶える末脚。スペの進化スキル。 */
const EVO_SPE = '100101211';

/** 右回り○ と 右回りの鬼。同じグループの下位と上位。 */
const MINOR = '200012';
const MAJOR = '200014';

describe('スキルの一覧', () => {
  it('固有と進化を含まない', () => {
    const rarities = new Set(index.selectable.map((skill) => skill.rarity));
    expect(rarities.has('unique')).toBe(false);
    expect(rarities.has('evo')).toBe(false);
  });

  it('継承版の固有を引ける', () => {
    // 固有と継承版は名前が同じで、名前で畳んでいたときは片方しか出せなかった。
    const found = index.selectable.filter((skill) => skill.name === 'シューティングスター');
    expect(found.map((skill) => skill.id)).toEqual([INHERIT_SPE]);
  });

  it('名前の重なりが残っていない', () => {
    const seen = new Map<string, number>();
    for (const skill of index.selectable) seen.set(skill.name, (seen.get(skill.name) ?? 0) + 1);
    const duplicated = [...seen.entries()].filter(([, count]) => count > 1);
    // 固有を外しても 3 件だけ残る。継承版と特殊で名前が同じものである。
    expect(duplicated.length).toBe(3);
  });

  it('キャラを固有と進化の持ち主から集める', () => {
    expect(index.charas.length).toBe(266);
    expect(index.charas).toContain(SPE);
    expect(index.uniquesOf(SPE).map((s) => s.id)).toEqual([UNIQUE_SPE]);
    expect(index.evosOf(SPE).map((s) => s.name)).toContain('夢叶える末脚');
  });
});

describe('キャラの選択', () => {
  it('固有が入る', () => {
    expect(index.applyChara([], SPE)).toEqual([UNIQUE_SPE]);
  });

  it('進化は入らない。取るかどうかは本人が決める', () => {
    expect(index.applyChara([], SPE)).not.toContain(EVO_SPE);
  });

  it('前のキャラの固有と進化が外れる', () => {
    const held = index.toggle(index.applyChara([], SPE), EVO_SPE);
    expect(held).toEqual([UNIQUE_SPE, EVO_SPE]);
    expect(index.applyChara(held, SUZUKA)).toEqual([UNIQUE_SUZUKA]);
  });

  it('同じ名前の継承版が外れる', () => {
    // 自分の固有と、その継承版を同時には持てない。
    expect(index.applyChara([INHERIT_SPE], SPE)).toEqual([UNIQUE_SPE]);
  });

  it('固有と進化以外はそのまま残る', () => {
    expect(index.applyChara([MAJOR, INHERIT_SPE], SUZUKA)).toEqual([
      MAJOR,
      INHERIT_SPE,
      UNIQUE_SUZUKA,
    ]);
  });

  it('未選択に戻すと固有も進化も外れる', () => {
    expect(index.applyChara([UNIQUE_SPE, EVO_SPE, MAJOR], NO_CHARA)).toEqual([MAJOR]);
  });

  it('持っているスキルからキャラを引ける', () => {
    expect(index.charaOf([MAJOR, UNIQUE_SPE])).toBe(SPE);
    expect(index.charaOf([MAJOR, EVO_SPE])).toBe(SPE);
    expect(index.charaOf([MAJOR])).toBe(NO_CHARA);
  });
});

describe('スキルの持ち替え', () => {
  it('同じグループのものは同時に持てない', () => {
    expect(index.toggle([MINOR], MAJOR)).toEqual([MAJOR]);
    expect(index.toggle([MAJOR], MINOR)).toEqual([MINOR]);
  });

  it('固有どうしは同時に持てない', () => {
    // キャラは 1 人なので、固有も 1 つである。グループは別なので、
    // グループの規則だけでは防げない。
    expect(index.toggle([UNIQUE_SPE], UNIQUE_SUZUKA)).toEqual([UNIQUE_SUZUKA]);
  });

  it('固有と、別のスキルの継承版は同時に持てる', () => {
    expect(index.toggle([UNIQUE_SUZUKA], INHERIT_SPE)).toEqual([UNIQUE_SUZUKA, INHERIT_SPE]);
  });

  it('もう一度押すと外れる', () => {
    expect(index.toggle([MAJOR, MINOR], MAJOR)).toEqual([MINOR]);
  });
});
