import type { SkillData } from '../../sim/src/skill/types.ts';
import { editDistance, normalizeSkillName } from './skill-match.ts';

/**
 * スキル名から ID を引く。出走表の書き起こしを、計算できる形にするための規則である。
 *
 * `skill-match.ts` の `SkillMatcher` は、文字認識の崩れを近い名前で拾って**当てにいく**。
 * ここでは逆に、**完全一致（正規化後）だけを採り、近い名前は候補として返すだけ**にする。
 * 短い名前が 1 文字違いで別のスキルに当たるので（docs/ocr-design.md 2 節と 3 節）、
 * 読み違えたまま黙って別のスキルを走らせると、結果が静かに狂うためである。
 * docs/mcp-design.md 3.2 節を参照。
 */

/** 同じ名前が複数あるときに選ぶ順序。小さいほど先に採る。固有は別枠で扱う。 */
const RARITY_PRIORITY: Readonly<Record<string, number>> = {
  evo: 0,
  rare: 1,
  normal: 2,
  inherit: 3,
  special: 4,
  scenario: 5,
};

/** 候補として返す近い名前の数 */
const NEAREST_COUNT = 3;

export interface SkillCandidate {
  readonly id: string;
  readonly name: string;
  readonly rarity: string;
  readonly sp: number;
  /** 固有と進化の持ち主（`[勝負服]ウマ娘名`）。それ以外は null */
  readonly holder: string | null;
  /** 0 から 1。1 なら正規化して完全一致。 */
  readonly score: number;
}

export type UnresolvedReason =
  /** 名前に当たるスキルが無い */
  | 'not_found'
  /** 他のウマ娘の固有スキルで、継承版が無い */
  | 'unique_only'
  /** 固有スキルの名前は当たるが、持ち主が出走表の `chara` と違う */
  | 'holder_mismatch';

export type SkillResolution =
  | {
      readonly status: 'resolved';
      /** 入力された名前（または ID） */
      readonly input: string;
      readonly skill: SkillData;
      /** 固有として採ったか */
      readonly asUnique: boolean;
      /** 同じ名前の、採らなかったスキル。継承版と継承進化版のように、画像では見分けられないものを知らせる。 */
      readonly alternatives: readonly SkillData[];
    }
  | {
      readonly status: 'unresolved';
      readonly input: string;
      readonly reason: UnresolvedReason;
      readonly candidates: readonly SkillCandidate[];
    };

export type WarningCode =
  /** 同じスキルが 2 回あった（1 つに畳んだ） */
  | 'duplicate'
  /** 同じグループのスキルを 2 つ持っている。上位と下位は同時に持てない */
  | 'same_group'
  /** 固有スキルが見つからない、または持ち主が違う */
  | 'unique_unresolved'
  /** 同じ名前の継承版と継承進化版があり、画像では見分けられない */
  | 'ambiguous_variant'
  /** `chara` に複数の勝負服が当たる */
  | 'ambiguous_chara';

export interface SkillWarning {
  readonly code: WarningCode;
  readonly message: string;
  /** 関わるスキル名 */
  readonly names: readonly string[];
}

export interface LineupSkillsInput {
  /** `[勝負服]ウマ娘名` またはウマ娘名。固有スキルの持ち主 */
  readonly chara?: string;
  /** 固有スキルの名前 */
  readonly unique?: string;
  /** 所持スキルの名前。ID（数字だけの文字列）でもよい */
  readonly skills: readonly string[];
}

export interface LineupSkills {
  /** 入力した順の解決結果。固有が先頭に来る。画像と見比べられるように、畳む前のまま並べる。 */
  readonly entries: readonly SkillResolution[];
  /** 採ったスキル。重複は畳んである。固有、所持スキルの順。 */
  readonly skills: readonly SkillData[];
  readonly unresolved: readonly Extract<SkillResolution, { status: 'unresolved' }>[];
  readonly warnings: readonly SkillWarning[];
}

/** `[勝負服]` を落としたウマ娘名 */
function charaNameOf(holder: string): string {
  return holder.replace(/^\[[^\]]*\]/, '');
}

export class SkillResolver {
  private readonly byName = new Map<string, SkillData[]>();
  private readonly byId = new Map<string, SkillData>();
  private readonly entries: { readonly skill: SkillData; readonly key: string }[] = [];

