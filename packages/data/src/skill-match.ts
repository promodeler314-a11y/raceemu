import type { SkillData } from '../../sim/src/skill/types.ts';

/**
 * 読み取った文字列からスキルを引く。
 *
 * 画面から読んだ文字は、そのままではスキル名と一致しない。
 * 実際に見た崩れ方は二通りある。
 *
 * - **書き分けの揺れ**：丸印が `○` と `〇` のどちらにもなる。文字のあいだに空白が入る。
 * - **文字の取り違え**：`一匹狼` が `ー忠狼` になる。
 *
 * 前者は正規化で消える。後者は消えないので、距離で近いものを拾う。
 * docs/ocr-design.md を参照。
 */

/** 見た目が同じで符号位置が違う文字を 1 つに寄せる */
const CONFUSABLE: Readonly<Record<string, string>> = {
  // 丸印。スキル名は ○ を使うが、読み取りでは 〇（漢数字のゼロ）や ◯ になる。
  '〇': '○', '◯': '○', '○': '○', 'O': '○', 'o': '○', '0': '○', '°': '○',
  // 二重丸
  '◉': '◎', '◎': '◎',
  // 長音と横棒と漢数字の一。読み取りでは互いに入れ替わる（`一匹狼` が `ー忠狼` になった）。
  // 全 2106 件の名前でこの 2 つを同一視しても、区別が付かなくなる組は無い。
  'ー': '一', '－': '一', '‐': '一', '−': '一', '—': '一', '―': '一', '─': '一', '-': '一',
};

/**
 * 比較用の形に直す。
 *
 * 互換文字を潰し、空白を落とし、見た目の同じ文字を寄せる。
 * 濁点は分解されると 1 文字ぶん距離が増えるので、合成済みに揃える。
 */
export function normalizeSkillName(text: string): string {
  let out = '';
  for (const char of text.normalize('NFKC')) {
    if (/\s/u.test(char)) continue;
    out += CONFUSABLE[char] ?? char;
  }
  return out;
}

/** レーベンシュタイン距離。名前は長くても 20 文字程度なので素直に求める。 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = [...Array(b.length + 1).keys()];
  let current = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + cost);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length]!;
}

export interface SkillMatch {
  readonly skill: SkillData;
  /** 読み取った行のうち、この一致に使った部分 */
  readonly text: string;
  /** 0 から 1。1 なら正規化して完全一致。 */
  readonly score: number;
  /** 2 番目の候補との差。小さいほど紛らわしい。 */
  readonly margin: number;
  /** 2 番目の候補。紛らわしいときに画面で出す。 */
  readonly runnerUp: SkillData | null;
}

export interface MatchOptions {
  /** これを下回る一致は捨てる */
  readonly minScore?: number;
  /**
   * 短い名前に要求する一致の下限。
   *
   * 3 文字の名前は 1 文字違うだけで score が 0.67 まで落ちる一方、
   * 別の 3 文字の名前とも同じくらい近くなる。長い名前より厳しくする。
   */
  readonly shortNameLength?: number;
  readonly shortNameMinScore?: number;
}

const DEFAULTS = { minScore: 0.6, shortNameLength: 4, shortNameMinScore: 0.75 } as const;

/**
 * 引ける形にしたスキルの索引。
 * 行ごとに 2000 件と比べるので、正規化した名前は作り置きする。
 */
export class SkillMatcher {
  private readonly entries: { readonly skill: SkillData; readonly key: string }[];

  constructor(skills: Iterable<SkillData>, private readonly options: MatchOptions = {}) {
    this.entries = [];
    for (const skill of skills) {
      const key = normalizeSkillName(skill.name);
      if (key === '') continue;
      this.entries.push({ skill, key });
    }
  }

  /** 1 行に最も近いスキルを返す。近いものが無ければ null。 */
  match(line: string): SkillMatch | null {
    const key = normalizeSkillName(line);
    if (key === '') return null;
    const minScore = this.options.minScore ?? DEFAULTS.minScore;
    const shortLength = this.options.shortNameLength ?? DEFAULTS.shortNameLength;
    const shortMinScore = this.options.shortNameMinScore ?? DEFAULTS.shortNameMinScore;

    let best: { skill: SkillData; score: number } | null = null;
    let second: { skill: SkillData; score: number } | null = null;
    for (const entry of this.entries) {
      // 長さが大きく違うものは比べるまでもない
      if (Math.abs(entry.key.length - key.length) > Math.max(2, key.length * 0.5)) continue;
      const distance = editDistance(key, entry.key);
      const score = 1 - distance / Math.max(key.length, entry.key.length);
      if (best === null || score > best.score) {
        second = best;
        best = { skill: entry.skill, score };
      } else if (second === null || score > second.score) {
        second = { skill: entry.skill, score };
      }
    }
    if (best === null) return null;
    const required = key.length <= shortLength ? Math.max(minScore, shortMinScore) : minScore;
    if (best.score < required) return null;
    return {
      skill: best.skill,
      text: line,
      score: best.score,
      margin: second === null ? 1 : best.score - second.score,
      runnerUp: second?.skill ?? null,
    };
  }

  /**
   * 読み取った全文からスキルを拾う。
   *
   * 行ごとに引き、同じスキルが複数の行に当たったら最も近い行だけを残す。
   * 画面には同じスキルが二度出ないためである。
   */
  matchAll(text: string, options: { readonly maxLines?: number } = {}): SkillMatch[] {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .slice(0, options.maxLines ?? 200);
    const bySkill = new Map<string, SkillMatch>();
    for (const line of lines) {
      const found = this.match(line);
      if (found === null) continue;
      const kept = bySkill.get(found.skill.id);
      if (kept === undefined || found.score > kept.score) bySkill.set(found.skill.id, found);
    }
    return [...bySkill.values()].sort((a, b) => b.score - a.score);
  }
}
