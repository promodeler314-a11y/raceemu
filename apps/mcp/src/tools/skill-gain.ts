import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { SkillData } from '../../../../packages/sim/src/skill/types.ts';
import { RaceCalculator } from '../../../../packages/sim/src/calculator.ts';
import { bashinMeters } from '../../../../packages/sim/src/data/constants.ts';
import { buildFieldBundle, defaultFieldProfile } from '../../../../packages/sim/src/field/field.ts';
import { displaySpTotal } from '../../../../packages/sim/src/field/opponent-roster.ts';
import { buildRaceSetting } from '../../../../packages/sim/src/multi/lineup.ts';
import { meanAndSe, runPaired, type PairedSummary } from '../../../../packages/sim/src/multi/paired.ts';
import { defaultSystemSetting, type RaceSetting, type TrackRef } from '../../../../packages/sim/src/setting.ts';
import type { McpContext } from '../context.ts';
import {
  buildFillGroups,
  describeOpponents,
  opponentModelNotes,
  planFill,
  typicalFallbackCount,
  type FillGroup,
  type FillPlan,
} from '../fill-opponents.ts';
import { prepareLineup, round, unresolvedOf } from '../lineup-service.ts';
import { winRateStandardError } from '../marks.ts';
import { markdownTable, toolError, toolResult } from '../result.ts';
import { progressReporter } from '../runtime.ts';
import {
  fillOpponentsSchema,
  lineupEntrySchema,
  trackSchema,
  type FillOpponentsInput,
  type LineupEntry,
  type TrackInput,
} from '../schemas.ts';
import { describeFailure } from './check-lineup.ts';

export const DEFAULT_GAIN_TRIALS = 500;
export const MAX_GAIN_TRIALS = 5000;
/** 相手の束の本数と、その乱数の種。画面の既定（packages/sim/src/parallel/cross-cli.ts）と同じ。 */
const FIELD_SAMPLES = 48;
const FIELD_SEED = 9001;
/** 何試行ごとにイベントループへ制御を返すか。進捗の通知と中断を受け付けるため。 */
const YIELD_EVERY = 25;

export interface SkillGainArgs {
  readonly runner: LineupEntry;
  readonly add: readonly string[];
  readonly track: TrackInput;
  readonly trials: number;
  readonly seed: number;
  readonly field_size: number;
  readonly skip_unresolved: boolean;
  /** 渡すと、全頭同時のレースで勝率の対比較も返す。省くと今までどおり（docs/mcp-design.md 3.5 節）。 */
  readonly win_rate?: FillOpponentsInput;
}

interface Extra {
  readonly signal: AbortSignal;
  readonly _meta?: { readonly progressToken?: string | number };
  readonly sendNotification: Parameters<typeof progressReporter>[0]['sendNotification'];
}

/** 勝率の対比較の応答のうち、文章と notes と構造化した値。 */
interface WinRateReport {
  readonly text: readonly string[];
  readonly notes: readonly string[];
  readonly structured: Record<string, unknown>;
}

/** 符号つきで丸める。丸めて 0 になる値に負号を残さない。 */
function signed(value: number, digits: number): string {
  const text = value.toFixed(digits);
  if (Number(text) === 0) return text.replace('-', '');
  return value > 0 ? `+${text}` : text;
}

const percent = (x: number): string => `${(100 * x).toFixed(1)}%`;

/** SP 予算をどう決めたか。結果の水準が予算に強く依るので、決め方を必ず書く。 */
function budgetNote(plan: FillPlan, baselineDisplaySp: number): string {
  const budget = plan.profile.spBudget;
  switch (plan.budgetSource) {
    case 'input':
      return (
        `相手の SP 予算 ${budget} は指定の値です。基準の 1 頭の白・金・緑の表示 SP の合計は ${baselineDisplaySp} です。` +
        '相手の強さは予算に敏感なので、見比べてください。'
      );
    case 'lineup':
      return (
        `相手の SP 予算 ${budget} は、基準の 1 頭（足す前）が持つ白・金・緑の表示 SP の合計に揃えました（相手を自分と同格にする。緑も数える）。` +
        '足したスキルの費用は予算に入れていません。基準と案で相手を変えないためです。'
      );
    case 'default':
      return `基準の 1 頭が白・金・緑を持たないので、相手の SP 予算は既定の ${budget} にしました。相手が基準よりかなり強くなります。`;
  }
}

