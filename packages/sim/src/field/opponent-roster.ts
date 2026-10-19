import type { Style } from '../data/constants.ts';
import type { SkillData } from '../skill/types.ts';

/**
 * 実在のカードから相手を組む想定（相手の名簿）。
 *
 * 典型スキル（`opponent-skills.ts`）の相手は、固有も進化も持たず、スキルは 5 から 8 個である。
 * 自分は最適化した構成で出るので、序盤から先頭に立ちっぱなしになり、
 * 順位条件のついたスキルを過大に評価する。名簿の相手は、得意脚質どおりの実在カードに
 * 固有・進化・継承固有・白金緑を持たせて、これを直す。
 *
 * 強さは SP の予算で合わせる。予算を決めずに上位から配ると、相手が強すぎて自分が勝てなくなる。
 * 逆に絞りすぎると相手が弱く、自分が先頭に立つ形へ戻る。
 *
 * ここの型はすべて構造化クローンで Worker へ送れる素のデータである（`parallel/protocol.ts`）。
 * 引き方は鍵だけで決まる。Worker ごとに違う束ができると、共通乱数によるペア比較が崩れる。
 */

/** 名簿が引く脚質。大逃げは逃げの枠として扱う。 */
export type RosterStyle = 'NIGE' | 'SEN' | 'SASI' | 'OI';

/** 名簿のカード 1 枚。育成ウマ娘の 1 衣装にあたる。 */
export interface OpponentRosterCard {
  /** カード id（6 桁） */
  readonly id: number;
  readonly charaName: string;
  /** `[勝負服]ウマ娘名` の形 */
  readonly name: string;
  /**
   * 得意脚質。複数あればそのどの枠にも出られる。空ならどの枠にも出ない。
   * 上流のデータに適性が無いので、データから推定した値か、利用者が渡した値である。
   */
  readonly styles: readonly Style[];
  /** 固有スキルの id */
  readonly uniqueId: string;
  /** 継承固有の id。固有に継承版が無ければ null。 */
  readonly inheritId: string | null;
  /** 進化スキルの id。持たなければ空。 */
  readonly evoIds: readonly string[];
  /** 覚醒で覚えるスキルの id。ヒントが出なくても買える扱いにする。 */
  readonly awakeningIds: readonly string[];
  /**
   * 強さの目安。大きいほど選ばれやすい。
   * 省くと、ranking でのそのカードの継承固有の value を使い、それも無ければ 0 とする。
   */
  readonly score?: number;
}

/**
 * そのコース・脚質での、スキル単体の短縮量の並び。脚質ごとに value の降順。
 * 並べ方（どのコースで、どの設定で測るか）は呼び出し側が決める。
 */
export type OpponentRanking = Readonly<
  Record<RosterStyle, readonly (readonly [skillId: string, value: number])[]>
>;

export interface OpponentRoster {
  readonly cards: readonly OpponentRosterCard[];
  readonly ranking: OpponentRanking;
}

/** 名簿の相手の組み方 */
export interface RosterProfile {
  /** 相手の固有スキルのレベル */
  readonly uniqueLevel: number;
  /**
   * 白・金・緑に使う SP の予算。**表示されている SP の合計**である（ヒントの割引前）。
   * 固有・進化・継承固有はこれに数えない。
   */
  readonly spBudget: number;
  /** 持たせる継承固有の数 */
  readonly inheritCount: number;
  /** 先に引いて買う緑（能力を引き出すスキル）の数 */
  readonly greenCount: number;
  /**
   * ヒントが出なかった扱いにする確率。
   * 覚醒で覚えるスキル以外は、この確率で買わずに飛ばす。
   */
  readonly hintMissRate: number;
  /**
   * カードの選ばれやすさの減り方。順位 r のカードを exp(-r / spread) の重みで引く。
   * 大きいほど順位によらず一様に近づき、0 以下なら常に最上位を引く。
   */
  readonly spread: number;
}

export const DEFAULT_ROSTER_PROFILE: RosterProfile = {
  uniqueLevel: 4,
  spBudget: 10000,
  inheritCount: 3,
  greenCount: 4,
  hintMissRate: 0.3,
  spread: 10,
};

/** 1 頭ぶんの引き当て。スキルは固有・進化・継承固有・緑・白金の順に並ぶ。 */
export interface RosterDraw {
  readonly card: OpponentRosterCard;
  readonly skills: SkillData[];
}

/** 継承固有を引く母集団の大きさ（ranking の上位） */
const INHERIT_TOP = 10;
/** 緑を引く母集団の大きさ（緑の中の上位） */
const GREEN_TOP = 8;

function mix32(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return (x ^ (x >>> 16)) >>> 0;
}

/**
 * 鍵・流れ・添字から決まる、0 以上 1 未満の一様乱数。
 *
 * `field.ts` の `drawIndex` と同じく、Math.random は使わない。
 * 流れは用途の区別（カード・継承・緑・ヒント）で、添字はその中の何番目かである。
 */
