import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { distanceFitOf, surfaceFitOf } from '../../../../packages/sim/src/multi/lineup.ts';
import type { McpContext } from '../context.ts';
import {
  describeResolution,
  prepareLineup,
  styleLabel,
  type PrepareFailure,
  type PreparedRunner,
} from '../lineup-service.ts';
import { markdownTable, toolResult } from '../result.ts';
import { lineupEntrySchema, trackSchema } from '../schemas.ts';

/** 点検の応答 1 頭ぶん。`save_individual` からも使う。 */
export function describeRunner(prepared: PreparedRunner): Record<string, unknown> {
  const { runner, skills, style } = prepared;
  return {
    index: prepared.index,
    name: runner.name,
    individualId: prepared.individualId,
    style: { key: style.style, label: styleLabel(style), source: style.source, reason: style.reason },
    skillCount: skills.skills.length,
    unresolvedCount: skills.unresolved.length,
    // 入力した順。画像と見比べられるよう、畳む前のまま並べる。
    skills: skills.entries.map(describeResolution),
    warnings: [
      ...skills.warnings.map((w) => ({ code: w.code, message: w.message })),
      ...prepared.issues.map((i) => ({ code: i.code, message: i.message })),
    ],
  };
}

export function describeFailure(failure: PrepareFailure): string {
  return failure.kind === 'individual_not_found'
    ? `${failure.index + 1} 頭目: 保存した個体「${failure.key}」が見つかりません。list_individuals で確かめてください。`
    : `${failure.index + 1} 頭目: 個体「${failure.key}」は複数に当たります。id で指してください: ${failure.candidates.map((c) => `${c.label}（${c.id}）`).join('、')}`;
}

export function registerCheckLineup(server: McpServer, context: McpContext): void {
  server.registerTool(
    'check_lineup',
    {
      title: '出走表を計算せずに点検する',
      description:
        '出走表を、レースを回さずに点検する。数秒で終わる。画像から書き起こした出走表は、win_rate を呼ぶ前に必ずここを通す。' +
        '返すもの: 入力したスキル名と採ったスキルの対応（画像と見比べる）、解決できなかった名前と近い候補、採ったスキルの数、採った脚質とその理由、警告。' +
        '警告: 同じスキルの重複（畳む）、同じグループのスキルを 2 つ持つ（読み違いの疑い）、固有スキルが見つからない、' +
        'ステータスの数値とランク文字（statusRank）の食い違い（数字の読み違いの疑い）。' +
        'track を渡すと、そのコースで使う距離・バ場・脚質の適性も返す。',
      inputSchema: {
        lineup: z.array(lineupEntrySchema).min(1).max(18).describe('出走表。全項目を書くか、保存した個体を individual で指す'),
        track: trackSchema.optional().describe('渡すと、そのコースで使う適性を返す'),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ lineup, track }) => {
      const prepared = prepareLineup(lineup, context.resolver, context.individuals);
      const detail = track === undefined ? undefined : context.data.trackData[track.location]?.courses[track.course];
      const runners = prepared.runners.map((p) => {
        const base = describeRunner(p);
        if (detail === undefined) return base;
        return {
          ...base,
          fits: {
            distance: distanceFitOf(p.runner, detail.distanceType),
            surface: surfaceFitOf(p.runner, detail.surface),
            style: p.runner.aptitude.style[p.style.style],
          },
        };
      });
      const unresolved = prepared.runners.reduce((n, p) => n + p.skills.unresolved.length, 0);
      const warnings = prepared.runners.reduce((n, p) => n + p.skills.warnings.length + p.issues.length, 0);
      const notes: string[] = [];
      if (track !== undefined && detail === undefined) notes.push('track の競馬場とコースが見つかりません。list_courses で引いてください。');
      for (const failure of prepared.failures) notes.push(describeFailure(failure));
      const ok = unresolved === 0 && prepared.failures.length === 0;
      const summary = { runners: lineup.length, unresolved, warnings, failures: prepared.failures.length, ok };

      const sections = prepared.runners.map((p) => {
        const lines = [`## ${p.index + 1}. ${p.runner.name}`, ''];
        lines.push(
          `脚質: ${styleLabel(p.style)}（${p.style.reason}） / スキル ${p.skills.skills.length} 個を採用 / 解決できない ${p.skills.unresolved.length} 個`,
        );
        if (p.skills.unresolved.length > 0) {
          lines.push('', '解決できなかった名前:');
          for (const u of p.skills.unresolved) {
            lines.push(
              `- 「${u.input}」→ 近い候補: ${u.candidates.length === 0 ? 'なし' : u.candidates.map((c) => `${c.name}（${c.rarity}）`).join('、')}`,
            );
          }
        }
        const allWarnings = [...p.skills.warnings.map((w) => w.message), ...p.issues.map((i) => i.message)];
        if (allWarnings.length > 0) {
          lines.push('', '警告:');
          for (const w of allWarnings) lines.push(`- ${w}`);
        }
        return lines.join('\n');
      });
      const text = [
        ok
          ? `点検しました。解決できない名前はありません（警告 ${warnings} 件）。`
          : `解決できていないものがあります（名前 ${unresolved} 個、個体 ${prepared.failures.length} 件）。直してからもう一度呼んでください。`,
        '',
        markdownTable(
          ['#', '名前', '脚質', 'スキル', '未解決', '警告'],
          prepared.runners.map((p) => [
            p.index + 1,
            p.runner.name,
            styleLabel(p.style),
            p.skills.skills.length,
            p.skills.unresolved.length,
            p.skills.warnings.length + p.issues.length,
          ]),
        ),
        '',
        ...sections,
        ...(notes.length > 0 ? ['', ...notes.map((n) => `- ${n}`)] : []),
      ].join('\n');
      return toolResult({ summary, runners, notes }, text);
    },
  );
}
