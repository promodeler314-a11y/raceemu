import { SkillResolver, type LineupSkills, type SkillResolution } from '../../../packages/data/src/skill-resolve.ts';
import {
  checkAptitude,
  checkStatusRank,
  chooseStyle,
  STYLE_LABEL,
  type LineupIssue,
  type LineupRunner,
  type StyleChoice,
} from '../../../packages/sim/src/multi/lineup.ts';
import { isIndividualRef, toLineupRunner, type LineupEntry } from './schemas.ts';

/**
 * 出走表の点検。`check_lineup`、`win_rate`、`skill_gain`、`save_individual` が同じ手順を通る。
 * スキル名の解決と、ステータスと適性の点検を、頭ごとにまとめる。docs/mcp-design.md 3.7 節。
 */

/** 保存した個体を引く口。個体の保存（3.8 節）が入るまでは、何も引けない。 */
export interface IndividualLookup {
  /** `id` または呼び名で引く。複数に当たるときは候補を返す。 */
  find(key: string): {
    readonly runners: readonly {
      id: string;
      label: string;
      runner: LineupRunner;
      /** 保存したときに解決したスキルの ID */
      skillIds: readonly string[];
    }[];
  };
}

export const NO_INDIVIDUALS: IndividualLookup = { find: () => ({ runners: [] }) };

export interface PreparedRunner {
  /** 入力の添字 */
  readonly index: number;
  readonly runner: LineupRunner;
  /** 保存した個体から引いたときの id */
  readonly individualId: string | null;
  readonly skills: LineupSkills;
  readonly style: StyleChoice;
  /** 点検で見つかったもの。スキルの警告は `skills.warnings` に別に持つ */
  readonly issues: readonly LineupIssue[];
}

export type PrepareFailure =
  | { readonly kind: 'individual_not_found'; readonly index: number; readonly key: string }
  | {
      readonly kind: 'individual_ambiguous';
      readonly index: number;
      readonly key: string;
      readonly candidates: readonly { id: string; label: string }[];
    };

export interface PreparedLineup {
  readonly runners: readonly PreparedRunner[];
  readonly failures: readonly PrepareFailure[];
}

export function prepareLineup(
  entries: readonly LineupEntry[],
  resolver: SkillResolver,
  individuals: IndividualLookup,
): PreparedLineup {
  const runners: PreparedRunner[] = [];
  const failures: PrepareFailure[] = [];
  entries.forEach((entry, index) => {
    let runner: LineupRunner;
    let individualId: string | null = null;
    let storedIds: readonly string[] | null = null;
    if (isIndividualRef(entry)) {
      const found = individuals.find(entry.individual).runners;
      if (found.length === 0) {
        failures.push({ kind: 'individual_not_found', index, key: entry.individual });
        return;
      }
      if (found.length > 1) {
        failures.push({
          kind: 'individual_ambiguous',
          index,
          key: entry.individual,
          candidates: found.map(({ id, label }) => ({ id, label })),
        });
        return;
      }
      const hit = found[0]!;
      individualId = hit.id;
      storedIds = hit.skillIds;
      // 上書きできるのは、脚質と、やる気と、評価点だけ。
      runner = {
        ...hit.runner,
        ...(entry.style !== undefined ? { style: entry.style } : {}),
        ...(entry.condition !== undefined ? { condition: entry.condition } : {}),
        ...(entry.rating !== undefined ? { rating: entry.rating } : {}),
      };
    } else {
      runner = toLineupRunner(entry);
    }
    const prepared = prepareRunner(index, runner, individualId, resolver);
    runners.push(storedIds === null ? prepared : withDriftCheck(prepared, storedIds, resolver));
  });
  return { runners, failures };
}

/**
 * 保存した個体を使うとき、スキルの解決結果が保存したときと同じかを見る。
 * データの取り直しで、同じ名前に新しい版（継承進化版など）が増えると、採るスキルが変わりうる。
 * 黙って変わると、同じ個体の結果が変わった理由が分からなくなる。
 */
function withDriftCheck(prepared: PreparedRunner, storedIds: readonly string[], resolver: SkillResolver): PreparedRunner {
  const now = new Set(prepared.skills.skills.map((s) => s.id));
  const before = new Set(storedIds);
  // 解決できなかった名前は、すでに未解決として別に返っている。ここでは両方で解決できたものの違いだけを見る。
  const added = [...now].filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !now.has(id) && prepared.skills.unresolved.length === 0);
  if (added.length === 0 && removed.length === 0) return prepared;
  const name = (id: string) => resolver.nameOf(id) ?? id;
  const parts: string[] = [];
  if (added.length > 0) parts.push(`増えた: ${added.map(name).join('、')}`);
  if (removed.length > 0) parts.push(`消えた: ${removed.map(name).join('、')}`);
  return {
    ...prepared,
    issues: [
      ...prepared.issues,
      {
        code: 'individual_changed',
        message: `保存した個体のスキルの解決結果が、保存したときと違います（${parts.join(' / ')}）。データが更新された可能性があります。`,
      },
    ],
  };
}

export function prepareRunner(
  index: number,
  runner: LineupRunner,
  individualId: string | null,
  resolver: SkillResolver,
): PreparedRunner {
  const skills = resolver.resolveLineup({
    ...(runner.chara !== undefined ? { chara: runner.chara } : {}),
    ...(runner.unique !== undefined ? { unique: runner.unique.name } : {}),
    skills: runner.skills,
  });
  const issues = [...checkStatusRank(runner.status, runner.statusRank), ...checkAptitude(runner.aptitude)];
  return { index, runner, individualId, skills, style: chooseStyle(runner), issues };
}

/** 1 つの解決結果を、応答に載せる形にする。画像と見比べられるよう、入力した名前を残す。 */
export function describeResolution(entry: SkillResolution): Record<string, unknown> {
  if (entry.status === 'resolved') {
    return {
      input: entry.input,
      status: 'resolved',
      name: entry.skill.name,
      id: entry.skill.id,
      rarity: entry.skill.rarity,
      asUnique: entry.asUnique,
      sp: entry.skill.sp,
    };
  }
  return {
    input: entry.input,
    status: 'unresolved',
    reason: entry.reason,
    candidates: entry.candidates.map((c) => ({ id: c.id, name: c.name, rarity: c.rarity, holder: c.holder, score: round(c.score) })),
  };
}

export function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function styleLabel(choice: StyleChoice): string {
  return STYLE_LABEL[choice.style];
}

/** 解決できなかった名前の一覧。計算に進めるかの判断と、エラー文に使う。 */
export function unresolvedOf(prepared: PreparedLineup): { runner: string; index: number; names: string[] }[] {
  return prepared.runners
    .filter((p) => p.skills.unresolved.length > 0)
    .map((p) => ({ runner: p.runner.name, index: p.index, names: p.skills.unresolved.map((u) => u.input) }));
}
