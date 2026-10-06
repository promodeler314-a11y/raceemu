import type { OpponentRosterCard, RosterStyle } from '../../sim/src/field/opponent-roster.ts';
import type { SkillData } from '../../sim/src/skill/types.ts';
import type { TrainedChara } from './deck.ts';

/**
 * 相手の名簿（`packages/sim/src/field/opponent-roster.ts`）の材料。
 *
 * 育成ウマ娘のデータ（`charas.json`）とスキルのデータから、カードごとに
 * 固有・継承固有・進化・覚醒で覚えるスキルを引き、得意脚質を推定する。
 * レースの計算には要らないので、`GameData` とは別に作る。
 * 型は sim 側にあり、ここで import するのは型だけである（ブラウザのバンドルに実体は入らない）。
 */

/** スキルを id と名前で引く表。`GameData` がそのまま当てはまる。 */
export interface RosterSkillSource {
  readonly skillsById: ReadonlyMap<string, SkillData>;
  readonly skillsByName: ReadonlyMap<string, readonly SkillData[]>;
}

function sourceOf(skills: readonly SkillData[] | RosterSkillSource): RosterSkillSource {
  if ('skillsById' in skills) return skills;
  const skillsById = new Map<string, SkillData>();
  const skillsByName = new Map<string, SkillData[]>();
  for (const skill of skills) {
    skillsById.set(skill.id, skill);
    const list = skillsByName.get(skill.name);
    if (list === undefined) skillsByName.set(skill.name, [skill]);
    else list.push(skill);
  }
  return { skillsById, skillsByName };
}

/** スキル条件の脚質の値（1 逃げ、2 先行、3 差し、4 追込）の並び */
const STYLE_OF_VALUE: readonly RosterStyle[] = ['NIGE', 'SEN', 'SASI', 'OI'];

/**
 * カード id から、固有スキルの id を組む。
 *
 * カード id は 6 桁で `'1' + キャラ番号 3 桁 + 衣装番号 2 桁`、
 * 固有は `'1' + (衣装番号 - 1) + キャラ番号 3 桁 + '1'` である
 * （102403 → 120241、102701 → 100271、110301 → 101031）。
 * 6 桁でないカードは null。
 */
export function uniqueIdOfCard(cardId: number): string | null {
  const text = String(cardId);
  if (text.length !== 6) return null;
  const costume = Number(text.slice(4));
  if (!(costume >= 1)) return null;
  return `1${costume - 1}${text.slice(1, 4)}1`;
}

/** 条件にある `running_style == 値` の数を、脚質ごとに数える。 */
function styleVotes(skills: Iterable<SkillData>): Record<RosterStyle, number> {
  const votes: Record<RosterStyle, number> = { NIGE: 0, SEN: 0, SASI: 0, OI: 0 };
  for (const skill of skills) {
    for (const invoke of skill.invokes) {
      for (const group of invoke.conditions) {
        for (const condition of group) {
          if (condition.type !== 'running_style' || condition.operator !== '==') continue;
          const style = STYLE_OF_VALUE[condition.value - 1];
          if (style !== undefined) votes[style]++;
        }
      }
    }
  }
  return votes;
}

/**
 * 得意脚質の推定。
 *
 * 上流のデータに適性が無いので、覚醒で覚えるスキルと進化スキルの発動条件に
 * 出てくる脚質を数え、最多のものとする。同数なら固有の発動条件で決め、
 * それでも決まらなければ同数の脚質をすべて返す。手掛かりが 1 つも無ければ空である
 * （その場合、名簿の候補にならない）。
 *
 * この実装を 268 枚に走らせた結果は、単一に決まるもの 247 枚、同数で複数残るもの 7 枚、
 * 手掛かりが無いもの 14 枚である（2026-10 時点のデータ。データが動けば変わる）。
 * ゲームの出走者の脚質との一致は、この実装では測っていない。外部の有効キャラ一覧（95 枚）との
 * 突き合わせで 87 枚が一致、6 枚が同数、3 枚が不一致だったという値は別実装のもので、ここでは再現していない。
 * 推定は推定なので、手元の名簿があるときは `parseRosterOverrides` で上書きする。
 */
function estimateStyles(
  learned: readonly SkillData[],
  unique: SkillData | undefined,
): RosterStyle[] {
  const votes = styleVotes(learned);
  const max = Math.max(...STYLE_OF_VALUE.map((style) => votes[style]));
  if (max === 0) return [];
  let top = STYLE_OF_VALUE.filter((style) => votes[style] === max);
  if (top.length > 1 && unique !== undefined) {
    const uniqueVotes = styleVotes([unique]);
    const best = Math.max(...top.map((style) => uniqueVotes[style]));
    if (best > 0) top = top.filter((style) => uniqueVotes[style] === best);
  }
  return top;
}

