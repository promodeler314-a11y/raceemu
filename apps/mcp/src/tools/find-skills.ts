import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpContext } from '../context.ts';
import { round } from '../lineup-service.ts';
import { markdownTable, toolResult } from '../result.ts';

export function registerFindSkills(server: McpServer, context: McpContext): void {
  server.registerTool(
    'find_skills',
    {
      title: 'スキル名から ID と種別と費用を引く',
      description:
        'スキル名から ID、種別（rarity）、費用（sp）を引く。出走表に使うときに採られるスキル（pick）と、近い候補を返す。' +
        '名前の揺れ（〜と～、涛と濤、ヘとへ、丸印）は吸収するが、近い名前を勝手に採ることはしない。' +
        '種別: unique 固有 / inherit 他のウマ娘の固有の継承版 / evo 進化 / rare 金 / normal 白 / special 特別 / scenario シナリオ。',
      inputSchema: {
        names: z.array(z.string().min(1)).min(1).max(50).describe('調べるスキル名'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ names }) => {
      const results = names.map((query) => {
        const hit = context.resolver.resolve(query);
        const candidates = context.resolver.search(query, 5).map((c) => ({
          id: c.id,
          name: c.name,
          rarity: c.rarity,
          sp: c.sp,
          holder: c.holder,
          score: round(c.score),
        }));
        if (hit.status === 'resolved') {
          return {
            query,
            status: 'resolved' as const,
            pick: { id: hit.skill.id, name: hit.skill.name, rarity: hit.skill.rarity, sp: hit.skill.sp },
            alternatives: hit.alternatives.map((s) => ({ id: s.id, name: s.name, rarity: s.rarity, sp: s.sp })),
            candidates,
          };
        }
        return { query, status: 'unresolved' as const, reason: hit.reason, pick: null, alternatives: [], candidates };
      });
      const rows = results.map((r) => [
        r.query,
        r.pick === null ? `解決できない（${r.status === 'unresolved' ? r.reason : ''}）` : `${r.pick.name}（${r.pick.rarity} / ${r.pick.id} / ${r.pick.sp}pt）`,
        r.alternatives.length === 0 ? '' : r.alternatives.map((a) => `${a.rarity} ${a.id}`).join('、'),
        r.pick === null ? r.candidates.map((c) => c.name).join('、') : '',
      ]);
      const text = markdownTable(['入力', '採られるスキル', '同名の別の版', '近い候補'], rows);
      return toolResult({ results }, text);
    },
  );
}
