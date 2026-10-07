import type { GameData } from '../../../packages/data/src/index.ts';
import type { Style } from '../../../packages/sim/src/data/constants.ts';
import { defaultFieldProfile, opponentSettings, type FieldProfile } from '../../../packages/sim/src/field/field.ts';
import { DEFAULT_ROSTER_PROFILE, type OpponentRoster, type RosterProfile } from '../../../packages/sim/src/field/opponent-roster.ts';
import { opponentSkillPool } from '../../../packages/sim/src/field/opponent-skills.ts';
import type { LineupRunner } from '../../../packages/sim/src/multi/lineup.ts';
import type { RaceSetting, TrackRef, UmaStatus } from '../../../packages/sim/src/setting.ts';
import { prepareRoster, SKILL_LIST_DIR } from '../../../packages/solver/src/opponent-roster-setup.ts';
import type { FillOpponentsInput } from './schemas.ts';

/**
 * 出走表の頭数が足りないときに、相手を名簿から補う（`win_rate` の `fill_opponents`）。
 * docs/mcp-design.md 3.3 節。相手の作り方は docs/order-field.md 4.7 節。
 *
 * 計算は新しく書かない。相手 1 組は `opponentSettings` の名簿の経路で組む。
 * ここにあるのは、出走表から相手の強さの中心を決めることと、組ごとの鍵と、応答に書く説明だけである。
 *
 * **全頭同時の計算（`runMulti`）は、1 回の呼び出しで相手を固定する。** 相手を何通りも見たいので、
 * 組（lineup）を何組か引き、試行を組の数で等分して、組ごとに回して合算する。
 * 組の鍵は呼び出しの seed と組の番号だけから決まる。同じ入力なら、同じ相手に同じ乱数で回る。
 */

/** 補う方針が決まったもの。名簿と、相手の組み方と、強さの中心を持つ。 */
export interface FillPlan {
  /** 出走頭数の合計 */
  readonly gateCount: number;
  /** 補う頭数 */
  readonly filled: number;
  readonly input: FillOpponentsInput;
  readonly roster: OpponentRoster;
  readonly profile: RosterProfile;
  /** `opponentSettings` に渡す想定。名簿の相手で、強さは `center` に揃える。 */
  readonly fieldProfile: FieldProfile;
  /** 相手の強さの中心。出走表の平均ステータス。 */
  readonly center: UmaStatus;
  /** 名簿と順位表の用意で出た説明（置いてある表が古い、など）。応答の notes に載せる。 */
  readonly preparedNotes: readonly string[];
  /** SP 予算の決め方。指定、出走表の平均、既定値のどれか。 */
  readonly budgetSource: 'input' | 'lineup' | 'default';
}

export type FillDecision =
  /** 補わない（頭数が足りている、順位表が無い）。理由を `notes` に持つ。 */
  | { readonly kind: 'none'; readonly notes: readonly string[] }
  | { readonly kind: 'fill'; readonly plan: FillPlan };

