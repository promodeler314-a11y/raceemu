import { z } from 'zod';
import { DEFAULT_ROSTER_PROFILE } from '../../../packages/sim/src/field/opponent-roster.ts';
import type { LineupRunner } from '../../../packages/sim/src/multi/lineup.ts';

/**
 * 道具の入力の型。出走表の形は docs/mcp-design.md 3.1 節に対応している。
 * `.describe()` の文章は、クライアントが道具の説明として Claude に見せる。
 */

const fit = z.enum(['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G']);
const style = z.enum(['nige', 'sen', 'sasi', 'oi']);

export const runnerSchema = z.object({
  name: z.string().min(1).describe('表示に使う名前。ウマ娘名でよい'),
  chara: z
    .string()
    .optional()
    .describe('固有スキルの持ち主。`[勝負服]ウマ娘名` またはウマ娘名。固有スキルを引くのに使う'),
  status: z
    .object({
      speed: z.number().int(),
      stamina: z.number().int(),
      power: z.number().int(),
      guts: z.number().int(),
      wisdom: z.number().int(),
    })
    .describe('ステータス 5 つの数値'),
  statusRank: z
    .object({
      speed: z.string().optional(),
      stamina: z.string().optional(),
      power: z.string().optional(),
      guts: z.string().optional(),
      wisdom: z.string().optional(),
    })
    .optional()
    .describe('画像のランク文字（A+ や B など）。数値の読み違いを見つけるのに使う。画像から書き起こすときは必ず付ける'),
  aptitude: z
    .object({
      surface: z.object({ turf: fit, dirt: fit }),
      distance: z.object({ short: fit, mile: fit, mid: fit, long: fit }),
      style: z.object({ nige: fit, sen: fit, sasi: fit, oi: fit }),
    })
    .describe('適性 10 項目。コースで絞らず全部書く'),
  unique: z
    .object({
      name: z.string(),
      level: z.number().int().min(0).max(10).optional().describe('画像の Lv。写っていなければ省く'),
    })
    .optional()
    .describe('固有スキル。虹色の枠の先頭の行'),
  skills: z.array(z.string()).describe('所持スキルの名前（固有を除く）。ID（数字）でもよい'),
  style: style.optional().describe('省くと適性が最も高い脚質。nige 逃げ / sen 先行 / sasi 差し / oi 追込'),
  rating: z.number().optional().describe('ウマ娘評価点。人気の既定を決める'),
  condition: z.enum(['BEST', 'GOOD', 'NORMAL', 'BAD', 'WORST']).optional().describe('やる気。既定は BEST'),
});

/** 保存した個体を指す。ステータスとスキルは上書きできない。 */
export const individualRefSchema = z.object({
  individual: z.string().min(1).describe('保存した個体の id、または呼び名'),
  style: style.optional(),
  condition: z.enum(['BEST', 'GOOD', 'NORMAL', 'BAD', 'WORST']).optional(),
  rating: z.number().optional(),
});

export const lineupEntrySchema = z.union([runnerSchema, individualRefSchema]);
export type LineupEntry = z.infer<typeof lineupEntrySchema>;
export type IndividualRef = z.infer<typeof individualRefSchema>;

export function isIndividualRef(entry: LineupEntry): entry is IndividualRef {
  return 'individual' in entry;
}

export const trackSchema = z.object({
  location: z.number().int().describe('競馬場 ID。list_courses で引く。ロンシャンは 10201'),
  course: z.number().int().describe('コース ID。list_courses で引く'),
  condition: z.number().int().min(1).max(4).default(1).describe('馬場状態。1 良 / 2 稍重 / 3 重 / 4 不良'),
  season: z.number().int().min(1).max(4).default(1).describe('季節。1 春 / 2 夏 / 3 秋 / 4 冬'),
  weather: z
    .number()
    .int()
    .min(1)
    .max(4)
    .default(1)
    .describe('天候。1 晴 / 2 曇 / 3 雨 / 4 雪。馬場状態を不良にしても雨にはならない'),
  time: z.number().int().min(1).max(4).default(1).describe('時刻。4 でナイター。通常は 1'),
});
export type TrackInput = z.infer<typeof trackSchema>;

/**
 * 出走表の頭数が足りないときに、相手を補う指定（`win_rate` の `fill_opponents`）。
 * 渡さなければ補わない。`{}` でも補う（全項目に既定がある）。docs/mcp-design.md 3.3 節。
 */
export const fillOpponentsSchema = z.object({
  gate_count: z
    .number()
    .int()
    .min(2)
    .max(18)
    .default(9)
    .describe('出走頭数の合計。出走表がこれに足りない分だけ相手を補う。既定は 9（チャンピオンズミーティング）'),
  sp_budget: z
    .number()
    .min(0)
    .optional()
    .describe(
      '補う相手が白・金・緑のスキルに使う SP の予算（表示されている SP の合計）。大きいほど相手が強い。' +
        '省くと、出走表の頭が持つ白・金・緑の表示 SP の平均に揃える（相手を自分と同格にする）。' +
        `出走表の頭がスキルを持たないときは ${DEFAULT_ROSTER_PROFILE.spBudget}`,
    ),
  unique_level: z
    .number()
    .int()
    .min(1)
    .max(6)
    .default(DEFAULT_ROSTER_PROFILE.uniqueLevel)
    .describe(`補う相手の固有スキルのレベル。既定は ${DEFAULT_ROSTER_PROFILE.uniqueLevel}`),
  lineups: z
    .number()
    .int()
    .min(1)
    .max(32)
    .default(8)
    .describe('補う相手を何組引くか。試行をこの数で等分して回し、合算する。多いほど、相手の引き方による偏りが小さい。既定は 8'),
});
export type FillOpponentsInput = z.infer<typeof fillOpponentsSchema>;

/** zod で検査した出走表 1 頭を、シミュレータ側の型に直す。形は同じなので、型を合わせるだけ。 */
export function toLineupRunner(runner: z.infer<typeof runnerSchema>): LineupRunner {
  return runner as LineupRunner;
}
