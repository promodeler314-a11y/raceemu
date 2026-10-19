import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { defaultSystemSetting, type TrackRef } from '../../../../packages/sim/src/setting.ts';
import { assignPopularity, buildRaceSetting, STYLE_LABEL } from '../../../../packages/sim/src/multi/lineup.ts';
import { OrderTally } from '../../../../packages/sim/src/multi/summary.ts';
import { MULTI_FIELDS, toSerializable, unpackMultiEntry } from '../../../../packages/sim/src/parallel/protocol.ts';
import { SimulationCancelled, type MultiOutput } from '../../../../packages/sim/src/parallel/pool.ts';
import type { McpContext } from '../context.ts';
import { buildFillGroups, describeOpponents, fillNotes, planFill, type FillGroup } from '../fill-opponents.ts';
import { describeFailure } from './check-lineup.ts';
import { prepareLineup, round, unresolvedOf } from '../lineup-service.ts';
import { assignMarks, winRateStandardError, type Mark } from '../marks.ts';
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

/** 1 回の呼び出しで引き受ける試行数の上限。仮の値（docs/mcp-design.md 9 節） */
export const MAX_TRIALS = 20000;
export const DEFAULT_TRIALS = 1000;
/** 画面の既定と同じ。同じ出走表を画面に入れると同じ数値になる。 */
export const DEFAULT_SEED = 1;

const CONDITION_LABEL: Record<number, string> = { 1: '良', 2: '稍重', 3: '重', 4: '不良' };
const DEBUFF_NAME = /けん制|ためらい|牽制/;

export interface WinRateArgs {
  readonly lineup: readonly LineupEntry[];
  readonly track: TrackInput;
  readonly trials: number;
  readonly seed: number;
  readonly skip_unresolved: boolean;
  /** 渡すと、出走表が `gate_count` 頭に足りない分の相手を名簿から補う。省くと今までどおり。 */
  readonly fill_opponents?: FillOpponentsInput;
}

interface Extra {
  readonly signal: AbortSignal;
  readonly _meta?: { readonly progressToken?: string | number };
  readonly sendNotification: Parameters<typeof progressReporter>[0]['sendNotification'];
}

