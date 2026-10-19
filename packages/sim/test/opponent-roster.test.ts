import { describe, expect, it } from 'vitest';
import { loadDeckData } from '../../data/src/deck-node.ts';
import { loadGameData } from '../../data/src/node.ts';
import { buildRoster, parseRosterOverrides } from '../../data/src/roster.ts';
import { RaceCalculator } from '../src/calculator.ts';
import {
  buildFieldBundle,
  defaultFieldProfile,
  fixedFieldProfile,
  opponentSettings,
  type FieldProfile,
} from '../src/field/field.ts';
import {
  DEFAULT_ROSTER_PROFILE,
  drawRosterOpponents,
  type OpponentRanking,
  type OpponentRoster,
  type OpponentRosterCard,
  type RosterProfile,
} from '../src/field/opponent-roster.ts';
import { opponentSkillPool } from '../src/field/opponent-skills.ts';
import { runChunk } from '../src/parallel/runner.ts';
import { toSerializable, unpackResults, type FieldSpec } from '../src/parallel/protocol.ts';
import { defaultSystemSetting, type RaceSetting, type UmaStatus } from '../src/setting.ts';
import type { SkillData } from '../src/skill/types.ts';
import type { Style } from '../src/data/constants.ts';

/**
 * 相手の名簿（`field/opponent-roster.ts`）の検査。
 *
 * 見るのは引き方の性質である。名簿の相手がゲームの強さに合っているかは、
 * SP の予算を振って別に測る（このテストの範囲ではない）。
 */

const data = loadGameData();
const system = defaultSystemSetting();
const track = { location: 10006, course: 10606, condition: 1, gateCount: 9 } as const;
const pool = opponentSkillPool(data.skillsById);
const charas = loadDeckData().charas;
const cards = buildRoster(charas, data);

const self: UmaStatus = {
  charaName: '',
  speed: 1400,
  stamina: 1100,
  power: 1100,
  guts: 900,
  wisdom: 1100,
  condition: 'BEST',
  style: 'SEN',
  distanceFit: 'A',
  surfaceFit: 'A',
  styleFit: 'A',
  popularity: 1,
  gateNumber: 5,
  uniqueLevel: 6,
};

const bySkillId = (a: SkillData, b: SkillData): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const isWhiteOrGold = (skill: SkillData): boolean => skill.rarity === 'normal' || skill.rarity === 'rare';

/**
 * 実在のスキル id で作る、小さな合成の ranking。
 * 脚質ごとに白金 40 個、緑 16 個、継承固有 15 個を、互いに違う位置から取る。
 * 白金と緑と継承固有を交互に並べ、value は降順にする。
 */
function syntheticRanking(): OpponentRanking {
  const whites = data.skills.filter((s) => isWhiteOrGold(s) && s.sp > 0 && s.type !== 'passive').sort(bySkillId);
  const greens = data.skills.filter((s) => isWhiteOrGold(s) && s.sp > 0 && s.type === 'passive').sort(bySkillId);
  const inherits = data.skills.filter((s) => s.rarity === 'inherit').sort(bySkillId);
  const take = (list: SkillData[], n: number, offset: number, step: number): SkillData[] => {
    const seen = new Set<string>();
    const out: SkillData[] = [];
    for (let i = 0; out.length < n && i < list.length; i++) {
      const skill = list[(offset + i * step) % list.length]!;
      if (!seen.has(skill.id)) {
        seen.add(skill.id);
        out.push(skill);
      }
    }
    return out;
  };
  const styles = ['NIGE', 'SEN', 'SASI', 'OI'] as const;
  const entries = (k: number): [string, number][] => {
    const w = take(whites, 40, k * 13, 3);
    const g = take(greens, 16, k * 5, 3);
    const h = take(inherits, 15, k * 17, 7);
    const merged: SkillData[] = [];
    for (let i = 0; i < 40; i++) {
      if (w[2 * i]) merged.push(w[2 * i]!);
      if (w[2 * i + 1]) merged.push(w[2 * i + 1]!);
      if (g[i]) merged.push(g[i]!);
      if (h[i]) merged.push(h[i]!);
    }
    return merged.map((skill, i) => [skill.id, 1000 - 5 * i]);
  };
  return Object.fromEntries(styles.map((style, k) => [style, entries(k)])) as unknown as OpponentRanking;
}

