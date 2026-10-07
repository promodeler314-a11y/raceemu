import type { OpponentRanking, RosterStyle } from '../../sim/src/field/opponent-roster.ts';
import {
  skillListRowAt,
  type SkillListCourseFile,
  type SkillListTier,
} from './skill-list.ts';

/**
 * スキル一覧のコース 1 枚から、相手の名簿（`packages/sim/src/field/opponent-roster.ts`）が
 * 使う順位表を作る。
 *
 * 名簿の相手は「そのコース・脚質で効くスキル」を効き ÷ SP の順に買う。
 * その効きに、事前計算済みの単体評価（`skill-list.ts`）をそのまま使う。新しく測り直さない。
 * 読み方は `skillListRowAt` の既存の口で、ここに解析器は無い。
 *
 * **値は `defaultFieldProfile` の相手に対して測ったものである。** 名簿の相手はそれより強いが、
 * 順位表に要るのは大小関係なので、そのまま使う。一覧は相手の作り方を変えると作り直しになる
 * （`SkillListDataset.fieldProfile`）。
 *
 * ブラウザでも動く（`node:fs` を読まない）。ファイルを探して読む側は `skill-list-index.ts`。
 */

const STYLES: readonly RosterStyle[] = ['NIGE', 'SEN', 'SASI', 'OI'];

/**
 * 順位表に使う基準個体の段。強い段があればそれ、無ければ普通の段。
 *
 * 相手は育成を終えた個体なので、強い段の効き方のほうが近い。
 */
export function opponentRankingTier(file: SkillListCourseFile): SkillListTier | null {
  const ids = new Set(file.baselines.map((baseline) => baseline.id));
  if (ids.has('strong')) return 'strong';
  if (ids.has('normal')) return 'normal';
  return null;
}

/**
 * 順位表を作る。脚質ごとに短縮量（`mean`、秒）の降順。
 *
 * - 条件を落としているスキル（`fidelity` が `dropped`）は除く。落とした条件は満たしている扱いに
 *   なるので、効きが過大に出る。相手に配ると相手が強くなりすぎる。
 * - 短縮量が負のものも順位表には残す（並びは降順なので末尾に来る）。買うかどうかは名簿の側が
 *   決める（白・金・緑は 0 より大きいものだけを買う。継承固有はそのまま上位から引く）。
 * - 脚質は 4 つとも必ず配列を持つ。行が 1 つも無い脚質は空配列になる。
 *   名簿は `ranking[style]` を直に引くので、欠けていると落ちる。
 *
 * `tier` を省くと `opponentRankingTier` の段を使う。どちらの段も無いファイルは、
 * 4 脚質とも空の順位表になる。
 */
export function opponentRankingFromSkillList(
  file: SkillListCourseFile,
  tier: SkillListTier | null = opponentRankingTier(file),
): OpponentRanking {
  const lists: Record<RosterStyle, (readonly [skillId: string, value: number])[]> = {
    NIGE: [],
    SEN: [],
    SASI: [],
    OI: [],
  };
  if (tier !== null) {
    for (let i = 0; i < file.columns.length; i++) {
      const row = skillListRowAt(file, i);
      if (row.baseline !== tier || row.fidelity === 'dropped') continue;
      // 大逃げは一覧に無い。名簿の枠も大逃げを逃げとして引くので、ここでは 4 脚質だけ見る。
      if (row.style === 'OONIGE') continue;
      const list = lists[row.style];
      list.push([row.skillId, row.mean]);
    }
  }
  for (const style of STYLES) {
    // 同じ値のときは id の小さい順にして、ファイルの行の並びに依らないようにする。
    lists[style].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
  return lists;
}
