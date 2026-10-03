import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpContext } from '../context.ts';
import { markdownTable, toolResult } from '../result.ts';

const manifestPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'packages',
  'sim',
  'upstream',
  'race-manifest.json',
);

/**
 * 計算モデルの版。本家の `race` モジュールの指紋表（`race-manifest.json`）の指紋である。
 * 計算式を追随させたときに変わる。改行は LF にそろえてから求める（Windows の CRLF 対策）。
 */
function raceModelDigest(): { digest: string; files: number } | null {
  try {
    const text = readFileSync(manifestPath, 'utf8').replace(/\r\n/g, '\n');
    const files = Object.keys((JSON.parse(text) as { files: Record<string, string> }).files).length;
    return { digest: `sha256:${createHash('sha256').update(text).digest('hex')}`, files };
  } catch {
    return null;
  }
}

export function dataInfo(context: McpContext): Record<string, unknown> {
  const { data, meta } = context;
  const rarities: Record<string, number> = {};
  for (const skill of data.skills) rarities[skill.rarity] = (rarities[skill.rarity] ?? 0) + 1;
  let courses = 0;
  for (const location of Object.values(data.trackData)) courses += Object.keys(location.courses).length;
  const notes: string[] = [];
  if (meta === null) {
    notes.push('データの取得日が分かりません（assets/meta.json が無い、または壊れています）。');
  } else {
    notes.push(
      `データは ${meta.syncedAt} に最後に変わりました。それ以降に本家へ追加されたウマ娘やスキルは入っていない可能性があります。` +
        '出走表のスキルが解決できないときは、データが古いことを疑ってください。',
    );
  }
  return {
    skills: { total: data.skills.length, byRarity: rarities },
    locations: Object.keys(data.trackData).length,
    courses,
    syncedAt: meta?.syncedAt ?? null,
    digest: meta?.digest ?? null,
    source: meta?.source ?? null,
    raceModel: raceModelDigest(),
    notes,
  };
}

export function registerDataInfo(server: McpServer, context: McpContext): void {
  server.registerTool(
    'data_info',
    {
      title: 'データの取得日と件数',
      description:
        'エミュレータが持つゲームデータ（スキル、コース）の取得日と件数、計算モデルの版を返す。' +
        '新しいウマ娘やスキルが解決できないときに、データが古くないかを確かめるために使う。',
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    () => {
      const info = dataInfo(context);
      const skills = info['skills'] as { total: number; byRarity: Record<string, number> };
      const text = [
        markdownTable(
          ['項目', '値'],
          [
            ['データの最終更新日', String(info['syncedAt'] ?? '不明')],
            ['スキル', skills.total],
            ['競馬場', String(info['locations'])],
            ['コース', String(info['courses'])],
            ['出どころ', String(info['source'] ?? '不明')],
          ],
        ),
        '',
        ...(info['notes'] as string[]).map((note) => `- ${note}`),
      ].join('\n');
      return toolResult(info, text);
    },
  );
}