const ranking = syntheticRanking();
const roster: OpponentRoster = { cards: cards.filter((card) => card.styles.length > 0), ranking };
const slots: Style[] = ['NIGE', 'NIGE', 'SEN', 'SEN', 'SEN', 'SASI', 'SASI', 'OI'];

/** 白・金・緑の SP の合計 */
const spent = (skills: readonly SkillData[]): number =>
  skills.filter(isWhiteOrGold).reduce((sum, skill) => sum + skill.sp, 0);

const shape = (draws: ReturnType<typeof drawRosterOpponents>): unknown =>
  draws.map((draw) => draw && [draw.card.id, draw.skills.map((skill) => skill.id)]);

describe('名簿の材料（buildRoster）', () => {
  it('合成の ranking は、引く側の前提を満たしている', () => {
    for (const style of ['NIGE', 'SEN', 'SASI', 'OI'] as const) {
      const skills = ranking[style].map(([id]) => data.skillsById.get(id)!);
      expect(skills.some((s) => s.rarity === 'inherit')).toBe(true);
      expect(skills.filter((s) => isWhiteOrGold(s) && s.type === 'passive').length).toBeGreaterThanOrEqual(10);
      expect(skills.filter((s) => isWhiteOrGold(s) && s.type !== 'passive').length).toBeGreaterThanOrEqual(20);
      // value の降順
      const values = ranking[style].map(([, value]) => value);
      expect(values).toEqual([...values].sort((a, b) => b - a));
    }
    // 名簿には、どの脚質の枠にも出られるカードが十分いる
    for (const style of ['NIGE', 'SEN', 'SASI', 'OI'] as const) {
      expect(roster.cards.filter((card) => card.styles.includes(style)).length).toBeGreaterThanOrEqual(8);
    }
  });

  it('大半のカードで固有を引ける。id の規則どおりの例がある', () => {
    expect(cards.length).toBeGreaterThanOrEqual(charas.length * 0.95);
    for (const card of cards) expect(data.skillsById.get(card.uniqueId)?.rarity).toBe('unique');
    const idOf = (cardId: number): OpponentRosterCard | undefined => cards.find((card) => card.id === cardId);
    expect(idOf(102701)?.uniqueId).toBe('100271');
    expect(idOf(110301)?.uniqueId).toBe('101031');
    // 衣装番号が 3 のカード（[ろっきん☆MewMeow]マヤノトップガン）。衣装番号 − 1 が固有の id の 2 桁目に入る。
    expect(idOf(102403)?.uniqueId).toBe('120241');
  });

  it('継承固有と進化は、id の規則から引ける', () => {
    const ryan = cards.find((card) => card.id === 102701)!;
    expect(ryan.inheritId).toBe('900271');
    expect(data.skillsById.get(ryan.inheritId!)?.rarity).toBe('inherit');
    for (const card of cards) {
      expect(card.evoIds.length).toBeLessThanOrEqual(2);
      for (const id of card.evoIds) {
        expect(data.skillsById.get(id)?.rarity).toBe('evo');
        expect(id.startsWith(String(card.id))).toBe(true);
        expect(id.endsWith('111') || id.endsWith('211')).toBe(true);
      }
      if (card.inheritId !== null) expect(card.inheritId).toBe(`9${card.uniqueId.slice(1)}`);
    }
  });

  it('覚醒スキルは白金で、固有の名前を含まない', () => {
    for (const card of cards) {
      const unique = data.skillsById.get(card.uniqueId)!;
      for (const id of card.awakeningIds) {
        const skill = data.skillsById.get(id)!;
        expect(isWhiteOrGold(skill)).toBe(true);
        expect(skill.name).not.toBe(unique.name);
      }
    }
  });

  it('得意脚質は推定できるものが大半で、空のカードは候補にならない', () => {
    expect(cards.filter((card) => card.styles.length === 0).length).toBeLessThan(cards.length * 0.1);
    for (const card of cards) expect(card.styles.length).toBeLessThanOrEqual(4);
  });

  it('スキルの配列を渡しても、GameData を渡しても同じ', () => {
    expect(buildRoster(charas, data.skills)).toEqual(cards);
  });

  it('名簿は構造化クローンで送れる素のデータである', () => {
    expect(structuredClone(roster)).toEqual(roster);
  });
});

