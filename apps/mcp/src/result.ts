import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * 道具の応答。構造化した JSON と、読める文章の両方を返す（docs/mcp-design.md 4.1 節）。
 * JSON を読めないクライアントでも、文章をそのまま見せられる。
 */
export function toolResult(structured: Record<string, unknown>, text: string): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent: structured };
}

/**
 * 入力の誤りなど、呼び出した側が直せる失敗。`isError` を立てて、何を直すかを文章で返す。
 * 例外を投げると SDK が汎用のメッセージに包むので、直し方まで伝えるときはこちらを使う。
 */
export function toolError(message: string, structured?: Record<string, unknown>): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
    ...(structured === undefined ? {} : { structuredContent: structured }),
  };
}

/** Markdown の表にする。セルの `|` と改行は壊れるので潰す。 */
export function markdownTable(header: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  const cell = (value: string | number): string => String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const lines = [
    `| ${header.map(cell).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ];
  return lines.join('\n');
}