function uniform(key: number, stream: number, k: number): number {
  let h = mix32((key | 0) ^ 0x9e3779b9);
  h = mix32((h + Math.imul(stream | 0, 0x85ebca6b)) | 0);
  h = mix32((h + Math.imul(k | 0, 0xc2b2ae35)) | 0);
  return h / 0x100000000;
}

const STREAM_CARD = 0;
const STREAM_INHERIT = 1;
const STREAM_GREEN = 2;
const STREAM_HINT = 3;

/** スキル id を乱数の添字にする。数字だけの id はそのまま使う。 */
function idKey(id: string): number {
  const n = Number(id);
  if (Number.isInteger(n)) return n;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  return h;
}

/** 大逃げは逃げの枠として引く。 */
function rosterStyleOf(style: Style): RosterStyle {
  return style === 'OONIGE' ? 'NIGE' : style;
}

/** その脚質の相手がそのスキルを使えるか。出走前に決まる条件で絞る口（`field.ts` が組む）。 */
export type RosterSkillFilter = (skill: SkillData, style: RosterStyle) => boolean;

interface Buyable {
  readonly skill: SkillData;
  readonly value: number;
}

/** ranking の 1 脚質ぶんを、引く側が使いやすい形に畳んだもの */
interface StylePool {
  readonly skillsById: ReadonlyMap<string, SkillData>;
  /** 白・金・緑。効き ÷ SP の降順。 */
  readonly buyable: readonly Buyable[];
  /** buyable のうち緑。value の降順（上位 GREEN_TOP 個に絞るのは、使えるかで絞ったあと）。 */
  readonly greens: readonly Buyable[];
  /** 継承固有。ranking の並びのまま。 */
  readonly inherits: readonly SkillData[];
}

/**
 * 畳んだ結果は、同じ ranking と同じ表に対して作り置きする。
 * 並べ替えは引き当てのたびに同じ結果になるので、相手 1 頭ごとに繰り返さない。
 */
const poolCache = new WeakMap<object, StylePool>();
const valueCache = new WeakMap<object, ReadonlyMap<string, number>>();

function valuesOf(entries: readonly (readonly [string, number])[]): ReadonlyMap<string, number> {
  let hit = valueCache.get(entries);
  if (hit === undefined) {
    hit = new Map(entries.map(([id, value]) => [id, value] as const));
    valueCache.set(entries, hit);
  }
  return hit;
}

function poolOf(
  entries: readonly (readonly [string, number])[],
  skillsById: ReadonlyMap<string, SkillData>,
): StylePool {
  const hit = poolCache.get(entries);
  if (hit !== undefined && hit.skillsById === skillsById) return hit;

  const buyable: (Buyable & { readonly order: number })[] = [];
  const inherits: SkillData[] = [];
  entries.forEach(([id, value], order) => {
    const skill = skillsById.get(id);
    if (skill === undefined) return;
    if (skill.rarity === 'inherit') {
      inherits.push(skill);
    } else if ((skill.rarity === 'normal' || skill.rarity === 'rare') && value > 0 && skill.sp > 0) {
      buyable.push({ skill, value, order });
    }
  });
  const byDensity = [...buyable].sort(
    (a, b) => b.value / b.skill.sp - a.value / a.skill.sp || b.value - a.value || a.order - b.order,
  );
  const greens = buyable
    .filter((entry) => entry.skill.type === 'passive')
    .sort((a, b) => b.value - a.value || a.order - b.order);
  const pool: StylePool = { skillsById, buyable: byDensity, greens, inherits };
  poolCache.set(entries, pool);
  return pool;
}

