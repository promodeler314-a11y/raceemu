import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpContext } from './context.ts';
import { INSTRUCTIONS } from './instructions.ts';
import { registerCheckLineup } from './tools/check-lineup.ts';
import { registerDataInfo } from './tools/data-info.ts';
import { registerFindSkills } from './tools/find-skills.ts';
import { registerIndividualTools } from './tools/individuals.ts';
import { registerListCourses } from './tools/list-courses.ts';
import { registerSkillGain } from './tools/skill-gain.ts';
import { registerWinRate } from './tools/win-rate.ts';

/**
 * MCP サーバーを作る。通信路はつながない（`main.ts` が stdio を、テストがメモリ上の通信路をつなぐ）。
 * 道具は docs/mcp-design.md 7 節の順序で足している。
 */
export function createRaceemuServer(context: McpContext): McpServer {
  const server = new McpServer({ name: 'raceemu', version: '0.0.0' }, { instructions: INSTRUCTIONS });
  registerDataInfo(server, context);
  registerListCourses(server, context);
  registerFindSkills(server, context);
  registerCheckLineup(server, context);
  registerWinRate(server, context);
  registerSkillGain(server, context);
  registerIndividualTools(server, context);
  return server;
}