/**
 * 勝率の対比較の応答を組み立てる。
 *
 * 数値は `runPaired` の集計をそのまま写す。ここで決めるのは、読み間違えないための文面である。
 * 差は「案 − 基準」で、勝率は正が良く、平均着順とタイムは負が良い。
 */
function describeWinRate(input: {
  readonly plan: FillPlan;
  readonly groups: readonly FillGroup[];
  readonly paired: PairedSummary;
  readonly added: readonly SkillData[];
  readonly courseDistance: number;
  readonly baselineDisplaySp: number;
  readonly elapsedMs: number;
}): WinRateReport {
  const { plan, groups, paired, added, courseDistance, baselineDisplaySp, elapsedMs } = input;
  const { base, variant, deltaWinRate, deltaMeanOrder, deltaMeanTime } = paired;
  const band = (x: { se: number }, scale: number, digits: number) => `±${(2 * scale * x.se).toFixed(digits)}`;
  const examples = describeOpponents(groups[0]!.opponents);
  const skillNames = new Map(added.map((s) => [s.id, s.name]));
  const counts = groups.map((g) => g.count);
  const perGroup = Math.min(...counts) === Math.max(...counts) ? `${counts[0]}` : `${Math.min(...counts)}〜${Math.max(...counts)}`;

  const text = [
    '',
    `勝率の対比較 / ${plan.gateCount} 頭立て（名簿から相手を ${plan.filled} 頭、${groups.length} 組） / ${paired.trials} 試行 / SP 予算 ${plan.profile.spBudget} / ${(elapsedMs / 1000).toFixed(1)} 秒`,
    '',
    markdownTable(
      ['項目', '基準', '案', '差（案 − 基準、±は 2 標準誤差）'],
      [
        ['勝率', percent(base.winRate), percent(variant.winRate), `${signed(100 * deltaWinRate.mean, 1)} ポイント（${band(deltaWinRate, 100, 1)}）`],
        [
          '平均着順（小さいほど良い）',
          base.meanOrder.toFixed(2),
          variant.meanOrder.toFixed(2),
          `${signed(deltaMeanOrder.mean, 2)}（${band(deltaMeanOrder, 1, 2)}）`,
        ],
        [
          '平均タイム',
          `${base.meanTime.toFixed(3)} 秒`,
          `${variant.meanTime.toFixed(3)} 秒`,
          `${signed(deltaMeanTime.mean, 3)} 秒（${band(deltaMeanTime, 1, 3)}）`,
        ],
      ],
    ),
    '',
    '足したスキルの発動（案の側）:',
    '',
    markdownTable(
      ['スキル', '発動率', '最初の発動位置の中央値'],
      paired.skills.map((k) => [
        skillNames.get(k.skillId) ?? k.skillId,
        percent(k.triggerRate),
        k.medianFirstPosition === null
          ? '発動せず'
          : `${Math.round(k.medianFirstPosition)} m（コース ${courseDistance} m の ${Math.round((100 * k.medianFirstPosition) / courseDistance)}%）`,
      ]),
    ),
    '',
    '補った相手の例（1 組目。組ごとに引き直している）:',
    '',
    markdownTable(
      ['枠', 'ウマ娘', '脚質', 'スキル数', '固有 Lv'],
      examples.map((e) => [e.slot, e.charaName ?? '（典型スキル）', e.styleLabel, e.skillCount, e.uniqueLevel]),
    ),
  ];

  const notes: string[] = [
    `勝率の対比較: 自分 1 頭に名簿から補った相手 ${plan.filled} 頭を足した ${plan.gateCount} 頭立てで、相手は ${groups.length} 組を引き、` +
      `試行 ${paired.trials} 回を 1 組あたり ${perGroup} 回に分けています。基準（そのまま）と案（足した）を、同じ相手・同じ乱数の種・同じ試行番号で回し、試行ごとの差を取っています。`,
    '差の ± は、試行ごとの差の標準誤差の 2 倍です。相手の組の選び方による揺れは含みません（組は少数しか引かない）。' +
      'seed か win_rate.lineups を変えて、結果が動かないか確かめてください。組ごとの勝率は winRate.byLineup にあります。',
    '案の側で自分が速くなると、相手の位置取りも変わるため、相手の走りは基準と完全には同じになりません。出目の種は同じなので、差は試行ごとの対で取れています。',
    budgetNote(plan, baselineDisplaySp),
    '勝率の水準は、相手の作り方と SP 予算に強く依ります（例: 京都 芝2200m 外で、相手のやる気を絶好調に、脚質を 1-3-3-1 に固定し、自分を最適化済みの先行にした測定では、' +
      '相手の予算が 9000 / 10000 / 11500 のとき自分の勝率は約 80% / 42% / 9%。docs/order-field.md 4.7 節）。' +
      'この道具は相手のやる気と脚質の構成を引き直すので、同じ予算でも水準が違います（予算 10000 のとき約 57〜58%）。予算に強く依る、という点だけを読み取ってください。' +
      '基準と案の差は同じ相手に対する比べですが、勝率そのものを実戦の勝率と読まないでください。',
    '勝率の差は、順位条件（前にいるときだけ発動するスキルなど）の判定にも依ります。その判定はゲームと突き合わせていません。',
    ...opponentModelNotes(plan),
    '獲得バ身とタイム短縮は、上の同格の相手に対する単騎の計算で、勝率の対比較の相手（名簿）とは別の計算です。',
  ];
  const fallback = typicalFallbackCount(groups);
  if (fallback > 0) notes.push(`名簿のカードが足りず、${fallback} 頭ぶん（全組の合計）は典型スキルの相手になりました。`);
  if (paired.skills.every((k) => k.triggerRate === 0)) {
    notes.push('足したスキルは、案の側で 1 度も発動しませんでした。脚質・距離・季節・順位条件など、発動の条件を確かめてください。');
  } else if (Math.abs(deltaWinRate.mean) <= 2 * deltaWinRate.se) {
    notes.push('勝率の差は誤差の範囲で、0 と区別できません。発動していても、着順を動かすほどの差ではなかった可能性があります。試行回数を増やして確かめてください。');
  }
  notes.push(...plan.preparedNotes);

  const stat = (x: { mean: number; se: number }, digits: number) => ({ mean: round(x.mean, digits), se: round(x.se, digits) });
  const arm = (x: { winRate: number; meanOrder: number; meanTime: number }) => ({
    winRate: round(x.winRate, 4),
    winRateSe: round(winRateStandardError(x.winRate, paired.trials), 4),
    meanOrder: round(x.meanOrder, 3),
    meanTime: round(x.meanTime, 3),
  });
  const structured = {
    skipped: false,
    gateCount: plan.gateCount,
    filled: plan.filled,
    trials: paired.trials,
    lineups: groups.length,
    trialsPerLineup: counts,
    keys: groups.map((g) => ({ lineup: g.index, sample: g.sample, raceSeed: g.raceSeed })),
    budget: { spBudget: plan.profile.spBudget, source: plan.budgetSource, baselineDisplaySp },
    profile: plan.profile,
    baseline: arm(base),
    variant: arm(variant),
    // 差は案 − 基準。se は標準誤差（± は 2 倍）。勝率は正が良く、平均着順とタイムは負が良い。
    delta: {
      winRate: stat(deltaWinRate, 4),
      meanOrder: stat(deltaMeanOrder, 3),
      meanTime: stat(deltaMeanTime, 4),
    },
    skills: paired.skills.map((k) => ({
      id: k.skillId,
      name: skillNames.get(k.skillId) ?? k.skillId,
      triggerRate: round(k.triggerRate, 4),
      medianFirstPosition: k.medianFirstPosition === null ? null : round(k.medianFirstPosition, 1),
      medianFirstPositionRatio: k.medianFirstPosition === null ? null : round(k.medianFirstPosition / courseDistance, 3),
    })),
    byLineup: paired.groups.map((g) => ({
      lineup: g.index,
      trials: g.trials,
      baselineWinRate: round(g.baseWinRate, 4),
      variantWinRate: round(g.variantWinRate, 4),
    })),
    example: examples,
    elapsedMs: Math.round(elapsedMs),
  };
  return { text, notes, structured };
}

