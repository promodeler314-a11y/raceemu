import { describe, expect, it } from 'vitest';
import { loadGameData } from '../../data/src/node.ts';
import { createCostModel, dedupeByGroup } from '../src/cost.ts';

const data = loadGameData();

/** 光れ！弾けろ！超新星爆発！：継承版（901411）を買って進化させる。 */
const EVO = '91101411';
const INHERIT = '901411';

describe('継承進化の費用', () => {
  it('データ上は、継承進化に sp が無く、同じグループの継承版に sp がある（前提）', () => {
    const evo = data.skillsById.get(EVO)!;
    const inherit = data.skillsById.get(INHERIT)!;
    expect(evo.rarity).toBe('special');
    expect(evo.sp).toBe(0);
    expect(inherit.rarity).toBe('inherit');
    expect(inherit.sp).toBeGreaterThan(0);
    expect(evo.group).toBe(inherit.group);
  });

  it('継承進化は、同じグループの継承版の値段で数える', () => {
    const model = createCostModel(data.skillsById);
    expect(model.cost(INHERIT)).toBe(200);
    expect(model.cost(EVO)).toBe(model.cost(INHERIT));
  });

  it('ヒントレベルは継承進化自身の ID に指定があればそれを使う', () => {
    // Lv2 は 0.8 倍（本家の係数表は 1.0、0.9、0.8、0.7、0.65、0.6）で、200 が 160 になる。
    const model = createCostModel(data.skillsById, { hintLevels: { [EVO]: 2 } });
    expect(model.cost(EVO)).toBe(160);
    // 継承進化のヒントを継承版へは移さない（買うのは継承版で、進化の側に付けた指定は進化の値段だけを決める）。
    expect(model.cost(INHERIT)).toBe(200);
  });

  it('継承進化自身の指定が無ければ、継承版のヒントレベルを使う', () => {
    // ヒントは買える側（継承版）に付く。進化にポイントはかからないので、同じ値段になる。
    const other = createCostModel(data.skillsById, { hintLevels: { [INHERIT]: 2 } });
    expect(other.cost(INHERIT)).toBe(160);
    expect(other.cost(EVO)).toBe(160);
    // 継承版に継承進化を足しても、総額は増えない。
    expect(other.totalCost([INHERIT])).toBe(160);
    expect(other.totalCost([INHERIT, EVO])).toBe(160);
    expect(other.totalCost([EVO])).toBe(160);
  });

  it('継承進化自身の指定があるときは、継承版の指定より優先する', () => {
    const both = createCostModel(data.skillsById, { hintLevels: { [INHERIT]: 2, [EVO]: 4 } });
    expect(both.cost(INHERIT)).toBe(160);
    expect(both.cost(EVO)).toBe(130); // Lv4 は 0.65 倍
  });

  it('継承版と継承進化を両方挙げても、総額は 1 つぶんになる', () => {
    const model = createCostModel(data.skillsById);
    expect(model.group(EVO)).toBe(model.group(INHERIT));
    expect(model.totalCost([INHERIT, EVO])).toBe(200);
    expect(model.totalCost([EVO, INHERIT])).toBe(200);
    expect(model.totalCost([EVO])).toBe(200);
    expect(dedupeByGroup([INHERIT, EVO], model)).toHaveLength(1);
  });

  it('継承版が見つからない継承進化は 0 のまま', () => {
    const model = createCostModel(data.skillsById);
    const inheritGroups = new Set(
      data.skills.filter((s) => s.rarity === 'inherit').map((s) => s.group),
    );
    const orphans = data.skills.filter((s) => s.rarity === 'special' && !inheritGroups.has(s.group));
    // 継承版を持つ継承進化は一部だけで、大半は持たない。
    expect(orphans.length).toBeGreaterThan(0);
    for (const skill of orphans) expect(model.cost(skill.id)).toBe(0);
  });

  it('継承進化以外の sp が無いスキル（固有）は 0 のまま', () => {
    const model = createCostModel(data.skillsById);
    const unique = data.skillsById.get('101411')!;
    expect(unique.rarity).toBe('unique');
    // 同じグループに継承版があっても、固有は買えない。
    expect(model.cost(unique.id)).toBe(0);
  });

  it('ほかのスキルの費用は変わらない', () => {
    const model = createCostModel(data.skillsById);
    for (const skill of data.skills) {
      if (skill.rarity === 'special') continue;
      expect(model.cost(skill.id)).toBe(skill.sp);
    }
  });
});