/**
 * 育成ウマ娘の全カードから、相手の名簿のカードを作る。
 *
 * 固有スキルを引けないカードは外す。引き方は 2 通りで、
 * まず id の規則（`uniqueIdOfCard`）、それで引けなければ持ち主がカード名と一致する固有が
 * 1 つだけのときそれにする。
 *
 * - 継承固有は、固有の id の先頭の `1` を `9` に替えた id が継承版として有ればそれ。
 * - 進化は、カード id に `111` と `211` を付けた id のうち進化スキルであるもの。
 *   `221` は 2 つ目の別の進化先なので入れない。
 * - 覚醒で覚えるスキルは、`charas.json` のスキル名から、通常版（白・金）を優先して引く。
 *   固有の名前は除く。データに無い名前（他のウマ娘へのデバフなど）は黙って飛ばす。
 */
export function buildRoster(
  charas: readonly TrainedChara[],
  skills: readonly SkillData[] | RosterSkillSource,
): OpponentRosterCard[] {
  const { skillsById, skillsByName } = sourceOf(skills);

  // 持ち主の名前から固有を引く表。id の規則で引けなかったカードの最後の手段である。
  const uniquesByHolder = new Map<string, SkillData[]>();
  for (const skill of skillsById.values()) {
    if (skill.rarity !== 'unique' || skill.holder === null) continue;
    const list = uniquesByHolder.get(skill.holder);
    if (list === undefined) uniquesByHolder.set(skill.holder, [skill]);
    else list.push(skill);
  }

  const cards: OpponentRosterCard[] = [];
  for (const chara of charas) {
    let unique: SkillData | undefined;
    const byRule = uniqueIdOfCard(chara.id);
    const ruled = byRule === null ? undefined : skillsById.get(byRule);
    if (ruled !== undefined && ruled.rarity === 'unique') {
      unique = ruled;
    } else {
      const holders = uniquesByHolder.get(chara.name);
      if (holders !== undefined && holders.length === 1) unique = holders[0];
    }
    if (unique === undefined) continue;

    const inherit = skillsById.get(`9${unique.id.slice(1)}`);
    const evos = ['111', '211']
      .map((suffix) => skillsById.get(`${chara.id}${suffix}`))
      .filter((skill): skill is SkillData => skill !== undefined && skill.rarity === 'evo');

    const awakening: SkillData[] = [];
    for (const name of chara.skills) {
      if (name === unique.name) continue;
      const found = (skillsByName.get(name) ?? []).find(
        (skill) => skill.rarity === 'normal' || skill.rarity === 'rare',
      );
      if (found !== undefined) awakening.push(found);
    }
    // 進化は 2 つ目の進化先（221）も、脚質の手掛かりにはする。
    const secondEvo = skillsById.get(`${chara.id}221`);
    const clues = secondEvo !== undefined && secondEvo.rarity === 'evo' ? [...evos, secondEvo] : evos;

    cards.push({
      id: chara.id,
      charaName: chara.charaName,
      name: chara.name,
      styles: estimateStyles([...awakening, ...clues], unique),
      uniqueId: unique.id,
      inheritId: inherit !== undefined && inherit.rarity === 'inherit' ? inherit.id : null,
      evoIds: evos.map((skill) => skill.id),
      awakeningIds: awakening.map((skill) => skill.id),
    });
  }
  return cards;
}

/** 読み込みの結果 */
export interface RosterOverrides {
  /** 載っていたカードだけ。styles はその 1 つに、score は書かれていれば上書きしてある。 */
  readonly cards: OpponentRosterCard[];
  /** 読めた行（JSON なら要素）の数 */
  readonly parsed: number;
  /** 読めずに飛ばした行（JSON なら要素）の数。空行は数えない。 */
  readonly skipped: number;
}

const STYLE_WORDS: readonly (readonly [RosterStyle, RegExp])[] = [
  ['NIGE', /^(逃げ|逃|NIGE)$/i],
  ['SEN', /^(先行|先|SEN)$/i],
  ['SASI', /^(差し|差|SASI)$/i],
  ['OI', /^(追込|追い込み|追込み|追|OI)$/i],
];