export async function runSkillGain(context: McpContext, args: SkillGainArgs, extra: Extra): Promise<CallToolResult> {
  const { data } = context;
  const detail = data.trackData[args.track.location]?.courses[args.track.course];
  if (detail === undefined) return toolError('track の競馬場とコースが見つかりません。list_courses で引いてください。');

  const prepared = prepareLineup([args.runner], context.resolver, context.individuals);
  if (prepared.failures.length > 0) return toolError(prepared.failures.map(describeFailure).join('\n'));
  const self = prepared.runners[0]!;
  const unresolvedSelf = unresolvedOf(prepared);
  if (unresolvedSelf.length > 0 && !args.skip_unresolved) {
    return toolError(
      `出走表のスキル名を解決できないものがあります: ${unresolvedSelf[0]!.names.join('、')}。check_lineup で確かめてください。`,
      { unresolved: unresolvedSelf },
    );
  }

  // 足すスキル。名前の解決は出走表と同じ規則（他のウマ娘の固有は継承版）。
  const added: SkillData[] = [];
  const unresolvedAdd: string[] = [];
  for (const name of args.add) {
    const hit = context.resolver.resolve(name);
    if (hit.status === 'resolved') added.push(hit.skill);
    else unresolvedAdd.push(name);
  }
  if (unresolvedAdd.length > 0 && !args.skip_unresolved) {
    const lines = unresolvedAdd.map((name) => {
      const candidates = context.resolver.nearest(name).map((c) => c.name);
      return `- 「${name}」→ 近い候補: ${candidates.length === 0 ? 'なし' : candidates.join('、')}`;
    });
    return toolError(['足すスキルの名前を解決できません。', ...lines].join('\n'));
  }
  // すでに持っているスキルは足さない（差が 0 になるだけで、読み違いに気付けない）。
  const owned = new Set(self.skills.skills.map((s) => s.id));
  const already = added.filter((s) => owned.has(s.id));
  const toAdd = added.filter((s, i) => !owned.has(s.id) && added.findIndex((o) => o.id === s.id) === i);
  if (toAdd.length === 0) {
    return toolError(
      already.length > 0
        ? `足すスキルはすべて持っています: ${already.map((s) => s.name).join('、')}。`
        : '足すスキルがありません。',
    );
  }

  const trackRef: TrackRef = {
    location: args.track.location,
    course: args.track.course,
    condition: args.track.condition,
    gateCount: args.field_size,
    season: args.track.season,
    weather: args.track.weather,
    time: args.track.time,
  };
  const built = buildRaceSetting(self.runner, self.skills.skills, trackRef, data.trackData, 1);
  const withSkills = { ...built.setting, skills: [...built.setting.skills, ...toAdd] };
  const system = defaultSystemSetting();

  // 勝率の対比較（opt-in）。相手は `win_rate` の `fill_opponents` と同じく、名簿から組む。
  // SP 予算を省いたときは、基準の 1 頭（足す前）の表示 SP に揃える。足した後の持ち物から決めると、
  // 基準と案の相手が別になり、対比較が成り立たない。
  const winDecision =
    args.win_rate === undefined
      ? null
      : planFill(data, args.win_rate, [self.runner], args.track, context.skillListDir, [displaySpTotal(self.skills.skills)]);
  const winPlan = winDecision?.kind === 'fill' ? winDecision.plan : null;
  const winSkipped = winDecision?.kind === 'none' ? winDecision.reasons : [];
  // 頭数は勝率の側の指定（gate_count）で決める。`field_size` は獲得バ身の計算にだけ使う。
  const winTrack: TrackRef | null = winPlan === null ? null : { ...trackRef, gateCount: winPlan.gateCount };
  // 人気は 1 番（出走表が 1 頭のときの `win_rate` と同じ振り方）。基準の側の勝率は、同じ入力の `win_rate` の結果と一致する。
  const winBase: RaceSetting | null =
    winTrack === null ? null : buildRaceSetting(self.runner, self.skills.skills, winTrack, data.trackData, 1).setting;
  const winGroups: FillGroup[] =
    winPlan === null || winTrack === null ? [] : buildFillGroups(winPlan, data, winTrack, args.seed, args.trials);
  // 進捗は、獲得バ身の試行と、勝率の試行を通した数で知らせる。
  const progressTotal = winBase === null ? args.trials : args.trials * 2;
  const report = progressReporter(extra, 'スキルを足したときの差を測っています');

  const started = performance.now();
  let result: {
    gains: { seconds: number[]; bashin: number[]; baseTime: number[]; endSpeed: number[] };
    paired: PairedSummary | null;
    winElapsedMs: number;
  };
  try {
    result = await context.runtime.run(async () => {
      // 相手は自分と同格で、束の 1 本ごとに構成と強さを引き直す。束は全試行で使い回す。
      const bundle = buildFieldBundle(defaultFieldProfile(args.field_size), trackRef, system, data.trackData, {
        samples: FIELD_SAMPLES,
        seed: FIELD_SEED,
        self: built.setting.uma,
        skillsById: data.skillsById,
      });
      const calculator = new RaceCalculator(system, data.trackData);
      const out = { seconds: [] as number[], bashin: [] as number[], baseTime: [] as number[], endSpeed: [] as number[] };
      for (let trial = 0; trial < args.trials; trial++) {
        if (extra.signal.aborted) throw new Error('中断されました');
        const base = calculator.simulate(built.setting, { seed: args.seed, trial, field: bundle });
        const plus = calculator.simulate(withSkills, { seed: args.seed, trial, field: bundle });
        // 足した側がゴールした瞬間に、足さない側は終端速度 × 差の時間だけ後ろにいる。
        const speed = base.state.simulation.lastFrame?.speed ?? 0;
        const seconds = base.result.raceTime - plus.result.raceTime;
        out.seconds.push(seconds);
        out.bashin.push((seconds * speed) / bashinMeters);
        out.baseTime.push(base.result.raceTime);
        out.endSpeed.push(speed);
        if ((trial + 1) % YIELD_EVERY === 0) {
          report(trial + 1, progressTotal);
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      report(args.trials, progressTotal);

      // 勝率の対比較。基準と案を、同じ相手・同じ種・同じ試行番号で回す（packages/sim/src/multi/paired.ts）。
      let paired: PairedSummary | null = null;
      let winElapsedMs = 0;
      if (winBase !== null) {
        const winStarted = performance.now();
        paired = await runPaired(
          calculator,
          {
            base: winBase,
            variant: { ...winBase, skills: [...winBase.skills, ...toAdd] },
            groups: winGroups.map((g) => ({ index: g.index, seed: g.raceSeed, count: g.count, opponents: g.opponents })),
            traceSkillIds: toAdd.map((s) => s.id),
          },
          {
            signal: extra.signal,
            yieldControl: () => new Promise<void>((resolve) => setImmediate(resolve)),
            onProgress: (done) => report(args.trials + done, progressTotal),
          },
        );
        winElapsedMs = performance.now() - winStarted;
      }
      return { gains: out, paired, winElapsedMs };
    }, extra.signal);
  } catch (error) {
    if (extra.signal.aborted) return toolError('中断されました。');
    throw error;
  }
  const elapsedMs = performance.now() - started;
  const { gains, paired, winElapsedMs } = result;

  const bashin = meanAndSe(gains.bashin);
  const seconds = meanAndSe(gains.seconds);
  const base = meanAndSe(gains.baseTime);
  const endSpeed = meanAndSe(gains.endSpeed);
  // 費用は SkillData.sp を直に足さない。継承進化は sp が 0 で、継承版の値段で数える。
  // 同じグループの重複（継承版と継承進化を両方挙げたなど）は 1 つぶんになる。
  const { costModel } = context;
  const cost = costModel.totalCost(toAdd.map((s) => s.id));

  const notes: string[] = [
    '順位や接触の判定は、ゲームと突き合わせていません。',
    '1 バ身 = 2.5 m の換算は、ゲームでの実測が取れていません。',
    `相手は自分と同格の ${args.field_size} 頭立てで、スキルは持たせていません。足す前と足した後を同じ乱数で比べています。`,
  ];
  if (unresolvedSelf.length > 0 || unresolvedAdd.length > 0) {
    notes.push(
      `解決できず落としたスキル: ${[...unresolvedSelf.flatMap((u) => u.names), ...unresolvedAdd].join('、')}。効果は計算に入っていません。`,
    );
  }
  if (already.length > 0) notes.push(`すでに持っているため足さなかったスキル: ${already.map((s) => s.name).join('、')}。`);
  if (cost > 0 && Math.abs(bashin.mean) > 0) {
    notes.push('費用（sp）は表示額の合計です。進化スキルは元のスキルが要り、その費用は含みません。');
  }
  if (toAdd.some((s) => s.rarity === 'special' && s.sp === 0 && costModel.cost(s.id) > 0)) {
    notes.push('継承進化は、継承版を買って進化させるものなので、費用は継承版の値段で数えています（ヒントの割引は見込みません）。');
  }
  // 差も誤差も厳密に 0 のときは、スキルがそもそも発動していない。`<` では 0 < 0 で漏れる。
  if (Math.abs(bashin.mean) <= 2 * bashin.se) {
    notes.push('獲得バ身は誤差の範囲で、0 と区別できません。試行回数を増やすか、発動しない条件（脚質・距離）でないかを確かめてください。');
  }
  // 勝率の対比較（win_rate を渡したときだけ）。補えなかったときは、回さずに理由を返す。
  const winReport =
    paired === null || winPlan === null
      ? null
      : describeWinRate({
          plan: winPlan,
          groups: winGroups,
          paired,
          added: toAdd,
          courseDistance: detail.distance,
          baselineDisplaySp: displaySpTotal(self.skills.skills),
          elapsedMs: winElapsedMs,
        });
  if (winReport !== null) notes.push(...winReport.notes);
  else if (args.win_rate !== undefined) {
    notes.push(`勝率の対比較は回していません（相手を名簿から補えませんでした）: ${winSkipped.join(' ')}`);
  }
  if (context.meta !== null) {
    notes.push(`データは ${context.meta.syncedAt} に最後に変わりました。`);
  }

  const courseName = `${data.trackData[args.track.location]!.name} ${detail.name}`;
  const text = [
    `${self.runner.name} に ${toAdd.map((s) => s.name).join('、')} を足したとき / ${courseName} / ${args.trials} 試行 / seed ${args.seed} / ${(elapsedMs / 1000).toFixed(1)} 秒`,
    '',
    markdownTable(
      ['項目', '値'],
      [
        ['獲得バ身', `${bashin.mean.toFixed(2)} バ身（±${bashin.se.toFixed(2)}）`],
        ['タイム短縮', `${seconds.mean.toFixed(3)} 秒（±${seconds.se.toFixed(3)}）`],
        ['足す前の平均タイム', `${base.mean.toFixed(3)} 秒`],
        ['足す前の終端速度', `${endSpeed.mean.toFixed(2)} m/s`],
        ['足したスキルの費用', `${cost} pt`],
      ],
    ),
    ...(winReport === null ? [] : winReport.text),
    '',
    '注意:',
    ...notes.map((n) => `- ${n}`),
  ].join('\n');

  return toolResult(
    {
      runner: self.runner.name,
      added: toAdd.map((s) => ({ id: s.id, name: s.name, rarity: s.rarity, sp: costModel.cost(s.id) })),
      track: { name: courseName, distance: detail.distance, condition: args.track.condition },
      trials: args.trials,
      seed: args.seed,
      fieldSize: args.field_size,
      bashin: { mean: round(bashin.mean, 3), se: round(bashin.se, 3) },
      seconds: { mean: round(seconds.mean, 4), se: round(seconds.se, 4) },
      baseline: { meanTime: round(base.mean, 3), endSpeed: round(endSpeed.mean, 3) },
      costSp: cost,
      elapsedMs: Math.round(elapsedMs),
      ...(args.win_rate === undefined
        ? {}
        : { winRate: winReport === null ? { skipped: true, reasons: winSkipped } : winReport.structured }),
      notes,
    },
    text,
  );
}

export function registerSkillGain(server: McpServer, context: McpContext): void {
  server.registerTool(
    'skill_gain',
    {
      title: 'スキルを足したときの獲得バ身',
      description:
        '1 頭の出走表に、スキルを足したときの獲得バ身（ゴールで何バ身前に出るか）とタイム短縮を返す。' +
        '足す前と足した後を同じ乱数どうしで比べるので、誤差が小さい。相手は自分と同格の頭立てで、順位条件も判定する。' +
        '1 バ身 = 2.5 m の換算はゲームで実測していない。脚質・距離の条件を満たさないスキルは 0 バ身になる。' +
        'win_rate を渡すと、全頭同時のレースで勝率の対比較（Δ勝率、Δ平均着順、足したスキルの発動率と発動位置）も返す。' +
        '相手は実在のカードの名簿から補う推定で、勝率の水準は相手の作り方と SP 予算に強く依る。1 つのスレッドで回るので、既定の試行数で 1 分半ほどかかる。',
      inputSchema: {
        runner: lineupEntrySchema.describe('スキルを足す 1 頭。全項目を書くか、保存した個体を individual で指す'),
        add: z.array(z.string().min(1)).min(1).max(10).describe('足すスキルの名前。複数なら全部をまとめて足した差を返す'),
        track: trackSchema,
        trials: z.number().int().min(1).max(MAX_GAIN_TRIALS).default(DEFAULT_GAIN_TRIALS),
        seed: z.number().int().default(1),
        field_size: z.number().int().min(2).max(18).default(9).describe('出走頭数。既定はチャンピオンズミーティングの 9'),
        skip_unresolved: z.boolean().default(false).describe('true なら、解決できないスキルを落として回す'),
        win_rate: fillOpponentsSchema
          .optional()
          .describe(
            '渡すと、勝率の対比較も返す。基準（そのまま）と案（足した）を、名簿から補った同じ相手・同じ乱数の全頭同時のレースで回し、' +
              '試行ごとの差から Δ勝率と Δ平均着順（±は標準誤差）と、足したスキルの発動率・最初の発動位置を出す。' +
              '中身は win_rate の fill_opponents と同じ（全部省いてよい）。gate_count（既定 9）は勝率の頭数で、field_size は獲得バ身の計算にだけ使う。' +
              'sp_budget を省くと、runner の白・金・緑の表示 SP の合計に揃える。lineups は相手の組の数（既定 8）。省くと今までどおり',
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args, extra) => runSkillGain(context, args as SkillGainArgs, extra),
  );
}
