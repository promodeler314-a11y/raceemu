import type { GameData } from '../../../packages/data/src/index.ts';
import { loadGameData } from '../../../packages/data/src/browser.ts';
import type { SkillData } from '../../../packages/sim/src/skill/types.ts';

/**
 * キャラと固有スキルの扱い。
 *
 * 本家は固有と進化をキャラの側から選ばせ、一覧には出さない
 * （`compose/.../race/SkillInput.kt` の `notUniqueSkills`）。
 * 固有はキャラが持つものであって、一覧から拾ってくるものではないからである。
 * 移植版は一覧に全レア度を混ぜていたため、誰の固有なのかが画面に出ず、
 * 別のキャラの固有を同時に持てた。ここでその規則を本家に合わせる。
 *
 * 名前が同じスキルが 266 組ある。すべて固有とその継承版（レア度 `inherit`）
 * であり、一覧から固有を外すと名前の衝突も消える。
 */

/** 未選択を表す値。本家の `NOT_SELECTED` にあたる。 */
export const NO_CHARA = '';

/**
 * レア度の表示名。データの値（`normal` `inherit` など）は内部の名前なので、
 * 画面にはそのまま出さない（docs/ui-audit-race-emulator.md 第1節「内部の値」）。
 * 知らない値が来たら、表に足すまでのあいだは空にする。英語を出すよりよい。
 */
const RARITY_LABEL: Record<string, string> = {
  normal: '通常',
  rare: 'レア',
  unique: '固有',
  inherit: '継承',
  evo: '進化',
  special: '特殊',
  scenario: 'シナリオ',
  minus: 'マイナス',
};

export function rarityLabel(rarity: string): string {
  return RARITY_LABEL[rarity] ?? '';
}

export interface SkillIndex {
  /** キャラの一覧。ウマ娘名で並べる（勝負服名は先頭に付くので飛ばす）。 */
  readonly charas: readonly string[];
  /** 一覧に出すスキル。固有と進化はキャラの側から選ぶので含まない。 */
  readonly selectable: readonly SkillData[];
  /** そのキャラの固有。1 つのことが多いが、22 キャラは 2 つ持つ。 */
  uniquesOf(chara: string): readonly SkillData[];
  /** そのキャラの進化スキル。 */
  evosOf(chara: string): readonly SkillData[];
  /** 持っているスキルからキャラを引く。固有か進化を持っていれば決まる。 */
  charaOf(skillIds: readonly string[]): string;
  /**
   * キャラを変える。前のキャラの固有と進化を外し、新しいキャラの固有を入れる。
   *
   * 同じ名前の継承版も外す。本家と同じく、自分の固有と、その継承版を同時には
   * 持てない（`SkillOperation.kt` の `setCharaName`）。
   * 進化は入れない。取るかどうかは本人が決める。
   */
  applyChara(skillIds: readonly string[], chara: string): string[];
  /**
   * スキルの持ち替え。入れるときは同じグループのものを外す。
   *
   * グループは上位下位の系列であり、「右回り○」と「右回り◎」を同時には
   * 持てない。固有どうしも、キャラが 1 人である以上は同時に持てない。
   */
  toggle(skillIds: readonly string[], id: string): string[];
}

export function buildSkillIndex(data: GameData): SkillIndex {
  const uniques = new Map<string, SkillData[]>();
  const evos = new Map<string, SkillData[]>();
  const selectable: SkillData[] = [];
  for (const skill of data.skills) {
    const target =
      skill.rarity === 'unique' ? uniques : skill.rarity === 'evo' ? evos : undefined;
    if (target === undefined) {
      selectable.push(skill);
      continue;
    }
    // 持ち主が落ちているデータでも、固有と進化を一覧に混ぜることはしない。
    if (skill.holder === null) continue;
    const list = target.get(skill.holder);
    if (list === undefined) target.set(skill.holder, [skill]);
    else list.push(skill);
  }

  const charas = [...new Set([...uniques.keys(), ...evos.keys()])].sort((a, b) =>
    shortCharaName(a).localeCompare(shortCharaName(b), 'ja'),
  );

  const uniquesOf = (chara: string): readonly SkillData[] => uniques.get(chara) ?? [];
  const evosOf = (chara: string): readonly SkillData[] => evos.get(chara) ?? [];

  const holderOf = (id: string): string | null => data.skillsById.get(id)?.holder ?? null;

  return {
    charas,
    selectable,
    uniquesOf,
    evosOf,

    charaOf: (skillIds) => {
      for (const id of skillIds) {
        const holder = holderOf(id);
        if (holder !== null) return holder;
      }
      return NO_CHARA;
    },

    applyChara: (skillIds, chara) => {
      const added = uniquesOf(chara).at(-1);
      const names = new Set(uniquesOf(chara).map((skill) => skill.name));
      const kept = skillIds.filter((id) => {
        const skill = data.skillsById.get(id);
        if (skill === undefined) return false;
        return skill.holder === null && !names.has(skill.name);
      });
      return added === undefined ? kept : [...kept, added.id];
    },

    toggle: (skillIds, id) => {
      if (skillIds.includes(id)) return skillIds.filter((x) => x !== id);
      const skill = data.skillsById.get(id);
      if (skill === undefined) return [...skillIds];
      const kept = skillIds.filter((held) => {
        const other = data.skillsById.get(held);
        if (other === undefined) return false;
        if (other.group === skill.group) return false;
        return !(skill.rarity === 'unique' && other.rarity === 'unique');
      });
      return [...kept, id];
    },
  };
}

/**
 * `[勝負服]ウマ娘名` からウマ娘名を取る。
 *
 * 並べ替えと、画面に出す短い呼び名に使う。キャラの値そのものは勝負服ごとに
 * 違うので、選択欄や照合には元の値を使うこと。勝負服の付かない名前はそのまま返す。
 */
export function shortCharaName(holder: string): string {
  const end = holder.indexOf(']');
  return end < 0 ? holder : holder.slice(end + 1);
}

/**
 * 出走表と着順の表で使う呼び名。
 *
 * `index` は出走の並び（0 が自分、1 から相手）である。自分は名前があれば
 * 「自分（ウマ娘名）」、無ければ「自分」。相手は名前があればウマ娘名、
 * 無ければ出走の番号で「N 番」と呼ぶ（N は `index + 1`）。
 * 勝負服は表の幅に収まらないので落とす。同じ名前が並んでも、表は出走の番号も
 * 一緒に出すので見分けは付く。
 */
export function entryLabel(index: number, charaName: string): string {
  const name = shortCharaName(charaName);
  if (index === 0) return name === '' ? '自分' : `自分（${name}）`;
  return name === '' ? `${index + 1} 番` : name;
}

export const gameData = loadGameData();
export const skillIndex = buildSkillIndex(gameData);

/** 検索の候補。同じ名前のものが残らないので、名前ではなく ID で持つ。 */
export const skillChoices = [...skillIndex.selectable].sort((a, b) =>
  a.name.localeCompare(b.name, 'ja'),
);
