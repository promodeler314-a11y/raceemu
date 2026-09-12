import type { Style } from '../data/constants.ts';
import type { SkillData } from '../skill/types.ts';

/**
 * 相手に持たせる典型スキル。
 *
 * 相手だけがスキルを持たない偏りを消すためのもので、特定の構成を再現する
 * ものではない。実戦の分布に合わせる先はここと σ である。
 * docs/order-field.md 4.3 節と 6 節を参照。
 */
export const OPPONENT_SKILL_NAMES: Readonly<Record<'ANY' | Style, readonly string[]>> = {
  ANY: ['末脚', 'コーナー巧者○', '直線巧者', '好位追走', 'ペースアップ', '集中力', '中距離直線○', '中距離コーナー○'],
  NIGE: ['先駆け', '脱出術', '先手必勝', '急ぎ足', 'スピードスター', 'トップランナー', 'ペースキープ', '逃げ直線○'],
  SEN: ['抜け出し準備', '積極策', '真っ向勝負', '粘り腰', 'レースプランナー', '先行直線○', '先行コーナー○'],
  SASI: ['豪脚', '仕掛け抜群', '食い下がり', '垂れウマ回避', '位置取り押し上げ', '差し直線○', '差しコーナー○'],
  OI: ['直線一気', '迫る影', 'ノンストップガール', '二の矢', '追込直線○', '追込コーナー○'],
  OONIGE: ['先駆け', '脱出術', '先手必勝', '急ぎ足', 'スピードスター'],
};

/** 脚質ごとの、相手に持たせる候補 */
export type OpponentSkillPool = Readonly<Record<Style, readonly SkillData[]>>;

/**
 * 引き当ては 1700 件を舐めるので、同じ表に対しては作り置きを返す。
 * Worker は表を 1 つしか持たないため、実質 1 回しか作らない。
 */
const cache = new WeakMap<object, OpponentSkillPool>();

/**
 * スキルの表から、脚質ごとの候補を引き当てる。
 *
 * 名前で引くのは、上の表を読める形に保つためである。同じ名前に通常版と
 * 継承版があるので、買える通常版を優先する。引けない名前は黙って飛ばす。
 * データが入れ替わって名前が消えても、相手が少し弱くなるだけで済ませたい。
 */
export function opponentSkillPool(skillsById: ReadonlyMap<string, SkillData>): OpponentSkillPool {
  const hit = cache.get(skillsById);
  if (hit !== undefined) return hit;

  const byName = new Map<string, SkillData>();
  for (const skill of skillsById.values()) {
    const current = byName.get(skill.name);
    if (current === undefined || (current.rarity !== 'normal' && skill.rarity === 'normal')) {
      byName.set(skill.name, skill);
    }
  }
  const pick = (names: readonly string[]): SkillData[] =>
    names.flatMap((name) => {
      const skill = byName.get(name);
      return skill === undefined ? [] : [skill];
    });

  const any = pick(OPPONENT_SKILL_NAMES.ANY);
  const styles: Style[] = ['NIGE', 'SEN', 'SASI', 'OI', 'OONIGE'];
  const pool = Object.fromEntries(
    styles.map((style) => [style, [...any, ...pick(OPPONENT_SKILL_NAMES[style])]]),
  ) as unknown as OpponentSkillPool;
  cache.set(skillsById, pool);
  return pool;
}
