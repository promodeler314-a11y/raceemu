import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../../packages/data/src/node.ts';
import { buildSkillIndex } from '../src/skills.ts';
import { buildTransferIndex, formatTransfer, parseTransfer } from '../src/transfer.ts';
import type { UmaStatus } from '../../../packages/sim/src/setting.ts';

const data = loadGameData();
const skillIndex = buildSkillIndex(data);
const index = buildTransferIndex(data, skillIndex);

const SPE = '[スペシャルドリーマー]スペシャルウィーク';

const uma: UmaStatus = {
  charaName: SPE,
  speed: 1200,
  stamina: 1000,
  power: 900,
  guts: 600,
  wisdom: 800,
  condition: 'BEST',
  style: 'SEN',
  distanceFit: 'A',
  surfaceFit: 'B',
  styleFit: 'S',
  popularity: 1,
  gateNumber: 5,
  uniqueLevel: 6,
};

describe('本家の設定文字列を読む', () => {
  it('キャラ名、ステータス 5 つ、適性 3 つ、スキル名を拾う', () => {
    const parsed = parseTransfer(
      'スペシャルウィーク,1200,1000,900,600,800,A,B,S,弧線のプロフェッサー,円弧のマエストロ',
      index,
    );
    expect(parsed.charaName).toBe(SPE);
    expect(parsed.status).toEqual({ speed: 1200, stamina: 1000, power: 900, guts: 600, wisdom: 800 });
    expect(parsed.fits).toEqual({ distanceFit: 'A', surfaceFit: 'B', styleFit: 'S' });
    expect(parsed.skillIds).toHaveLength(2);
    expect(parsed.unknown).toEqual([]);
  });

  it('区切りは改行、タブ、コロン、スラッシュでもよい', () => {
    const text = 'スペシャルウィーク\n1200\t1000:900/600\r\n800,A,B,S';
    const parsed = parseTransfer(text, index);
    expect(parsed.charaName).toBe(SPE);
    expect(parsed.status.wisdom).toBe(800);
    expect(parsed.fits.styleFit).toBe('S');
  });

  it('勝負服名まで書いてあっても引ける', () => {
    expect(parseTransfer(SPE, index).charaName).toBe(SPE);
  });

  it('書いていない項目は持たない', () => {
    const parsed = parseTransfer('1200,1000', index);
    expect(parsed.status).toEqual({ speed: 1200, stamina: 1000 });
    expect(parsed.fits).toEqual({});
    expect(parsed.charaName).toBeNull();
  });

  it('引き当てられなかった語を返す', () => {
    const parsed = parseTransfer('1200,そんなスキルは無い,円弧のマエストロ', index);
    expect(parsed.skillIds).toHaveLength(1);
    expect(parsed.unknown).toEqual(['そんなスキルは無い']);
  });

  it('ステータスが 6 つ以上あっても入れる先の無いぶんは読めなかった語にする', () => {
    const parsed = parseTransfer('1,2,3,4,5,6', index);
    expect(parsed.status.wisdom).toBe(5);
    expect(parsed.unknown).toEqual(['6']);
  });

  it('同じスキルを 2 回書いても 1 つになる', () => {
    const parsed = parseTransfer('円弧のマエストロ,円弧のマエストロ', index);
    expect(parsed.skillIds).toHaveLength(1);
  });

  it('固有の名前は継承版に落ちる。固有はキャラ名のほうが運ぶ', () => {
    // シューティングスターはスペの固有で、同じ名前の継承版がある。
    const parsed = parseTransfer('シューティングスター', index);
    expect(parsed.skillIds).toHaveLength(1);
    const skill = data.skillsById.get(parsed.skillIds[0]!);
    expect(skill?.rarity).toBe('inherit');
  });
});

describe('本家の設定文字列を書く', () => {
  it('キャラ名、ステータス、適性、スキル名をカンマで並べる', () => {
    const ids = ['弧線のプロフェッサー', '円弧のマエストロ'].map(
      (name) => skillIndex.selectable.find((s) => s.name === name)!.id,
    );
    expect(formatTransfer(uma, ids, index)).toBe(
      `${SPE},1200,1000,900,600,800,A,B,S,弧線のプロフェッサー,円弧のマエストロ`,
    );
  });

  it('固有と進化は出さない。読み直したときに継承版に化けるのを避ける', () => {
    const unique = skillIndex.uniquesOf(SPE)[0]!;
    const evo = skillIndex.evosOf(SPE)[0];
    const ids = [unique.id, ...(evo === undefined ? [] : [evo.id])];
    const text = formatTransfer(uma, ids, index);
    expect(text).not.toContain(unique.name);
    expect(text.split(',')).toHaveLength(9);
  });

  it('キャラ未選択なら名前の欄を空けない', () => {
    const text = formatTransfer({ ...uma, charaName: '' }, [], index);
    expect(text).toBe('1200,1000,900,600,800,A,B,S');
  });

  it('書いたものをそのまま読み直せる', () => {
    const ids = [skillIndex.selectable.find((s) => s.name === '円弧のマエストロ')!.id];
    const parsed = parseTransfer(formatTransfer(uma, ids, index), index);
    expect(parsed.charaName).toBe(uma.charaName);
    expect(parsed.status).toEqual({
      speed: uma.speed,
      stamina: uma.stamina,
      power: uma.power,
      guts: uma.guts,
      wisdom: uma.wisdom,
    });
    expect(parsed.fits).toEqual({
      distanceFit: uma.distanceFit,
      surfaceFit: uma.surfaceFit,
      styleFit: uma.styleFit,
    });
    expect(parsed.skillIds).toEqual(ids);
    expect(parsed.unknown).toEqual([]);
  });
});