/** 平均を整数にする。出走表の頭が 1 頭なら、その頭の値になる。 */
function meanOf(values: readonly number[]): number {
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/**
 * 補うかどうかと、補い方を決める。
 *
 * - 出走表がすでに `gate_count` 頭以上なら補わない。
 * - そのコースの順位表（スキル一覧）が無ければ補わない。理由は `notes` に入る。
 *   名簿は「そのコースで効くスキル」を順位表から買うので、順位表が無いと作れない。
 *
 * 相手の強さは、出走表の全頭の平均ステータスに揃える（1 頭だけなら、その頭に）。
 * SP 予算も、指定が無ければ出走表の頭が持つ白・金・緑の表示 SP の平均に揃える（`lineupSp`）。
 * 相手の強さは予算に敏感で（京都 芝2200m 外で 9000 と 10000 の間で、自分の勝率が 40 ポイント近く動く。
 * docs/order-field.md 4.7 節）、固定の既定値では、持ち物の多い出走表にも少ない出走表にも合わない。
 * 相手の作り方の既定（`defaultFieldProfile`）が「自分と同格」で、出走表が複数頭のときは
 * 自分にあたる 1 頭が決まらないため。適性は全部 A、やる気は束の 1 本ごとに引き直す。
 */
export function planFill(
  data: GameData,
  input: FillOpponentsInput,
  runners: readonly LineupRunner[],
  course: { readonly location: number; readonly course: number },
  dir: string = SKILL_LIST_DIR,
  /** 出走表の頭ごとの、白・金・緑の表示 SP の合計。`sp_budget` を省いたときに平均を予算にする。 */
  lineupSp: readonly number[] = [],
): FillDecision {
  const filled = input.gate_count - runners.length;
  if (filled <= 0) {
    return {
      kind: 'none',
      notes: [
        `出走表がすでに ${runners.length} 頭で、gate_count（${input.gate_count}）以上なので、相手は補っていません。`,
      ],
    };
  }

  const lineupBudget = lineupSp.length === 0 ? 0 : meanOf(lineupSp);
  const budgetSource: FillPlan['budgetSource'] =
    input.sp_budget !== undefined ? 'input' : lineupBudget > 0 ? 'lineup' : 'default';
  const profile: RosterProfile = {
    ...DEFAULT_ROSTER_PROFILE,
    spBudget:
      budgetSource === 'input' ? input.sp_budget! : budgetSource === 'lineup' ? lineupBudget : DEFAULT_ROSTER_PROFILE.spBudget,
    uniqueLevel: input.unique_level,
  };
  const prepared = prepareRoster(data, { model: 'roster', profile, rosterFile: null }, course, dir);
  if (prepared.roster === null) {
    return { kind: 'none', notes: ['相手を補えませんでした（出走表の頭だけで回します）。', ...prepared.notes] };
  }

  const center: UmaStatus = {
    charaName: '',
    speed: meanOf(runners.map((r) => r.status.speed)),
    stamina: meanOf(runners.map((r) => r.status.stamina)),
    power: meanOf(runners.map((r) => r.status.power)),
    guts: meanOf(runners.map((r) => r.status.guts)),
    wisdom: meanOf(runners.map((r) => r.status.wisdom)),
    condition: 'BEST',
    style: 'SEN',
    distanceFit: 'A',
    surfaceFit: 'A',
    styleFit: 'A',
    popularity: 5,
    gateNumber: 0,
    uniqueLevel: profile.uniqueLevel,
  };
  // defaultFieldProfile は、頭数が少ないと脚質ごとに最低 1 頭を割り振って、合計が合わなくなる。
  // 束の 1 本ごとに構成を引き直す（redrawComposition）ので、割り振りは合計だけを見る。
  // ここでは合計を補う頭数に合わせ、引き直しが働くことを明示する。
  const base = defaultFieldProfile(filled + 1);
  const fieldProfile: FieldProfile = {
    ...base,
    counts: { NIGE: filled, SEN: 0, SASI: 0, OI: 0, OONIGE: 0 },
    matchSelf: true,
    redrawComposition: true,
    opponentModel: 'roster',
    roster: profile,
  };
  return {
    kind: 'fill',
    plan: {
      gateCount: input.gate_count,
      filled,
      input,
      roster: prepared.roster,
      profile,
      fieldProfile,
      center,
      preparedNotes: prepared.notes,
      budgetSource,
    },
  };
}

/** 32 ビットの混ぜ。seed と組の番号と用途の塩から、独立に見える値を作る。 */
function mix(seed: number, group: number, salt: number): number {
  let h = Math.imul((seed | 0) ^ salt, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15) ^ Math.imul(group + 1, 0x85ebca6b), 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * 組の鍵。
 *
 * - `sample`：相手の引き当てに使う。24 ビットに収める（`opponentSettings` が 32 と 64 を掛けて使う）。
 * - `raceSeed`：その組を回す乱数の種。**組ごとに変える。** `runMulti` は試行番号を 0 から数えるので、
 *   同じ種で回すと、どの組でも同じ試行番号は同じ出目になり、組どうしが相関して誤差を小さく見積もる。
 */
export function groupKeys(seed: number, group: number): { readonly sample: number; readonly raceSeed: number } {
  return { sample: mix(seed, group, 0x51ed270b) >>> 8, raceSeed: mix(seed, group, 0x1b873593) };
}

/** 試行を組に等分する。割り切れない分は、前の組から 1 回ずつ多く持つ。 */
export function splitTrials(total: number, groups: number): number[] {
  const base = Math.floor(total / groups);
  const extra = total % groups;
  return Array.from({ length: groups }, (_, g) => base + (g < extra ? 1 : 0));
}

/** 1 組ぶんの相手と、その組を回す条件 */
export interface FillGroup {
  readonly index: number;
  readonly sample: number;
  readonly raceSeed: number;
  /** この組に割り当てた試行数 */
  readonly count: number;
  /** 補った相手。出走表の頭の後ろに並べる。 */
  readonly opponents: readonly RaceSetting[];
}

/**
 * 組を作る。組の数は、`lineups` と試行数の小さいほう（試行が足りないと、空の組ができる）。
 *
 * `track.gateCount` は出走頭数の合計（`plan.gateCount`）でなければならない。
 * 名簿のカードが尽きた枠は、典型スキルの相手に落ちる（`opponentSettings` の注記）。
 */
export function buildFillGroups(
  plan: FillPlan,
  data: GameData,
  track: TrackRef,
  seed: number,
  trials: number,
): FillGroup[] {
  const counts = splitTrials(trials, Math.min(plan.input.lineups, trials));
  const skillPool = opponentSkillPool(data.skillsById);
  return counts.map((count, index) => {
    const { sample, raceSeed } = groupKeys(seed, index);
    const opponents = opponentSettings(plan.fieldProfile, track, {
      sample,
      roster: plan.roster,
      skillsById: data.skillsById,
      trackData: data.trackData,
      skillPool,
      self: plan.center,
    });
    // 合計が合わないまま回すと、枠の数と頭数がずれて集計が壊れる。黙って切り詰めず、止める。
    if (opponents.length !== plan.filled) {
      throw new Error(`補う相手の頭数が合わない: ${opponents.length} 頭（必要 ${plan.filled} 頭）`);
    }
    return { index, sample, raceSeed, count, opponents };
  });
}

const STYLE_LABEL_OF: Readonly<Record<Style, string>> = {
  NIGE: '逃げ',
  SEN: '先行',
  SASI: '差し',
  OI: '追込',
  OONIGE: '大逃げ',
};

export interface OpponentExample {
  readonly slot: number;
  /** 名簿から引いたウマ娘名。カードが尽きて典型スキルに落ちた枠は null。 */
  readonly charaName: string | null;
  readonly style: Style;
  readonly styleLabel: string;
  readonly skillCount: number;
  readonly uniqueLevel: number;
}

/** 補った相手を、応答に載せる形にする。 */
export function describeOpponents(opponents: readonly RaceSetting[]): OpponentExample[] {
  return opponents.map((setting, index) => ({
    slot: index + 1,
    charaName: setting.uma.charaName === '' ? null : setting.uma.charaName,
    style: setting.uma.style,
    styleLabel: STYLE_LABEL_OF[setting.uma.style],
    skillCount: setting.skills.length,
    uniqueLevel: setting.uma.uniqueLevel,
  }));
}

/** 名簿のカードが尽きて、典型スキルに落ちた相手の数（全組の合計） */
export function typicalFallbackCount(groups: readonly FillGroup[]): number {
  return groups.reduce((sum, group) => sum + group.opponents.filter((o) => o.uma.charaName === '').length, 0);
}

export interface FillNotesInput {
  /** 出走表の頭数 */
  readonly lineupSize: number;
  readonly groups: readonly FillGroup[];
  /** 回し終えた試行数 */
  readonly trials: number;
  /** 指定された `lineups`。試行が足りなくて減らしたときに、そう書く。 */
  readonly requestedLineups: number;
  /** 補った相手が 1 着になった割合の合計（全頭ぶん）。 */
  readonly opponentsWinRate: number;
}

/**
 * 応答の `notes` に書く説明。補ったこと、組の数、相手の組み方、前提の限界（docs/mcp-design.md 4.2 節）。
 * 結果だけが 1 人歩きして、相手が推定であることが落ちるのを防ぐ。
 */
export function fillNotes(plan: FillPlan, input: FillNotesInput): string[] {
  const { profile, center, fieldProfile, budgetSource } = plan;
  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  const counts = input.groups.map((g) => g.count);
  const perGroup = Math.min(...counts) === Math.max(...counts) ? `${counts[0]}` : `${Math.min(...counts)}〜${Math.max(...counts)}`;
  const notes: string[] = [
    `出走表の ${input.lineupSize} 頭に、相手を ${plan.filled} 頭補って、${plan.gateCount} 頭で回しました。` +
      '補った相手は表に出していません。' +
      (input.lineupSize < 2
        ? '出走表が 1 頭なので、印は付けていません。'
        : `印と順位は、出走表の ${input.lineupSize} 頭の中の勝率の順で、補った相手との比べではありません。`),
    `相手は ${input.groups.length} 組を引き、試行 ${input.trials} 回を 1 組あたり ${perGroup} 回に分けて合算しています。` +
      '組は seed と組の番号から決まるので、同じ入力なら同じ相手と同じ結果になります。' +
      (input.groups.length < input.requestedLineups
        ? `（試行が少ないため、組は指定の ${input.requestedLineups} 組から ${input.groups.length} 組に減らしました）`
        : ''),
    `相手の組み方: 実在のカードを脚質の枠ごとに引き（脚質の構成は組ごとに引き直し）、固有 Lv${profile.uniqueLevel}、進化スキル、` +
      `脚質で効く継承固有 ${profile.inheritCount} 個を持たせ、SP ${profile.spBudget} の予算で、` +
      `緑を先に ${profile.greenCount} 個買わせ、残りを白・金・緑の「効き÷SP」の順に使わせています` +
      `（ヒントが出なかった扱いで ${Math.round(profile.hintMissRate * 100)}% は飛ばす。緑は先取りの分のほかにも買うので、1 頭の緑は ${profile.greenCount} 個より多い）。` +
      '名簿と得意脚質はデータからの推定で、ゲームの出走者の実測ではありません。',
    `相手の能力は、出走表の平均（スピード ${center.speed}、スタミナ ${center.stamina}、パワー ${center.power}、根性 ${center.guts}、賢さ ${center.wisdom}）を中心に、` +
      `1 頭ごとに標準偏差 ${fieldProfile.sigma ?? 0} 程度ばらつかせ、やる気は引き直しています。適性はすべて A、人気は 5 番人気です。`,
    budgetSource === 'input'
      ? `SP の予算 ${profile.spBudget} は指定の値です。相手の強さは予算に敏感なので、出走表の頭の持ち物と見比べてください。`
      : budgetSource === 'lineup'
        ? `SP の予算 ${profile.spBudget} は、出走表の頭が持つ白・金・緑の表示 SP の平均に揃えました（相手を自分と同格にする）。`
        : `出走表の頭が白・金・緑を持たないので、SP の予算は既定の ${profile.spBudget} にしました。出走表より相手がかなり強くなります。`,
    `補った相手が 1 着になった割合は合計 ${pct(input.opponentsWinRate)}（1 頭あたり ${pct(input.opponentsWinRate / plan.filled)}）です。` +
      `出走表の頭の勝率の合計は 100% になりません。`,
    '勝率の ± は試行の揺れだけで、相手の組の選び方による揺れは含みません。seed か lineups を変えて、結果が動かないか確かめてください。',
  ];
  const fallback = typicalFallbackCount(input.groups);
  if (fallback > 0) {
    notes.push(`名簿のカードが足りず、${fallback} 頭ぶん（全組の合計）は典型スキルの相手になりました。`);
  }
  notes.push(...plan.preparedNotes);
  return notes;
}