export async function runWinRate(context: McpContext, args: WinRateArgs, extra: Extra): Promise<CallToolResult> {
  const { data } = context;
  const detail = data.trackData[args.track.location]?.courses[args.track.course];
  if (detail === undefined) {
    return toolError('track の競馬場とコースが見つかりません。list_courses で引いてください。');
  }
  const prepared = prepareLineup(args.lineup, context.resolver, context.individuals);
  if (prepared.failures.length > 0) {
    return toolError(prepared.failures.map(describeFailure).join('\n'), { failures: prepared.failures });
  }
  const unresolved = unresolvedOf(prepared);
  if (unresolved.length > 0 && !args.skip_unresolved) {
    const lines = prepared.runners.flatMap((p) =>
      p.skills.unresolved.map(
        (u) =>
          `- ${p.runner.name}: 「${u.input}」→ 近い候補: ${u.candidates.length === 0 ? 'なし' : u.candidates.map((c) => c.name).join('、')}`,
      ),
    );
    return toolError(
      [
        'スキル名を解決できないものがあるため、レースを回していません。',
        ...lines,
        '',
        '画像を見直して名前を直し、もう一度呼んでください。他馬に効くデバフなど、データに無いスキルは skip_unresolved: true で落として回せます。落とすときは、利用者に確かめてください。',
      ].join('\n'),
      { unresolved },
    );
  }

  // 頭数が足りないときは、相手を名簿から補う（fill_opponents）。補えなければ、理由を持って出走表の頭だけで回す。
  const lineupSize = prepared.runners.length;
  const fillDecision =
    args.fill_opponents === undefined
      ? null
      : planFill(
          data,
          args.fill_opponents,
          prepared.runners.map((p) => p.runner),
          args.track,
          context.skillListDir,
          prepared.runners.map((p) =>
            p.skills.skills
              .filter((skill) => skill.rarity === 'normal' || skill.rarity === 'rare')
              .reduce((sum, skill) => sum + skill.sp, 0),
          ),
        );
  const plan = fillDecision?.kind === 'fill' ? fillDecision.plan : null;
  const fillSkipped = fillDecision?.kind === 'none' ? fillDecision.notes : [];

  const gateCount = plan === null ? lineupSize : plan.gateCount;
  if (gateCount < 2) {
    return toolError(['出走頭数は 2 頭以上にしてください。', ...fillSkipped].join('\n'));
  }
  const trackRef: TrackRef = {
    location: args.track.location,
    course: args.track.course,
    condition: args.track.condition,
    gateCount,
    season: args.track.season,
    weather: args.track.weather,
    time: args.track.time,
  };
  const popularity = assignPopularity(prepared.runners.map((p) => p.runner));
  const built = prepared.runners.map((p, i) =>
    buildRaceSetting(p.runner, p.skills.skills, trackRef, data.trackData, popularity[i]!),
  );
  const entries = built.map((b) => toSerializable(b.setting));

  // 回す単位。補わないときは 1 つで、今までと同じ呼び出しになる。
  // 補うときは、相手の組ごとに 1 つ。組ごとに相手と乱数の種が違い、試行を等分して持つ。
  const fillGroups: FillGroup[] =
    plan === null ? [] : buildFillGroups(plan, data, trackRef, args.seed, args.trials);
  // 組は 1 つずつ順に回す（プールは同時に 2 つの実行を受けない）。1 組の試行数は少ないので、
  // 既定の塊（32 試行）のままだと、空く Worker が出る。組の中を Worker の数で割って配る。
  const runGroups =
    plan === null
      ? [{ entries, seed: args.seed, count: args.trials }]
      : fillGroups.map((g) => ({
          entries: [...entries, ...g.opponents.map(toSerializable)],
          seed: g.raceSeed,
          count: g.count,
        }));
  const report = progressReporter(extra, '全頭同時のレースを回しています');

  const started = performance.now();
  let outputs: MultiOutput[];
  try {
    // 組をまたいで 1 つの順番待ちに入れる。間に別の呼び出しが割り込まないように。
    outputs = await context.runtime.run(async () => {
      const pool = context.runtime.getPool();
      const done: MultiOutput[] = [];
      let finished = 0;
      for (const group of runGroups) {
        const offset = finished;
        done.push(
          await pool.runMulti(group.entries, defaultSystemSetting(), {
            count: group.count,
            seed: group.seed,
            ...(plan === null ? {} : { chunkSize: Math.max(1, Math.min(32, Math.ceil(group.count / pool.concurrency))) }),
            // 進捗は全組を通した試行数で知らせる。
            onProgress: (count) => report(offset + count, args.trials),
            signal: extra.signal,
          }),
        );
        finished += group.count;
      }
      return done;
    }, extra.signal);
  } catch (error) {
    if (error instanceof SimulationCancelled || extra.signal.aborted) return toolError('中断されました。');
    throw error;
  }
  const elapsedMs = performance.now() - started;

  // 全組の試行を 1 つの集計に足す。着順の回数は足し算で合わせられる。
  // 出走表の頭は全組で同じ添字（0 から lineupSize - 1）にいる。補った相手は組ごとに別の馬なので、頭ごとには読まない。
  const tally = new OrderTally(gateCount);
  for (const output of outputs) {
    const width = output.entries;
    const groupTrials = width === 0 ? 0 : output.packed.length / (width * MULTI_FIELDS);
    for (let t = 0; t < groupTrials; t++) {
      const results = [...Array(width).keys()].map((index) => ({
        index,
        ...unpackMultiEntry(output.packed, (t * width + index) * MULTI_FIELDS),
      }));
      tally.add({ entries: results, states: [], frames: 0 });
    }
  }
  const trials = tally.trials;
  const summaries = tally.summarizeAll();
  // 印は、出走表の頭どうしの勝率の順位で付ける。補った相手は入れない。
  const markResult = assignMarks(summaries.slice(0, lineupSize).map((s) => ({ winRate: s.winRate, trials: s.trials })));
  // 出走表が 1 頭だけなら、順位づける相手がいない。◎ を付けると、勝率が 0 % でも本命に見える。
  const marks: readonly Mark[] = plan !== null && lineupSize < 2 ? [''] : markResult.marks;

  const rows = prepared.runners.map((p, i) => {
    const s = summaries[i]!;
    const b = built[i]!;
    return {
      index: i,
      name: p.runner.name,
      individualId: p.individualId,
      style: { key: b.style.style, label: STYLE_LABEL[b.style.style], reason: b.style.reason },
      popularity: b.popularity,
      uniqueLevel: b.uniqueLevel,
      fits: { distance: b.distanceFit, surface: b.surfaceFit, style: b.styleFit },
      skillCount: p.skills.skills.length,
      droppedSkills: p.skills.unresolved.map((u) => u.input),
      winRate: round(s.winRate, 4),
      winRateSe: round(winRateStandardError(s.winRate, s.trials), 4),
      quinellaRate: round(s.quinellaRate, 4),
      showRate: round(s.showRate, 4),
      meanOrder: round(s.meanOrder, 2),
      meanTime: round(s.meanTime, 3),
      mark: marks[i] as Mark,
    };
  });
  // 勝率の高い順に並べて返す。
  const sorted = markResult.order.map((i) => rows[i]!);

  const notes: string[] = [
    '順位や接触の判定は、ゲームと突き合わせていません（勝率はゲームの実測値ではありません）。',
    `季節・天候・時刻は ${['', '春', '夏', '秋', '冬'][args.track.season]}・${['', '晴', '曇', '雨', '雪'][args.track.weather]}・${args.track.time === 4 ? 'ナイター' : 'ナイターではない'} で計算しました。`,
  ];
  if (args.track.condition >= 2 && args.track.weather === 1) {
    notes.push(`馬場状態は ${CONDITION_LABEL[args.track.condition]} ですが、天候は晴のままです。雨を再現するなら weather を指定してください。`);
  }
  // 補った相手の説明。補えなかったときも、そう書く（指定したのに黙って補われていない、を避ける）。
  const opponentsWinRate = summaries.slice(lineupSize).reduce((sum, s) => sum + s.winRate, 0);
  const fillExample = plan === null ? [] : describeOpponents(fillGroups[0]!.opponents);
  if (plan !== null) {
    notes.push(
      ...fillNotes(plan, {
        lineupSize,
        groups: fillGroups,
        trials,
        requestedLineups: plan.input.lineups,
        opponentsWinRate,
      }),
    );
  } else {
    notes.push(...fillSkipped);
  }
  const dropped = prepared.runners.flatMap((p) => p.skills.unresolved.map((u) => ({ runner: p.runner.name, name: u.input })));
  if (dropped.length > 0) {
    notes.push(`解決できず落としたスキル: ${dropped.map((d) => `${d.runner}の「${d.name}」`).join('、')}。効果は計算に入っていません。`);
    if (dropped.some((d) => DEBUFF_NAME.test(d.name))) {
      notes.push('他馬に効くデバフ（けん制、ためらい）はデータに無く、計算できません。持つ馬がいる出走表では、その分だけ他馬が有利に出ています。');
    }
  }
  const warned = prepared.runners.filter((p) => p.skills.warnings.length + p.issues.length > 0);
  if (warned.length > 0) {
    notes.push(`点検で警告が出た馬: ${warned.map((p) => p.runner.name).join('、')}。check_lineup で内容を確かめてください。`);
  }
  if (context.meta === null) notes.push('データの取得日が分かりません。');
  else {
    notes.push(`データは ${context.meta.syncedAt} に最後に変わりました。それ以降に追加されたウマ娘やスキルは入っていない可能性があります。`);
  }
  if (trials < args.trials) notes.push(`試行は ${trials} 回で終わりました（指定は ${args.trials} 回）。`);
  const closeNotes = markResult.closeCalls.map((c) => {
    const a = rows[c.a]!;
    const b = rows[c.b]!;
    return `${c.rankA} 位の ${a.name} と ${c.rankB} 位の ${b.name} は接戦です（勝率の差 ${(c.gap * 100).toFixed(1)} ポイントは、誤差の範囲）。順位を断言できません。`;
  });

  const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
  const text = [
    `${data.trackData[args.track.location]!.name} ${detail.name}（${CONDITION_LABEL[args.track.condition]}） / ${gateCount} 頭${plan === null ? '' : `（出走表 ${lineupSize} + 補った ${plan.filled}）`} / ${trials} 試行 / seed ${args.seed} / ${(elapsedMs / 1000).toFixed(1)} 秒`,
    '',
    markdownTable(
      ['印', '名前', '脚質', '勝率', '連対率', '複勝率', '平均着順', '平均タイム'],
      sorted.map((r) => [
        r.mark === '' ? '-' : r.mark,
        r.name,
        r.style.label,
        `${pct(r.winRate)}（±${pct(r.winRateSe)}）`,
        pct(r.quinellaRate),
        pct(r.showRate),
        r.meanOrder.toFixed(2),
        `${r.meanTime.toFixed(3)} 秒`,
      ]),
    ),
    ...(closeNotes.length > 0 ? ['', '接戦:', ...closeNotes.map((n) => `- ${n}`)] : []),
    ...(plan === null
      ? []
      : [
          '',
          '補った相手の例（1 組目。組ごとに引き直している）:',
          '',
          markdownTable(
            ['枠', 'ウマ娘', '脚質', 'スキル数', '固有 Lv'],
            fillExample.map((e) => [e.slot, e.charaName ?? '（典型スキル）', e.styleLabel, e.skillCount, e.uniqueLevel]),
          ),
        ]),
    '',
    '注意:',
    ...notes.map((n) => `- ${n}`),
  ].join('\n');

  return toolResult(
    {
      track: {
        location: args.track.location,
        course: args.track.course,
        name: `${data.trackData[args.track.location]!.name} ${detail.name}`,
        distance: detail.distance,
        condition: args.track.condition,
      },
      trials,
      seed: args.seed,
      elapsedMs: Math.round(elapsedMs),
      runners: sorted,
      closeCalls: markResult.closeCalls.map((c) => ({
        a: rows[c.a]!.name,
        b: rows[c.b]!.name,
        rankA: c.rankA,
        rankB: c.rankB,
        gap: round(c.gap, 4),
      })),
      notes,
      ...(args.fill_opponents === undefined
        ? {}
        : {
            fillOpponents:
              plan === null
                ? { filled: 0, gateCount, reasons: fillSkipped }
                : {
                    gateCount: plan.gateCount,
                    lineupSize,
                    filled: plan.filled,
                    lineups: fillGroups.length,
                    trialsPerLineup: fillGroups.map((g) => g.count),
                    keys: fillGroups.map((g) => ({ lineup: g.index, sample: g.sample, raceSeed: g.raceSeed })),
                    profile: plan.profile,
                    center: {
                      speed: plan.center.speed,
                      stamina: plan.center.stamina,
                      power: plan.center.power,
                      guts: plan.center.guts,
                      wisdom: plan.center.wisdom,
                      sigma: plan.fieldProfile.sigma ?? 0,
                    },
                    opponentsWinRate: round(opponentsWinRate, 4),
                    example: fillExample,
                  },
          }),
    },
    text,
  );
}