describe('名簿から相手を引く（drawRosterOpponents）', () => {
  it('同じ引数なら同じ結果になる。束の本が違えば変わる', () => {
    const first = shape(drawRosterOpponents(roster, DEFAULT_ROSTER_PROFILE, slots, 3, data.skillsById));
    const second = shape(drawRosterOpponents(roster, DEFAULT_ROSTER_PROFILE, slots, 3, data.skillsById));
    expect(second).toEqual(first);
    const other = shape(drawRosterOpponents(roster, DEFAULT_ROSTER_PROFILE, slots, 4, data.skillsById));
    expect(other).not.toEqual(first);
  });

  it('相手の脚質は、引いたカードの得意脚質に含まれる', () => {
    for (let sample = 0; sample < 12; sample++) {
      const draws = drawRosterOpponents(roster, DEFAULT_ROSTER_PROFILE, slots, sample, data.skillsById);
      expect(draws).toHaveLength(slots.length);
      draws.forEach((draw, i) => {
        expect(draw).not.toBeNull();
        expect(draw!.card.styles).toContain(slots[i]);
      });
    }
  });

  it('白・金・緑の SP の合計は予算を超えない。予算が 0 なら何も買わない', () => {
    const tight: RosterProfile = { ...DEFAULT_ROSTER_PROFILE, spBudget: 1500 };
    // 予算が実際に効く狭さであること（既定の予算なら、これを超えて買う）
    const loose = drawRosterOpponents(roster, DEFAULT_ROSTER_PROFILE, slots, 0, data.skillsById);
    expect(Math.max(...loose.map((draw) => spent(draw!.skills)))).toBeGreaterThan(1500);
    for (let sample = 0; sample < 12; sample++) {
      for (const draw of drawRosterOpponents(roster, tight, slots, sample, data.skillsById)) {
        expect(spent(draw!.skills)).toBeLessThanOrEqual(1500);
        // 予算が効くほど狭くても、何かは買えている
        expect(draw!.skills.filter(isWhiteOrGold).length).toBeGreaterThan(0);
      }
      for (const draw of drawRosterOpponents(roster, { ...tight, spBudget: 0 }, slots, sample, data.skillsById)) {
        expect(draw!.skills.filter(isWhiteOrGold)).toHaveLength(0);
        // 固有は予算に数えないので、残る
        expect(draw!.skills[0]!.id).toBe(draw!.card.uniqueId);
      }
    }
  });

  it('同じ group のスキルを 2 つ持たず、同じ id も重ねない', () => {
    for (let sample = 0; sample < 12; sample++) {
      for (const draw of drawRosterOpponents(roster, DEFAULT_ROSTER_PROFILE, slots, sample, data.skillsById)) {
        const groups = draw!.skills.map((skill) => skill.group);
        expect(new Set(groups).size).toBe(groups.length);
        const ids = draw!.skills.map((skill) => skill.id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });

  it('同じ束の本で、同じカードも同じウマ娘（衣装違い）も 2 回出ない', () => {
    // 先行の枠を多くして、同じ脚質で取り合う形にする
    const crowded: Style[] = ['SEN', 'SEN', 'SEN', 'SEN', 'SEN', 'SEN', 'SEN', 'SEN'];
    for (let sample = 0; sample < 200; sample++) {
      const drawn = drawRosterOpponents(roster, DEFAULT_ROSTER_PROFILE, crowded, sample, data.skillsById).map(
        (draw) => draw!.card,
      );
      const ids = drawn.map((card) => card.id);
      expect(new Set(ids).size).toBe(ids.length);
      const names = drawn.map((card) => card.charaName);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('同じウマ娘の別の衣装は、候補があっても引かない', () => {
    const base = cards.find((card) => card.id === 102701)!;
    const costume = (id: number, score: number): OpponentRosterCard => ({ ...base, id, styles: ['NIGE'], score });
    // 衣装違いの 2 枚（同じキャラ名）と、別のウマ娘 1 枚。score の高い順に引く。
    const other: OpponentRosterCard = { ...costume(3, 1), charaName: `${base.charaName}とは別のウマ娘` };
    const mixed: OpponentRoster = { cards: [costume(1, 9), costume(2, 5), other], ranking };
    const draws = drawRosterOpponents(
      mixed,
      { ...DEFAULT_ROSTER_PROFILE, spread: 0 },
      ['NIGE', 'NIGE', 'NIGE'],
      0,
      data.skillsById,
    );
    // 2 枚目は別のウマ娘、3 枚目は同じキャラ名しか残っていないので引けない。
    expect(draws.map((draw) => draw?.card.id ?? null)).toEqual([1, 3, null]);
  });

  it('固有・進化・継承固有・緑が揃い、継承固有は自分のものではない', () => {
    for (let sample = 0; sample < 8; sample++) {
      for (const draw of drawRosterOpponents(roster, DEFAULT_ROSTER_PROFILE, slots, sample, data.skillsById)) {
        const { card, skills } = draw!;
        const ids = skills.map((skill) => skill.id);
        expect(ids[0]).toBe(card.uniqueId);
        for (const evoId of card.evoIds) expect(ids).toContain(evoId);
        const inherits = skills.filter((skill) => skill.rarity === 'inherit');
        expect(inherits.length).toBeLessThanOrEqual(DEFAULT_ROSTER_PROFILE.inheritCount);
        expect(inherits.length).toBeGreaterThan(0);
        for (const skill of inherits) expect(skill.id).not.toBe(card.inheritId);
        expect(skills.filter((skill) => isWhiteOrGold(skill) && skill.type === 'passive').length).toBeGreaterThan(0);
      }
    }
  });

  it('ヒントが必ず出ないなら、買えるのは覚醒のスキルだけ（緑を引かない場合）', () => {
    const noHint: RosterProfile = { ...DEFAULT_ROSTER_PROFILE, hintMissRate: 1, greenCount: 0 };
    for (let sample = 0; sample < 8; sample++) {
      for (const draw of drawRosterOpponents(roster, noHint, slots, sample, data.skillsById)) {
        for (const skill of draw!.skills.filter(isWhiteOrGold)) {
          expect(draw!.card.awakeningIds).toContain(skill.id);
        }
      }
    }
    // 外れが無ければ、覚醒以外も買う
    const hinted: RosterProfile = { ...noHint, hintMissRate: 0 };
    const some = drawRosterOpponents(roster, hinted, slots, 0, data.skillsById).some((draw) =>
      draw!.skills.filter(isWhiteOrGold).some((skill) => !draw!.card.awakeningIds.includes(skill.id)),
    );
    expect(some).toBe(true);
  });

  it('覚醒で覚えるスキルは、ヒントが必ず出なくても買う', () => {
    const base = cards.find((card) => card.id === 102701)!;
    // ranking の上のほうから、group が重ならない白金を 5 つ覚醒で覚えたことにする。
    const whites = ranking.NIGE.map(([id]) => data.skillsById.get(id)!).filter(
      (skill) => isWhiteOrGold(skill) && skill.type !== 'passive',
    );
    const learned: SkillData[] = [];
    for (const skill of whites) {
      if (learned.every((other) => other.group !== skill.group)) learned.push(skill);
      if (learned.length === 5) break;
    }
    const card: OpponentRosterCard = { ...base, id: 1, styles: ['NIGE'], evoIds: [], awakeningIds: learned.map((s) => s.id) };
    const noHint: RosterProfile = { ...DEFAULT_ROSTER_PROFILE, hintMissRate: 1, greenCount: 0 };
    const draws = drawRosterOpponents({ cards: [card], ranking }, noHint, ['NIGE'], 0, data.skillsById);
    const bought = draws[0]!.skills.filter(isWhiteOrGold).map((skill) => skill.id);
    expect(bought.sort()).toEqual(learned.map((skill) => skill.id).sort());
  });

  it('継承固有は、枠が足りるほど多く求めても自分のものを持たない', () => {
    const base = cards.find((card) => card.id === 102701)!;
    const [top] = ranking.NIGE.filter(([id]) => data.skillsById.get(id)?.rarity === 'inherit');
    const card: OpponentRosterCard = { ...base, id: 1, styles: ['NIGE'], inheritId: top![0] };
    const many: RosterProfile = { ...DEFAULT_ROSTER_PROFILE, inheritCount: 10 };
    const draws = drawRosterOpponents({ cards: [card], ranking }, many, ['NIGE'], 0, data.skillsById);
    const inherits = draws[0]!.skills.filter((skill) => skill.rarity === 'inherit');
    expect(inherits).toHaveLength(10);
    expect(inherits.map((skill) => skill.id)).not.toContain(top![0]);
  });

  it('候補のカードが尽きた枠は null になる', () => {
    const only: OpponentRoster = { cards: roster.cards.filter((card) => card.styles.includes('OI')).slice(0, 1), ranking };
    const draws = drawRosterOpponents(only, DEFAULT_ROSTER_PROFILE, ['OI', 'OI', 'SEN'], 0, data.skillsById);
    expect(draws[0]).not.toBeNull();
    expect(draws[1]).toBeNull();
    expect(draws[2]).toBeNull();
  });

  it('spread が 0 以下なら、score の高いカードから順に引く', () => {
    const base = cards.find((card) => card.id === 102701)!;
    // 同じウマ娘は 2 度出ないので、キャラ名はカードごとに変える。
    const scored = (id: number, score: number): OpponentRosterCard => ({
      ...base,
      id,
      charaName: `ウマ娘${id}`,
      styles: ['NIGE'],
      score,
    });
    const three: OpponentRoster = { cards: [scored(1, 1), scored(2, 5), scored(3, 3)], ranking };
    const draws = drawRosterOpponents(three, { ...DEFAULT_ROSTER_PROFILE, spread: 0 }, ['NIGE', 'NIGE', 'NIGE'], 0, data.skillsById);
    expect(draws.map((draw) => draw!.card.id)).toEqual([2, 3, 1]);
  });

  it('score が無ければ、ranking での継承固有の value を使う', () => {
    const base = cards.find((card) => card.id === 102701)!;
    const [first, second] = ranking.NIGE.filter(([id]) => data.skillsById.get(id)?.rarity === 'inherit');
    const unscored = (id: number, inheritId: string | null): OpponentRosterCard => ({
      ...base,
      id,
      charaName: `ウマ娘${id}`,
      styles: ['NIGE'],
      inheritId,
      score: undefined,
    });
    // 並びは value の降順なので、上のほうの継承固有を持つカードが先に出る。
    const two: OpponentRoster = { cards: [unscored(1, second![0]), unscored(2, first![0]), unscored(3, null)], ranking };
    const draws = drawRosterOpponents(two, { ...DEFAULT_ROSTER_PROFILE, spread: 0 }, ['NIGE', 'NIGE', 'NIGE'], 0, data.skillsById);
    expect(draws.map((draw) => draw!.card.id)).toEqual([2, 1, 3]);
  });
});

describe('相手の想定への組み込み（opponentSettings）', () => {
  const rosterProfile: FieldProfile = { ...defaultFieldProfile(9), opponentModel: 'roster' };
  const options = { self, skillPool: pool, skillsById: data.skillsById, roster };

  it('既定の想定は、名簿のためのキーを持たない', () => {
    // skill-list の版は既定の想定の中身から指紋を作る。キーが増えると事前計算が全部作り直しになる。
    for (const profile of [defaultFieldProfile(9), defaultFieldProfile(12), fixedFieldProfile(9)]) {
      expect(Object.keys(profile)).not.toContain('opponentModel');
      expect(Object.keys(profile)).not.toContain('roster');
    }
  });

  it('opponentModel を省いたときと、typical を明示したときで結果が同じ', () => {
    const plain = defaultFieldProfile(9);
    for (let sample = 0; sample < 4; sample++) {
      const omitted = opponentSettings(plain, track, { ...options, sample });
      const explicit = opponentSettings({ ...plain, opponentModel: 'typical' }, track, { ...options, sample });
      expect(explicit).toEqual(omitted);
      // 名簿を渡さなくても同じ（名簿は typical では使われない）
      const without = opponentSettings(plain, track, { ...options, roster: null, sample });
      expect(without).toEqual(omitted);
    }
  });

  it('roster では、キャラ名と固有レベルとスキルが名簿から入る', () => {
    const level3: FieldProfile = { ...rosterProfile, roster: { ...DEFAULT_ROSTER_PROFILE, uniqueLevel: 3 } };
    const names = new Set(roster.cards.map((card) => card.charaName));
    for (let sample = 0; sample < 4; sample++) {
      const settings = opponentSettings(level3, track, { ...options, sample });
      expect(settings).toHaveLength(8);
      for (const setting of settings) {
        expect(names.has(setting.uma.charaName)).toBe(true);
        expect(setting.uma.uniqueLevel).toBe(3);
        const card = roster.cards.find(
          (c) => c.charaName === setting.uma.charaName && c.styles.includes(setting.uma.style),
        );
        expect(card).toBeDefined();
        expect(setting.skills.some((skill) => skill.rarity === 'unique')).toBe(true);
      }
    }
    // 既定の uniqueLevel は 4
    const settings = opponentSettings(rosterProfile, track, { ...options, sample: 0 });
    for (const setting of settings) expect(setting.uma.uniqueLevel).toBe(4);
  });

  it('同じ指定なら何度作っても同じ相手になる', () => {
    const first = opponentSettings(rosterProfile, track, { ...options, sample: 5 });
    const second = opponentSettings(rosterProfile, track, { ...options, sample: 5 });
    expect(second).toEqual(first);
  });

  it('sample が無いときは 0 番として引く', () => {
    const none = opponentSettings(rosterProfile, track, options);
    // 引き直さないので、脚質の並びは profile.counts の通り（逃げ・先行・差し・追込が 2 頭ずつ）である。
    const fixedSlots: Style[] = ['NIGE', 'NIGE', 'SEN', 'SEN', 'SASI', 'SASI', 'OI', 'OI'];
    expect(none.map((setting) => setting.uma.style)).toEqual(fixedSlots);
    const direct = drawRosterOpponents(roster, DEFAULT_ROSTER_PROFILE, fixedSlots, 0, data.skillsById);
    none.forEach((setting, i) => {
      expect(setting.uma.charaName).toBe(direct[i]!.card.charaName);
      expect(setting.skills.map((s) => s.id)).toEqual(direct[i]!.skills.map((s) => s.id));
    });
  });

  it('カードが引けない枠は、典型スキルの経路に落ちる', () => {
    // 逃げのカードしか居ない名簿。それ以外の枠は典型スキルと同じになる。
    const nigeOnly: OpponentRoster = { cards: roster.cards.filter((card) => card.styles.includes('NIGE')), ranking };
    for (let sample = 0; sample < 4; sample++) {
      const typical = opponentSettings(defaultFieldProfile(9), track, { ...options, sample });
      const mixed = opponentSettings(rosterProfile, track, { ...options, roster: nigeOnly, sample });
      expect(mixed).toHaveLength(typical.length);
      mixed.forEach((setting, i) => {
        if (setting.uma.style === 'NIGE') {
          expect(setting.uma.charaName).not.toBe('');
        } else {
          expect(setting).toEqual(typical[i]);
        }
      });
    }
  });

  it('スキルの表が無ければ名簿は引けず、典型の経路になる', () => {
    const typical = opponentSettings(defaultFieldProfile(9), track, { self, skillPool: pool, sample: 1 });
    const fallback = opponentSettings(rosterProfile, track, { self, skillPool: pool, roster, sample: 1 });
    expect(fallback).toEqual(typical);
  });

  it('自己整合の混ぜは、名簿のスキルのあとに掛かる', () => {
    const mixId = ranking.SEN.find(([id]) => data.skillsById.get(id)?.rarity === 'inherit')![0];
    const mixed: FieldProfile = { ...rosterProfile, mixSkillIds: [mixId], mixRate: 1 };
    const settings = opponentSettings(mixed, track, { ...options, sample: 2 });
    for (const setting of settings) {
      expect(setting.skills.some((skill) => skill.id === mixId)).toBe(true);
      const ids = setting.skills.map((skill) => skill.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});

describe('束と並列実行の経路（名簿あり）', () => {
  const rosterProfile: FieldProfile = { ...defaultFieldProfile(9), opponentModel: 'roster' };
  const common = { samples: 2, seed: 7, self, skillPool: pool, skillsById: data.skillsById };

  it('名簿ありで 2 回作ると、同じ位置列になる', () => {
    const first = buildFieldBundle(rosterProfile, track, system, data.trackData, { ...common, roster });
    const second = buildFieldBundle(rosterProfile, track, system, data.trackData, { ...common, roster });
    expect(first.samples).toHaveLength(2);
    first.samples.forEach((sample, i) => {
      const other = second.samples[i]!;
      expect(other.frames).toBe(sample.frames);
      expect(other.styles).toEqual(sample.styles);
      expect(Array.from(other.positions)).toEqual(Array.from(sample.positions));
    });
  });

  it('名簿で相手が変わるので、位置列も典型とは変わる', () => {
    const typical = buildFieldBundle(defaultFieldProfile(9), track, system, data.trackData, common);
    const withRoster = buildFieldBundle(rosterProfile, track, system, data.trackData, { ...common, roster });
    const sum = (positions: Float64Array): number => positions.reduce((a, b) => a + b, 0);
    expect(sum(withRoster.samples[0]!.positions)).not.toBe(sum(typical.samples[0]!.positions));
  });

  it('FieldSpec に名簿を載せると、runChunk がそれを束に渡す', () => {
    const setting: RaceSetting = {
      uma: self,
      track,
      skills: [],
      skillActivateAdjustment: 'NONE',
      randomPosition: 'RANDOM',
      debuffCounts: {},
      positionKeepMode: 'APPROXIMATE',
      positionKeepRate: 100,
    };
    const spec: FieldSpec = { profile: rosterProfile, track, seed: 11, samples: 2, roster };
    const simData = { trackData: data.trackData, skillsById: data.skillsById };
    const packed = runChunk(simData, toSerializable(setting), system, 5, 0, 3, spec);

    // 同じことを手で組む。名簿を落としていれば、ここで食い違う。
    const bundle = buildFieldBundle(rosterProfile, track, system, data.trackData, {
      samples: 2,
      seed: 11,
      self,
      skillPool: pool,
      skillsById: data.skillsById,
      roster,
    });
    const calculator = new RaceCalculator(system, data.trackData);
    const expected = [0, 1, 2].map((i) => calculator.simulate(setting, { seed: 5, trial: i, field: bundle }).result);
    const actual = unpackResults(packed.packed);
    expect(actual.map((r) => r.raceTime)).toEqual(expected.map((r) => r.raceTime));

    // 再実行しても同じ（束は作り置きされる）
    const again = runChunk(simData, toSerializable(setting), system, 5, 0, 3, spec);
    expect(Array.from(again.packed)).toEqual(Array.from(packed.packed));
  });
});

describe('手元の名簿の読み込み（parseRosterOverrides）', () => {
  const ryan = cards.find((card) => card.id === 102701)!;
  const royce = cards.find((card) => card.id === 110301)!;
  const special = cards.find((card) => card.id === 100101)!;

  it('JSON の配列を読む', () => {
    const text = JSON.stringify([
      { cardId: ryan.id, style: 'SEN', score: 9.5 },
      { cardId: String(royce.id), style: '追込' },
      { cardId: 999999, style: 'NIGE' },
      { cardId: special.id, style: 'ふつう' },
    ]);
    const before = JSON.stringify(ryan);
    const result = parseRosterOverrides(text, cards);
    expect(result.parsed).toBe(2);
    expect(result.skipped).toBe(2);
    expect(result.cards.map((card) => card.id)).toEqual([ryan.id, royce.id]);
    expect(result.cards[0]!.styles).toEqual(['SEN']);
    expect(result.cards[0]!.score).toBe(9.5);
    expect(result.cards[1]!.styles).toEqual(['OI']);
    expect(result.cards[1]!.score).toBeUndefined();
    // 元のカードは書き換えない
    expect(JSON.stringify(ryan)).toBe(before);
  });

  it('タブ区切りの行を読む。複合の欄の中の脚質も拾う', () => {
    const line = `1\t${ryan.id}\t通常スティル\t中A/芝A/差し\tx1.05\t9.50091`;
    const result = parseRosterOverrides(line, cards);
    expect(result.parsed).toBe(1);
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]!.id).toBe(ryan.id);
    expect(result.cards[0]!.styles).toEqual(['SASI']);
    expect(result.cards[0]!.score).toBe(9.50091);
    // 固有などの中身はそのまま残る
    expect(result.cards[0]!.uniqueId).toBe(ryan.uniqueId);
  });

  it('複数の行を読み、読めない行は飛ばして数える', () => {
    const text = [
      '順位\tカード\t名前\t適性\t倍率\tスコア',
      `1\t${ryan.id}\t通常スティル\t中A/芝A/差し\tx1.05\t9.50091`,
      '',
      `2\t${royce.id}\t通常先行\t中A/芝A/先行\tx1.00\t8.25`,
      '3\t123456\t名簿に無い\t中A/芝A/逃げ\tx1.00\t7.00',
      `4\t${special.id}\t脚質の語が無い\t中A/芝A\tx1.00\t6.00`,
    ].join('\r\n');
    const result = parseRosterOverrides(text, cards);
    expect(result.parsed).toBe(2);
    expect(result.skipped).toBe(3);
    expect(result.cards.map((card) => [card.id, card.styles[0], card.score])).toEqual([
      [ryan.id, 'SASI', 9.50091],
      [royce.id, 'SEN', 8.25],
    ]);
  });

  it('英字の脚質も読み、同じカードが重なればあとが勝つ', () => {
    const text = `${ryan.id}\tNIGE\t1.5\n${ryan.id}\toi\t2.5`;
    const result = parseRosterOverrides(text, cards);
    expect(result.parsed).toBe(2);
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]!.styles).toEqual(['OI']);
    expect(result.cards[0]!.score).toBe(2.5);
  });

  it('読んだ名簿は、そのまま相手を引くのに使える', () => {
    const text = [ryan, royce, special]
      .map((card, i) => `${card.id}\t${['差し', '先行', '逃げ'][i]}\t${3 - i}.5`)
      .join('\n');
    const { cards: listed } = parseRosterOverrides(text, cards);
    const draws = drawRosterOpponents({ cards: listed, ranking }, { ...DEFAULT_ROSTER_PROFILE, spread: 0 }, ['SEN', 'SASI', 'NIGE'], 0, data.skillsById);
    expect(draws.map((draw) => draw!.card.id)).toEqual([royce.id, ryan.id, special.id]);
  });
});

describe('出走前に決まる条件での絞り込み（trackData）', () => {
  // 一覧は春・晴れで計算してあるので、春ウマ娘○と晴れの日○が上位に来うる。秋・曇りのレースでは発動しない。
  const spring = '200172';
  const sunny = '200212';
  const seasonal: OpponentRanking = {
    NIGE: [[spring, 9], [sunny, 9], ...ranking.NIGE],
    SEN: [[spring, 9], [sunny, 9], ...ranking.SEN],
    SASI: [[spring, 9], [sunny, 9], ...ranking.SASI],
    OI: [[spring, 9], [sunny, 9], ...ranking.OI],
  };
  const seasonalRoster: OpponentRoster = { cards: roster.cards, ranking: seasonal };
  const profile = { ...defaultFieldProfile(9), opponentModel: 'roster' as const, roster: DEFAULT_ROSTER_PROFILE };
  const autumnCloudy = { ...track, season: 3, weather: 2 };
  const holds = (settings: readonly RaceSetting[], id: string): boolean =>
    settings.some((setting) => setting.skills.some((skill) => skill.id === id));

  it('trackData を渡すと、季節と天候で発動しないスキルを買わない', () => {
    for (let sample = 0; sample < 4; sample++) {
      const options = { self, skillsById: data.skillsById, roster: seasonalRoster, sample };
      const without = opponentSettings(profile, autumnCloudy, options);
      const screened = opponentSettings(profile, autumnCloudy, { ...options, trackData: data.trackData });
      expect(holds(without, spring) || holds(without, sunny)).toBe(true);
      expect(holds(screened, spring)).toBe(false);
      expect(holds(screened, sunny)).toBe(false);
    }
  });

  it('季節と天候を指定しないコースでは、季節と天候のスキルは落とさない', () => {
    // 指定が無いときは本家と同じく「満たしている前提」になる（TrackRef.season の注記）。
    let kept = false;
    for (let sample = 0; sample < 4; sample++) {
      const options = { self, skillsById: data.skillsById, roster: seasonalRoster, sample, trackData: data.trackData };
      const screened = opponentSettings(profile, track, options);
      kept ||= holds(screened, spring) || holds(screened, sunny);
    }
    expect(kept).toBe(true);
  });
});
