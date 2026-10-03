import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { matchCourses } from '../../../../packages/sim/src/data/track.ts';
import type { McpContext } from '../context.ts';
import { markdownTable, toolResult } from '../result.ts';

const SURFACE_LABEL: Record<number, string> = { 1: '芝', 2: 'ダート' };
const CATEGORY_LABEL: Record<number, string> = { 1: '短距離', 2: 'マイル', 3: '中距離', 4: '長距離' };

/** 1 回の応答に載せる上限。コースは 300 件ほどあり、全部を返すと文脈を食う。 */
const DEFAULT_LIMIT = 40;

export function registerListCourses(server: McpServer, context: McpContext): void {
  server.registerTool(
    'list_courses',
    {
      title: '競馬場とコースの ID を引く',
      description:
        '競馬場とコースの ID を引く。win_rate などの track に渡す location と course は、ここで引く。' +
        '競馬場名の一部、バ場、距離、距離区分で絞れる。例: ロンシャンの芝 2400m は location 10201、course 11203。',
      inputSchema: {
        location: z.string().optional().describe('競馬場名の一部（「ロンシャン」「東京」）または競馬場 ID'),
        surface: z.enum(['turf', 'dirt']).optional().describe('バ場。turf 芝 / dirt ダート'),
        distance: z.number().int().optional().describe('ちょうどの距離（メートル）'),
        category: z.enum(['short', 'mile', 'mid', 'long']).optional().describe('距離区分'),
        limit: z.number().int().min(1).max(300).default(DEFAULT_LIMIT).describe('返す件数の上限'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ location, surface, distance, category, limit }) => {
      const wantDistanceType = category === undefined ? undefined : { short: 1, mile: 2, mid: 3, long: 4 }[category];
      const surfaces = surface === undefined ? [1, 2] : [surface === 'turf' ? 1 : 2];
      const all = surfaces.flatMap((s) =>
        matchCourses(context.data.trackData, { surface: s, ...(distance !== undefined ? { distance } : {}) }),
      );
      const key = location?.trim();
      const matched = all.filter((course) => {
        if (wantDistanceType !== undefined && course.detail.distanceType !== wantDistanceType) return false;
        if (key === undefined || key === '') return true;
        if (/^\d+$/.test(key)) return String(course.location) === key;
        return course.locationName.includes(key);
      });
      const shown = matched.slice(0, limit);
      const rows = shown.map((course) => ({
        location: course.location,
        course: course.course,
        locationName: course.locationName,
        courseName: course.detail.name,
        distance: course.detail.distance,
        surface: SURFACE_LABEL[course.detail.surface] ?? String(course.detail.surface),
        category: CATEGORY_LABEL[course.detail.distanceType] ?? String(course.detail.distanceType),
      }));
      const notes: string[] = [];
      if (matched.length > shown.length) {
        notes.push(`${matched.length} 件のうち ${shown.length} 件だけを返しました。絞り込みを足すか limit を増やしてください。`);
      }
      if (matched.length === 0) notes.push('当たるコースがありません。競馬場名の綴りや、距離が実在するかを確かめてください。');
      const text = [
        rows.length === 0
          ? '当たるコースがありません。'
          : markdownTable(
              ['location', 'course', '競馬場', 'コース', '距離', 'バ場', '区分'],
              rows.map((r) => [r.location, r.course, r.locationName, r.courseName, r.distance, r.surface, r.category]),
            ),
        ...(notes.length > 0 ? ['', ...notes.map((n) => `- ${n}`)] : []),
      ].join('\n');
      return toolResult({ total: matched.length, courses: rows, notes }, text);
    },
  );
}