/** 候補から n 個を、重複なしで引く。鍵から決まる。 */
function drawDistinct<T>(list: readonly T[], n: number, u: (i: number) => number): T[] {
  const items = [...list];
  const count = Math.min(items.length, Math.max(0, Math.floor(n)));
  for (let i = 0; i < count; i++) {
    const j = i + Math.min(items.length - i - 1, Math.floor(u(i) * (items.length - i)));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items.slice(0, count);
}

/**
 * 脚質の枠にカードを 1 枚引く。同じ束の本で選ばれたウマ娘は、衣装違いのカードも含めて候補から外す
 * （ゲームでは、1 つのレースに同じウマ娘は出ない）。
 * 候補が無ければ null。
 */
function chooseCard(
  roster: OpponentRoster,
  style: RosterStyle,
  spread: number,
  used: ReadonlySet<string>,
  slotKey: number,
): OpponentRosterCard | null {
  const values = valuesOf(roster.ranking[style]);
  const ranked = roster.cards
    .filter((card) => !used.has(card.charaName) && card.styles.includes(style))
    .map((card) => ({
      card,
      score: card.score ?? (card.inheritId === null ? undefined : values.get(card.inheritId)) ?? 0,
    }))
    // 同点は id の小さい順。名簿の並びに依らず同じ順位になる。
    .sort((a, b) => b.score - a.score || a.card.id - b.card.id);
  if (ranked.length === 0) return null;
  if (!(spread > 0)) return ranked[0]!.card;

  const weights = ranked.map((_, r) => Math.exp(-r / spread));
  let target = uniform(slotKey, STREAM_CARD, 0) * weights.reduce((a, b) => a + b, 0);
  for (let r = 0; r < ranked.length; r++) {
    target -= weights[r]!;
    if (target < 0) return ranked[r]!.card;
  }
  return ranked[ranked.length - 1]!.card;
}

/**
 * 1 頭ぶんのスキルを組む。
 *
 * 固有と進化と継承固有は SP の予算に数えない。白・金・緑だけが予算を使う。
 * 同じ group は 2 つ持たない。進化は金の置き換えなので、固有・進化・継承固有の group も
 * 「持っている」に数え、同じ group の白金を買わない。
 *
 * `usable` が渡ったときは、継承固有と白・金・緑をそれで絞る（出走前に決まる条件で発動しようが
 * ないものを買わない）。ranking の元のスキル一覧は春・晴れで計算してあるので、絞らないと秋や雨の
 * レースで、春ウマ娘○や晴れの日○のような発動しないスキルに予算を使ってしまう。
 * 逆に、一覧で 0 になっている秋・曇りのスキルは買わない（一覧の作り方による偏りで、残る）。
 * 固有と進化は絞らない（持っているかどうかはカードで決まる）。
 */
function buildSkills(
  card: OpponentRosterCard,
  style: RosterStyle,
  roster: OpponentRoster,
  profile: RosterProfile,
  skillsById: ReadonlyMap<string, SkillData>,
  slotKey: number,
  usable: RosterSkillFilter | undefined,
): SkillData[] {
  const pool = poolOf(roster.ranking[style], skillsById);
  const ok = (skill: SkillData): boolean => usable === undefined || usable(skill, style);
  const skills: SkillData[] = [];
  const held = new Set<number>();
  const take = (skill: SkillData): void => {
    skills.push(skill);
    held.add(skill.group);
  };

  // a) 固有と進化
  const unique = skillsById.get(card.uniqueId);
  if (unique !== undefined) take(unique);
  for (const id of card.evoIds) {
    const evo = skillsById.get(id);
    if (evo !== undefined) take(evo);
  }
  // 自分の継承固有は持てない。固有に無いときも、同じ group は飛ばす。
  const ownInherit = card.inheritId === null ? undefined : skillsById.get(card.inheritId);
  if (ownInherit !== undefined) held.add(ownInherit.group);

  // b) 継承固有。自分のものを除いた ranking の上位から引く。
  const inheritTop = pool.inherits.filter((skill) => skill.id !== card.inheritId && ok(skill)).slice(0, INHERIT_TOP);
  for (const skill of drawDistinct(inheritTop, profile.inheritCount, (i) =>
    uniform(slotKey, STREAM_INHERIT, i),
  )) {
    if (!held.has(skill.group)) take(skill);
  }

  // c) 白・金・緑。緑を先に引いて買い、残りの予算を効き ÷ SP の順に使う。
  let rest = profile.spBudget;
  const buy = (skill: SkillData): void => {
    take(skill);
    rest -= skill.sp;
  };
  for (const { skill } of drawDistinct(pool.greens.filter(({ skill: green }) => ok(green)).slice(0, GREEN_TOP), profile.greenCount, (i) =>
    uniform(slotKey, STREAM_GREEN, i),
  )) {
    if (!held.has(skill.group) && skill.sp <= rest) buy(skill);
  }
  const awakening = new Set(card.awakeningIds);
  for (const { skill } of pool.buyable) {
    if (held.has(skill.group) || skill.sp > rest || !ok(skill)) continue;
    // ヒントが出なかった扱い。判定はスキルごとに鍵から決まり、買えるかどうかには依らない。
    if (!awakening.has(skill.id) && uniform(slotKey, STREAM_HINT, idKey(skill.id)) < profile.hintMissRate) {
      continue;
    }
    buy(skill);
  }
  return skills;
}

/**
 * 脚質の枠ごとに、名簿から相手を 1 頭ずつ引く。
 *
 * `slots` の順に引き、同じ呼び出しの中で同じウマ娘（衣装違いのカードを含む）は 2 度出ない。
 * 候補のカードが尽きた枠は null を返す。呼び出し側が典型スキルに落とす。
 * `sampleKey` は束の何本目か。同じ引数なら、何度呼んでも同じ結果になる。
 */
export function drawRosterOpponents(
  roster: OpponentRoster,
  profile: RosterProfile,
  slots: readonly Style[],
  sampleKey: number,
  skillsById: ReadonlyMap<string, SkillData>,
  usable?: RosterSkillFilter,
): (RosterDraw | null)[] {
  const used = new Set<string>();
  return slots.map((slotStyle, slot) => {
    const style = rosterStyleOf(slotStyle);
    // 鍵は束の本と枠の添字から作る。field.ts の相手の鍵と同じ流儀である。
    const slotKey = sampleKey * 64 + slot;
    const card = chooseCard(roster, style, profile.spread, used, slotKey);
    if (card === null) return null;
    used.add(card.charaName);
    return { card, skills: buildSkills(card, style, roster, profile, skillsById, slotKey, usable) };
  });
}