/** 脚質の語 1 つ（完全一致）から脚質を引く。 */
function styleOfWord(word: string): RosterStyle | null {
  const text = word.trim();
  for (const [style, pattern] of STYLE_WORDS) if (pattern.test(text)) return style;
  return null;
}

/**
 * 行から脚質を読む。
 *
 * まず、区切りで割った語のうち完全に一致するものを探す。`中A/芝A/差し` のような
 * 複合の欄は `/` で割ってから見る。それで見つからなければ、行のどこかにある語を拾う
 * （カード名に脚質の語が入っていても先に取られないよう、完全一致を先にする）。
 */
function styleOfLine(line: string): RosterStyle | null {
  for (const token of line.split(/[\t,，、\s]+/)) {
    for (const part of token.split(/[/／・]/)) {
      const style = styleOfWord(part);
      if (style !== null) return style;
    }
  }
  // 英字の語は完全一致でしか拾わない。カード名の中の OI や SEN を脚質と取り違えないためである。
  const found = /(逃げ|先行|差し|追込|追い込み)/.exec(line);
  return found === null ? null : styleOfWord(found[1]!);
}

/** 行から 6 桁のカード id を読む。名簿に無い数字は飛ばす。小数の一部は拾わない。 */
function cardIdOfLine(line: string, known: ReadonlyMap<number, OpponentRosterCard>): number | null {
  for (const match of line.matchAll(/(?<![\d.])\d{6}(?!\d)/g)) {
    const id = Number(match[0]);
    if (known.has(id)) return id;
  }
  return null;
}

/** 行にある小数点つきの数の、最後のもの。無ければ undefined。 */
function scoreOfLine(line: string): number | undefined {
  const numbers = line.match(/-?\d+\.\d+/g);
  if (numbers === null) return undefined;
  const value = Number(numbers[numbers.length - 1]);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * 利用者が手元の名簿を渡すための読み込み。
 *
 * 脚質の推定が外れうるので、実際の出走者の名簿があるときはそれで上書きする。形は 2 通りで、
 *
 * - JSON の配列 `[{ "cardId": 109701, "style": "SEN", "score": 9.5 }]`。
 *   style は NIGE/SEN/SASI/OI か、逃げ/先行/差し/追込。score は省ける。
 * - 行ごとのテキスト（タブ区切りなど）。行ごとに、名簿（`cards`）にある 6 桁のカード id、
 *   脚質の語（`中A/芝A/差し` のような複合の中にあってもよい）、小数点を含む数の最後のものを
 *   score として拾う。
 *   例: `1<TAB>109701<TAB>通常スティル<TAB>中A/芝A/差し<TAB>x1.05<TAB>9.50091`
 *
 * 載っているカードだけを残し、styles をその 1 つにする。読めない行は飛ばす。
 * 同じカードが複数あれば、あとのものが勝つ。
 */
export function parseRosterOverrides(
  text: string,
  cards: readonly OpponentRosterCard[],
): RosterOverrides {
  const known = new Map(cards.map((card) => [card.id, card] as const));
  const entries = new Map<number, { style: RosterStyle; score: number | undefined }>();
  let parsed = 0;
  let skipped = 0;

  const json = readJson(text);
  if (json !== null) {
    for (const item of json) {
      const record = item as { cardId?: unknown; style?: unknown; score?: unknown } | null;
      const id = Number(record?.cardId);
      const style =
        typeof record?.style === 'string'
          ? styleOfWord(record.style)
          : typeof record?.style === 'number'
            ? (STYLE_OF_VALUE[record.style - 1] ?? null)
            : null;
      if (!known.has(id) || style === null) {
        skipped++;
        continue;
      }
      const score = typeof record?.score === 'number' && Number.isFinite(record.score) ? record.score : undefined;
      entries.set(id, { style, score });
      parsed++;
    }
  } else {
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === '') continue;
      const id = cardIdOfLine(line, known);
      const style = styleOfLine(line);
      if (id === null || style === null) {
        skipped++;
        continue;
      }
      entries.set(id, { style, score: scoreOfLine(line) });
      parsed++;
    }
  }

  const result: OpponentRosterCard[] = [];
  for (const [id, entry] of entries) {
    const card = known.get(id)!;
    const score = entry.score ?? card.score;
    result.push({ ...card, styles: [entry.style], ...(score === undefined ? {} : { score }) });
  }
  return { cards: result, parsed, skipped };
}

/** 先頭が `[` なら JSON の配列として読む。読めなければ null（テキストとして扱う）。 */
function readJson(text: string): unknown[] | null {
  if (!text.trimStart().startsWith('[')) return null;
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