export function registerWinRate(server: McpServer, context: McpContext): void {
  server.registerTool(
    'win_rate',
    {
      title: '出走表から勝率と予想印を出す',
      description:
        '出走する全頭を同時に走らせて、勝率・連対率（2 着以内）・複勝率（3 着以内）・平均着順を出し、予想印（◎○▲△☆）を付ける。' +
        '画面の「全頭同時」と同じ計算で、同じ出走表と seed なら画面と同じ数値になる。' +
        '2〜18 頭。数十秒から数分かかる。画像から書き起こした出走表は、先に check_lineup で点検すること。' +
        '解決できないスキル名があれば、回さずに名前と近い候補を返す。他馬に効くデバフは計算できない。' +
        '出走表が実際の頭数に足りないときは fill_opponents で相手を補える（1 頭だけの出走表でもよい）。' +
        '補う相手は、実在のカードの名簿から引いた推定の想定で、複数の組を引いて合算する。結果の notes に、相手の組み方が載る。',
      inputSchema: {
        lineup: z
          .array(lineupEntrySchema)
          .min(1)
          .max(18)
          .describe('出走表。全項目を書くか、保存した個体を individual で指す。2 頭以上（fill_opponents があれば 1 頭から）'),
        track: trackSchema,
        trials: z.number().int().min(1).max(MAX_TRIALS).default(DEFAULT_TRIALS).describe('試行回数。多いほど勝率の誤差が小さい'),
        seed: z.number().int().default(DEFAULT_SEED).describe('乱数の種。同じ値なら同じ結果になる'),
        skip_unresolved: z
          .boolean()
          .default(false)
          .describe('true なら、解決できないスキルを落として回す。落としたものは notes に載る。利用者に確かめてから使う'),
        fill_opponents: fillOpponentsSchema
          .optional()
          .describe(
            '渡すと、出走表が gate_count 頭（既定 9）に足りない分の相手を、実在のカードの名簿から補う。' +
              '固有 Lv・SP 予算・引く組の数を指定できる（全部省いてよい）。補った相手は推定で、表には出ない。省くと補わない',
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args, extra) => runWinRate(context, args as WinRateArgs, extra),
  );
}
