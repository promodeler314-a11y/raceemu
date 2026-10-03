import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpContext } from '../context.ts';
import type { StoredIndividual } from '../individuals.ts';
import { prepareRunner } from '../lineup-service.ts';
import { markdownTable, toolError, toolResult } from '../result.ts';
import { runnerSchema, toLineupRunner } from '../schemas.ts';
import { describeRunner } from './check-lineup.ts';

/**
 * 個体の保存。docs/mcp-design.md 3.8 節を参照。
 * 保存するのは書き起こした個体で、画像ではない。
 */

function summarize(individual: StoredIndividual): Record<string, unknown> {
  return {
    id: individual.id,
    label: individual.label,
    name: individual.runner.name,
    chara: individual.runner.chara ?? null,
    status: individual.runner.status,
    uniqueLevel: individual.runner.unique?.level ?? null,
    skillCount: individual.runner.skills.length,
    createdAt: individual.createdAt,
    updatedAt: individual.updatedAt,
  };
}

export function registerIndividualTools(server: McpServer, context: McpContext): void {
  server.registerTool(
    'save_individual',
    {
      title: '書き起こした個体を保存する',
      description:
        '画像から書き起こした個体（ステータス、適性、固有、スキル）を保存する。あとで win_rate などの出走表に、' +
        '全項目の代わりに {"individual": "呼び名"} と書いて指せる。保存するのは書き起こした内容で、画像は保存しない。' +
        '利用者が保存を望み、読み取り結果を確かめてもらってから呼ぶこと。' +
        'ウマ娘名・ステータス 5 つ・固有 Lv が全部同じ個体は、同じ個体とみなして上書きする（updated: true）。' +
        'スキル名を解決できないものが残っていれば保存しない。',
      inputSchema: {
        runner: runnerSchema.describe('保存する個体。check_lineup を通したものを渡す'),
        label: z.string().max(100).optional().describe('呼び名。省くと chara（なければ name）。出走表で指すときに使う'),
        skip_unresolved: z
          .boolean()
          .default(false)
          .describe('true なら、解決できないスキル名（他馬に効くデバフなど）が残っていても保存する。名前はそのまま残る'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ runner, label, skip_unresolved }) => {
      const lineupRunner = toLineupRunner(runner);
      const prepared = prepareRunner(0, lineupRunner, null, context.resolver);
      if (prepared.skills.unresolved.length > 0 && !skip_unresolved) {
        const lines = prepared.skills.unresolved.map(
          (u) =>
            `- 「${u.input}」→ 近い候補: ${u.candidates.length === 0 ? 'なし' : u.candidates.map((c) => c.name).join('、')}`,
        );
        return toolError(
          [
            '解決できないスキル名があるため、保存していません。',
            ...lines,
            '',
            '画像を見直して名前を直してください。データに無いスキル（他馬に効くデバフなど）を残して保存するなら、skip_unresolved: true を使います。',
          ].join('\n'),
          { unresolved: prepared.skills.unresolved.map((u) => u.input) },
        );
      }
      const result = context.store.save(
        lineupRunner,
        prepared.skills.skills.map((s) => s.id),
        label,
      );
      const warnings = describeRunner(prepared)['warnings'] as { code: string; message: string }[];
      const stored = result.individual;
      const text = [
        result.updated
          ? `同じ個体（${stored.label}）を上書きしました。`
          : `保存しました: ${stored.label}（id ${stored.id}）`,
        `スキル ${prepared.skills.skills.length} 個を解決して保存しました（入力 ${lineupRunner.skills.length + (lineupRunner.unique === undefined ? 0 : 1)} 個）。`,
        ...(prepared.skills.unresolved.length > 0
          ? [`解決できず、名前だけを残したスキル: ${prepared.skills.unresolved.map((u) => u.input).join('、')}。計算には入りません。`]
          : []),
        ...(warnings.length > 0 ? ['', '警告:', ...warnings.map((w) => `- ${w.message}`)] : []),
        '',
        `あとの出走表では {"individual": "${stored.label}"} で指せます。`,
      ].join('\n');
      return toolResult(
        {
          saved: true,
          updated: result.updated,
          individual: summarize(stored),
          unresolved: prepared.skills.unresolved.map((u) => u.input),
          warnings,
        },
        text,
      );
    },
  );

  server.registerTool(
    'list_individuals',
    {
      title: '保存した個体の一覧',
      description:
        '保存した個体の一覧を、新しく保存（更新）した順に返す。呼び名やウマ娘名の一部で絞れる。' +
        '各個体の id、呼び名、ウマ娘名、ステータス、スキル数、保存日時を返す。',
      inputSchema: {
        query: z.string().optional().describe('呼び名またはウマ娘名の一部'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ query }) => {
      const list = context.store.list(query);
      const rows = list.map((individual) => summarize(individual));
      const text =
        list.length === 0
          ? query === undefined || query === ''
            ? '保存した個体はありません。'
            : `「${query}」に当たる個体はありません。`
          : markdownTable(
              ['呼び名', 'ウマ娘', 'スピード', 'スタミナ', 'パワー', '根性', '賢さ', 'スキル', '更新', 'id'],
              list.map((i) => [
                i.label,
                i.runner.chara ?? i.runner.name,
                i.runner.status.speed,
                i.runner.status.stamina,
                i.runner.status.power,
                i.runner.status.guts,
                i.runner.status.wisdom,
                i.runner.skills.length,
                i.updatedAt.slice(0, 10),
                i.id,
              ]),
            );
      return toolResult({ total: list.length, individuals: rows }, text);
    },
  );

  server.registerTool(
    'delete_individual',
    {
      title: '保存した個体を消す',
      description:
        '保存した個体を id で消す。**取り消せない。** 必ず利用者に、どの個体を消すかを確かめてから呼ぶこと。' +
        'id は list_individuals で引く。呼び名では消せない（同じ呼び名が複数あるため）。',
      inputSchema: {
        id: z.string().min(1).describe('消す個体の id（list_individuals の id）'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ id }) => {
      const target = context.store.get(id);
      if (target === null) {
        return toolError(`id「${id}」の個体は見つかりません。list_individuals で id を確かめてください。`);
      }
      const deleted = context.store.remove(id);
      return toolResult(
        { deleted, individual: summarize(target) },
        deleted ? `消しました: ${target.label}（id ${id}）` : `消せませんでした: ${id}`,
      );
    },
  );
}
