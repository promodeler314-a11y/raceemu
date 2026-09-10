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
    nameOf(a).localeCompare(nameOf(b), 'ja'),
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

/** `[勝負服]ウマ娘名` からウマ娘名を取る。並べ替えに使う。 */
function nameOf(holder: string): string {
  const end = holder.indexOf(']');
  return end < 0 ? holder : holder.slice(end + 1);
}

export const gameData = loadGameData();
export const skillIndex = buildSkillIndex(gameData);

/** 検索の候補。同じ名前のものが残らないので、名前ではなく ID で持つ。 */
export const skillChoices = [...skillIndex.selectable].sort((a, b) =>
  a.name.localeCompare(b.name, 'ja'),
);
