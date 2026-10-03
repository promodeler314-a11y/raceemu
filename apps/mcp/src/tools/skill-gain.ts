import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { SkillData } from '../../../../packages/sim/src/skill/types.ts';
import { RaceCalculator } from '../../../../packages/sim/src/calculator.ts';
import { bashinMeters } from '../../../../packages/sim/src/data/constants.ts';
import { buildFieldBundle, defaultFieldProfile } from '../../../../packages/sim/src/field/field.ts';
import { buildRaceSetting } from '../../../../packages/sim/src/multi/lineup.ts';
import { defaultSystemSetting, type TrackRef } from '../../../../packages/sim/src/setting.ts';
import type { McpContext } from '../context.ts';
import { prepareLineup, round, unresolvedOf } from '../lineup-service.ts';
import { markdownTable, toolError, toolResult } from '../result.ts';
import { progressReporter } from '../runtime.ts';
import { lineupEntrySchema, trackSchema, type LineupEntry, type TrackInput } from '../schemas.ts';
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
}

interface Extra {
  readonly signal: AbortSignal;
  readonly _meta?: { readonly progressToken?: string | number };
  readonly sendNotification: Parameters<typeof progressReporter>[0]['sendNotification'];
}

function meanAndSe(values: readonly number[]): { mean: number; se: number } {
  const n = values.length;
  if (n === 0) return { mean: 0, se: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { mean, se: 0 };
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return { mean, se: Math.sqrt(variance / n) };
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
  const report = progressReporter(extra, 'スキルを足したときの差を測っています');

  const started = performance.now();
  let gains: { seconds: number[]; bashin: number[]; baseTime: number[]; endSpeed: number[] };
  try {
    gains = await context.runtime.run(async () => {
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
          report(trial + 1, args.trials);
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      report(args.trials, args.trials);
      return out;
    }, extra.signal);
  } catch (error) {
    if (extra.signal.aborted) return toolError('中断されました。');
    throw error;
  }
  const elapsedMs = performance.now() - started;

  const bashin = meanAndSe(gains.bashin);
  const seconds = meanAndSe(gains.seconds);
  const base = meanAndSe(gains.baseTime);
  const endSpeed = meanAndSe(gains.endSpeed);
  const cost = toAdd.reduce((sum, s) => sum + s.sp, 0);

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
  // 差も誤差も厳密に 0 のときは、スキルがそもそも発動していない。`<` では 0 < 0 で漏れる。
  if (Math.abs(bashin.mean) <= 2 * bashin.se) {
    notes.push('獲得バ身は誤差の範囲で、0 と区別できません。試行回数を増やすか、発動しない条件（脚質・距離）でないかを確かめてください。');
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
    '',
    '注意:',
    ...notes.map((n) => `- ${n}`),
  ].join('\n');

  return toolResult(
    {
      runner: self.runner.name,
      added: toAdd.map((s) => ({ id: s.id, name: s.name, rarity: s.rarity, sp: s.sp })),
      track: { name: courseName, distance: detail.distance, condition: args.track.condition },
      trials: args.trials,
      seed: args.seed,
      fieldSize: args.field_size,
      bashin: { mean: round(bashin.mean, 3), se: round(bashin.se, 3) },
      seconds: { mean: round(seconds.mean, 4), se: round(seconds.se, 4) },
      baseline: { meanTime: round(base.mean, 3), endSpeed: round(endSpeed.mean, 3) },
      costSp: cost,
      elapsedMs: Math.round(elapsedMs),
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
        '1 バ身 = 2.5 m の換算はゲームで実測していない。脚質・距離の条件を満たさないスキルは 0 バ身になる。',
      inputSchema: {
        runner: lineupEntrySchema.describe('スキルを足す 1 頭。全項目を書くか、保存した個体を individual で指す'),
        add: z.array(z.string().min(1)).min(1).max(10).describe('足すスキルの名前。複数なら全部をまとめて足した差を返す'),
        track: trackSchema,
        trials: z.number().int().min(1).max(MAX_GAIN_TRIALS).default(DEFAULT_GAIN_TRIALS),
        seed: z.number().int().default(1),
        field_size: z.number().int().min(2).max(18).default(9).describe('出走頭数。既定はチャンピオンズミーティングの 9'),
        skip_unresolved: z.boolean().default(false).describe('true なら、解決できないスキルを落として回す'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args, extra) => runSkillGain(context, args as SkillGainArgs, extra),
  );
}