  constructor(skills: Iterable<SkillData>) {
    for (const skill of skills) {
      const key = normalizeSkillName(skill.name);
      if (key === '') continue;
      this.byId.set(skill.id, skill);
      const list = this.byName.get(key);
      if (list === undefined) this.byName.set(key, [skill]);
      else list.push(skill);
      this.entries.push({ skill, key });
    }
  }

  /** ID からスキル名を引く。無ければ null。 */
  nameOf(id: string): string | null {
    return this.byId.get(id)?.name ?? null;
  }

  /** 名前に近いスキル。名前の重複は畳み、近い順に返す。 */
  nearest(name: string, limit = NEAREST_COUNT): SkillCandidate[] {
    const key = normalizeSkillName(name);
    if (key === '') return [];
    const best = new Map<string, SkillCandidate>();
    for (const entry of this.entries) {
      const score = 1 - editDistance(key, entry.key) / Math.max(key.length, entry.key.length);
      const previous = best.get(entry.skill.name);
      // 同じ名前（固有と継承版など）は 1 件にして、候補の枠を使い切らないようにする。
      if (previous !== undefined && (RARITY_PRIORITY[previous.rarity] ?? 9) <= (RARITY_PRIORITY[entry.skill.rarity] ?? 9)) {
        continue;
      }
      best.set(entry.skill.name, toCandidate(entry.skill, score));
    }
    return [...best.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
  }

  /**
   * 名前で探す。完全一致を先に、続いて部分一致、最後に近い名前を返す。
   * 画像の読み取りと関係なく、スキルを調べるのに使う。
   */
  search(query: string, limit = 10): SkillCandidate[] {
    const key = normalizeSkillName(query);
    if (key === '') return [];
    const exact = this.byName.get(key);
    if (exact !== undefined) return exact.map((skill) => toCandidate(skill, 1)).slice(0, limit);
    const partial = this.entries
      .filter((entry) => entry.key.includes(key))
      .map((entry) => toCandidate(entry.skill, key.length / entry.key.length));
    if (partial.length > 0) return partial.sort((a, b) => b.score - a.score).slice(0, limit);
    return this.nearest(query, limit);
  }

  /** 1 つの名前を引く。`own` に持ち主を渡すと、その固有スキルを固有として採る。 */
  resolve(input: string, own?: { readonly chara: string | undefined }): SkillResolution {
    const trimmed = input.trim();
    // ID を直接指す逃げ道。名前では見分けられない継承進化版などに使う。
    if (/^\d+$/.test(trimmed)) {
      const byId = this.byId.get(trimmed);
      if (byId !== undefined) return { status: 'resolved', input, skill: byId, asUnique: byId.rarity === 'unique', alternatives: [] };
    }
    const matches = this.byName.get(normalizeSkillName(trimmed)) ?? [];
    if (matches.length === 0) {
      return { status: 'unresolved', input, reason: 'not_found', candidates: this.nearest(trimmed) };
    }

    const uniques = matches.filter((skill) => skill.rarity === 'unique');
    if (own !== undefined && uniques.length > 0) {
      const mine = uniques.filter((skill) => ownedBy(skill, own.chara));
      if (mine.length > 0) {
        return { status: 'resolved', input, skill: mine[0]!, asUnique: true, alternatives: mine.slice(1) };
      }
    }
    const others = matches
      .filter((skill) => skill.rarity !== 'unique')
      .sort((a, b) => (RARITY_PRIORITY[a.rarity] ?? 9) - (RARITY_PRIORITY[b.rarity] ?? 9));
    if (others.length > 0) {
      return { status: 'resolved', input, skill: others[0]!, asUnique: false, alternatives: others.slice(1) };
    }
    // 固有しか無い。持ち主を指定していて当たらなかったのか、他のウマ娘の固有で継承版が無いのか。
    return {
      status: 'unresolved',
      input,
      reason: own !== undefined ? 'holder_mismatch' : 'unique_only',
      candidates: uniques.map((skill) => toCandidate(skill, 1)),
    };
  }

  /** 出走表 1 頭ぶんのスキルをまとめて引く。固有は持ち主と照合し、重複と同じグループを点検する。 */
  resolveLineup(input: LineupSkillsInput): LineupSkills {
    const entries: SkillResolution[] = [];
    const warnings: SkillWarning[] = [];

    if (input.unique !== undefined && input.unique.trim() !== '') {
      const own = { chara: input.chara };
      const hit = this.resolve(input.unique, own);
      entries.push(hit);
      if (hit.status === 'unresolved') {
        warnings.push({
          code: 'unique_unresolved',
          message:
            hit.reason === 'not_found'
              ? `固有スキル「${input.unique}」が見つかりません。`
              : `固有スキル「${input.unique}」の持ち主が chara（${input.chara ?? '未指定'}）と合いません。持ち主: ${hit.candidates.map((c) => c.holder ?? '不明').join('、')}`,
          names: [input.unique],
        });
      } else if (!hit.asUnique) {
        // 名前は当たったが固有として採れず、他のレア度に当たった。持ち主の指定を疑う。
        warnings.push({
          code: 'unique_unresolved',
          message: `「${input.unique}」は固有スキルとして採れず、${hit.skill.rarity} として採りました。chara（${input.chara ?? '未指定'}）が持ち主と合っているか確かめてください。`,
          names: [input.unique],
        });
      } else if (hit.alternatives.length > 0) {
        warnings.push({
          code: 'ambiguous_chara',
          message: `固有スキル「${input.unique}」の持ち主が複数に当たります。先頭を採りました: ${[hit.skill, ...hit.alternatives].map((s) => s.holder ?? '不明').join('、')}`,
          names: [input.unique],
        });
      }
    }

    for (const name of input.skills) {
      const hit = this.resolve(name);
      entries.push(hit);
      if (
        hit.status === 'resolved' &&
        hit.skill.rarity === 'inherit' &&
        hit.alternatives.some((alt) => alt.rarity === 'special')
      ) {
        warnings.push({
          code: 'ambiguous_variant',
          message: `「${name}」には継承版（${hit.skill.id}）と継承進化版（${hit.alternatives.find((a) => a.rarity === 'special')!.id}）があり、画像では見分けられません。継承版を採りました。継承進化版なら ID（数字）で指定してください。`,
          names: [name],
        });
      }
    }

    // 採ったスキル。同じスキルは 1 つに畳む。
    const picked: SkillData[] = [];
    const seen = new Map<string, string[]>();
    for (const entry of entries) {
      if (entry.status !== 'resolved') continue;
      const names = seen.get(entry.skill.id);
      if (names !== undefined) {
        names.push(entry.input);
        continue;
      }
      seen.set(entry.skill.id, [entry.input]);
      picked.push(entry.skill);
    }
    for (const [id, names] of seen) {
      if (names.length < 2) continue;
      const skill = this.byId.get(id)!;
      warnings.push({
        code: 'duplicate',
        message: `「${skill.name}」が ${names.length} 回あります。1 つに畳みました。画像のつなぎ目で行が重なっていないか確かめてください。`,
        names: [skill.name],
      });
    }

    // 同じグループを 2 つ持つことはない。読み違いの疑いが強い。
    const byGroup = new Map<number, SkillData[]>();
    for (const skill of picked) {
      const list = byGroup.get(skill.group);
      if (list === undefined) byGroup.set(skill.group, [skill]);
      else list.push(skill);
    }
    for (const list of byGroup.values()) {
      if (list.length < 2) continue;
      warnings.push({
        code: 'same_group',
        message: `同じグループのスキルを 2 つ持っています: ${list.map((s) => `${s.name}（${s.id}）`).join('、')}。上位と下位は同時に持てないので、どちらかの読み違いかもしれません。`,
        names: list.map((s) => s.name),
      });
    }

    return {
      entries,
      skills: picked,
      unresolved: entries.filter((e): e is Extract<SkillResolution, { status: 'unresolved' }> => e.status === 'unresolved'),
      warnings,
    };
  }
}

function toCandidate(skill: SkillData, score: number): SkillCandidate {
  return { id: skill.id, name: skill.name, rarity: skill.rarity, sp: skill.sp, holder: skill.holder, score };
}

/**
 * 固有スキルの持ち主か。
 * `chara` が `[勝負服]ウマ娘名` ならその勝負服だけ、ウマ娘名だけなら全部の勝負服が当たる。
 */
function ownedBy(skill: SkillData, chara: string | undefined): boolean {
  if (chara === undefined || chara.trim() === '' || skill.holder === null) return false;
  const want = normalizeSkillName(chara);
  if (chara.trim().startsWith('[')) return normalizeSkillName(skill.holder) === want;
  return normalizeSkillName(charaNameOf(skill.holder)) === want;
}
