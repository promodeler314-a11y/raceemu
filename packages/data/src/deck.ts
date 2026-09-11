/**
 * サポートカードと育成ウマ娘。
 *
 * 育成計画から探索を始めるとき、金と進化とシナリオの候補は、連れて行くカードと
 * 育てるウマ娘で決まる。白は継承で開いているので候補の可否には効かず、
 * カードのヒントは費用だけを動かす。docs/solver-design.md 7.2 節と 7.6 節を参照。
 *
 * レースの計算には要らないので、`GameData` とは別に読む。
 * ブラウザ向けのバンドルでは、Worker 側にこれが混ざらないようにするためでもある。
 */

export interface SupportHint {
  /** 凸の数（0 から 4） */
  readonly talent: number;
  /** ヒントレベルの底上げ */
  readonly level: number;
  /** ヒントの発生率 */
  readonly frequency: number;
}

export interface SupportCard {
  readonly id: number;
  /** `[勝負服]ウマ娘名` の形 */
  readonly name: string;
  readonly chara: string;
  /** 1 が R、2 が SR、3 が SSR */
  readonly rarity: number;
  /** 得意練習 */
  readonly type: string;
  /** ヒントで取れるスキル名。凸では変わらない。 */
  readonly skills: readonly string[];
  readonly hints: readonly SupportHint[];
}

export interface TrainedChara {
  readonly id: number;
  readonly name: string;
  readonly charaId: number;
  readonly charaName: string;
  readonly rarity: number;
  /** 最大覚醒ランクまでに覚えるスキル名。固有を含む。 */
  readonly skills: readonly string[];
  /** 覚醒ランク r までに覚えている数が `skillCountByRank[r - 1]` である。 */
  readonly skillCountByRank: readonly number[];
}

export interface DeckData {
  readonly supports: readonly SupportCard[];
  readonly supportsById: ReadonlyMap<number, SupportCard>;
  readonly charas: readonly TrainedChara[];
  readonly charasById: ReadonlyMap<number, TrainedChara>;
}

export function buildDeckData(supportsJson: unknown, charasJson: unknown): DeckData {
  const supports = supportsJson as SupportCard[];
  const charas = charasJson as TrainedChara[];
  return {
    supports,
    supportsById: new Map(supports.map((card) => [card.id, card])),
    charas,
    charasById: new Map(charas.map((chara) => [chara.id, chara])),
  };
}

/** 覚醒ランクで覚えているスキル名。ランクを省くと最大まで覚えたものを返す。 */
export function charaSkills(chara: TrainedChara, rank?: number): readonly string[] {
  if (rank === undefined) return chara.skills;
  const index = Math.max(1, Math.min(chara.skillCountByRank.length, rank)) - 1;
  return chara.skills.slice(0, chara.skillCountByRank[index] ?? chara.skills.length);
}

/** 凸の数に対するヒントレベル。指定が無ければ完凸として扱う。 */
export function supportHint(card: SupportCard, talent: number): SupportHint | undefined {
  return card.hints.find((hint) => hint.talent === talent) ?? card.hints[card.hints.length - 1];
}
