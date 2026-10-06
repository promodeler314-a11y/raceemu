import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDataMeta, loadGameData } from '../../../packages/data/src/node.ts';
import { SkillResolver } from '../../../packages/data/src/skill-resolve.ts';
import { RaceCalculator } from '../../../packages/sim/src/calculator.ts';
import { assignPopularity, buildRaceSetting, type LineupRunner } from '../../../packages/sim/src/multi/lineup.ts';
import { runMultiRace } from '../../../packages/sim/src/multi/race.ts';
import { OrderTally } from '../../../packages/sim/src/multi/summary.ts';
import { defaultSystemSetting, type TrackRef } from '../../../packages/sim/src/setting.ts';
import { createContext } from '../src/context.ts';
import { buildFillGroups, planFill } from '../src/fill-opponents.ts';
import { IndividualStore } from '../src/individuals.ts';
import { round } from '../src/lineup-service.ts';
import { createRaceemuServer } from '../src/server.ts';
import { toLineupRunner, type LineupEntry } from '../src/schemas.ts';
import { DEBUFF_NAMES, LINEUP_11 } from './fixtures/race-lineup.ts';

/**
 * MCP を通した道具の検査。メモリ上の通信路で、クライアントとサーバーをつなぐ。
 * 標準出力の検査は stdio.test.ts にある。docs/mcp-design.md 8 節に対応する。
 *
 * Worker の起動は遅いので、プールは 1 つのファイルで共有し、最後に止める。
 */

const data = loadGameData();
const meta = loadDataMeta();
// 実際のホーム（~/.raceemu）を触らないよう、個体の保存先は一時ディレクトリにする。
const dataDir = mkdtempSync(join(tmpdir(), 'raceemu-mcp-test-'));
const context = createContext({ data, meta, concurrency: 2, store: new IndividualStore(dataDir) });
const server = createRaceemuServer(context);
const client = new Client({ name: 'tools-test', version: '0' });

beforeAll(async () => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

afterAll(async () => {
  await client.close();
  await context.runtime.dispose();
  context.store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: Record<string, any>;
}

async function call(name: string, args: Record<string, unknown> = {}, options?: Parameters<typeof client.callTool>[2]) {
  return (await client.callTool({ name, arguments: args }, undefined, options)) as unknown as ToolResult;
}

const LONGCHAMP = { location: 10201, course: 11203, condition: 4 };
const TOKYO_2400 = { location: 10006, course: 10606, condition: 1 };
const byName = (name: string): LineupEntry => LINEUP_11.find((e) => 'name' in e && e.name === name)!;
/** デバフを除いた出走表（全部解決できる） */
const withoutDebuffs = (entry: LineupEntry): LineupEntry =>
  'skills' in entry ? { ...entry, skills: entry.skills.filter((s) => !DEBUFF_NAMES.includes(s)) } : entry;

describe('道具の一覧', () => {
  it('設計書の 9 つがそろっている。書き込む道具以外は、読み取り専用と宣言している', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'check_lineup',
      'data_info',
      'delete_individual',
      'find_skills',
      'list_courses',
      'list_individuals',
      'save_individual',
      'skill_gain',
      'win_rate',
    ]);
    const writers = ['save_individual', 'delete_individual'];
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(!writers.includes(tool.name));
      expect(tool.description?.length ?? 0, tool.name).toBeGreaterThan(20);
    }
    // 消す道具だけが、破壊的だと宣言している。クライアントが確認を挟めるように。
    const destructive = tools.filter((t) => t.annotations?.destructiveHint === true).map((t) => t.name);
    expect(destructive).toEqual(['delete_individual']);
  });
});

describe('data_info', () => {
  it('取得日と件数を返す', async () => {
    const res = await call('data_info');
    expect(res.isError).not.toBe(true);
    const info = res.structuredContent!;
    expect(info['syncedAt']).toBe(meta?.syncedAt);
    expect(info['skills'].total).toBe(data.skills.length);
    expect(res.content[0]!.text).toContain('データの最終更新日');
  });
});

describe('list_courses', () => {
  it('ロンシャンの芝 2400m の ID を引ける', async () => {
    const res = await call('list_courses', { location: 'ロンシャン', distance: 2400 });
    const courses = res.structuredContent!['courses'] as { location: number; course: number; distance: number }[];
    expect(courses).toEqual([expect.objectContaining({ location: 10201, course: 11203, distance: 2400 })]);
  });

  it('競馬場 ID でも、距離区分でも絞れる', async () => {
    const byId = await call('list_courses', { location: '10006', surface: 'turf', category: 'mid' });
    const courses = byId.structuredContent!['courses'] as { location: number; category: string }[];
    expect(courses.length).toBeGreaterThan(0);
    expect(courses.every((c) => c.location === 10006 && c.category === '中距離')).toBe(true);
  });

  it('当たるものが無いときは、そう伝える', async () => {
    const res = await call('list_courses', { location: '存在しない競馬場' });
    expect(res.structuredContent!['total']).toBe(0);
    expect(res.content[0]!.text).toContain('当たるコースがありません');
  });

  it('件数が上限を超えるときは、打ち切ったことを伝える', async () => {
    const res = await call('list_courses', { limit: 5 });
    expect((res.structuredContent!['courses'] as unknown[]).length).toBe(5);
    expect((res.structuredContent!['notes'] as string[]).join('')).toContain('だけを返しました');
  });
});

describe('find_skills', () => {
  it('名前の揺れを吸収して引ける', async () => {
    const res = await call('find_skills', { names: ['怒涛のポロロッカ', 'あま〜い幻惑'] });
    const results = res.structuredContent!['results'] as { status: string; pick: { name: string } }[];
    expect(results.map((r) => r.pick.name)).toEqual(['怒濤のポロロッカ', 'あま～い幻惑']);
  });

  it('読み違えた名前は、採らずに候補を返す', async () => {
    const res = await call('find_skills', { names: ['送る月流星'] });
    const [hit] = res.structuredContent!['results'] as { status: string; pick: unknown; candidates: { name: string }[] }[];
    expect(hit!.status).toBe('unresolved');
    expect(hit!.pick).toBeNull();
    expect(hit!.candidates[0]!.name).toBe('迸る月流星');
  });
});

describe('check_lineup', () => {
  it('会話で使った 11 頭: 解決できないのはデバフの 3 つだけで、ランクの食い違いは出ない', async () => {
    const res = await call('check_lineup', { lineup: LINEUP_11, track: LONGCHAMP });
    const structured = res.structuredContent!;
    expect(structured['summary']).toMatchObject({ runners: 11, unresolved: 3, ok: false });
    const runners = structured['runners'] as { name: string; unresolvedCount: number; warnings: { code: string }[]; skillCount: number }[];
    const unresolved = Object.fromEntries(runners.filter((r) => r.unresolvedCount > 0).map((r) => [r.name, r.unresolvedCount]));
    expect(unresolved).toEqual({ ファインモーション: 2, スーパークリーク: 1 });
    // 画像 11 枚のステータスとランク文字は、100 刻みの表と全部合う（表の根拠の確認）。
    const codes = runners.flatMap((r) => r.warnings.map((w) => w.code));
    expect(codes).not.toContain('rank_mismatch');
    expect(codes).not.toContain('status_range');
    // 重複も、同じグループの 2 つもない。
    expect(codes).not.toContain('duplicate');
    expect(codes).not.toContain('same_group');
  });

  it('デバフを除けば、すべて解決できる', async () => {
    const res = await call('check_lineup', { lineup: LINEUP_11.map(withoutDebuffs) });
    expect(res.structuredContent!['summary']).toMatchObject({ unresolved: 0, ok: true });
  });

  it('track を渡すと、そのコースで使う適性を返す', async () => {
    const res = await call('check_lineup', { lineup: [withoutDebuffs(byName('エルコンドルパサー'))], track: LONGCHAMP });
    const [runner] = res.structuredContent!['runners'] as { fits: Record<string, string>; style: { key: string } }[];
    // ロンシャン 2400m の芝は、中距離（S）、芝（A）、先行（A）。
    expect(runner!.fits).toEqual({ distance: 'S', surface: 'A', style: 'A' });
    expect(runner!.style.key).toBe('sen');
  });

  it('数字を読み違えると、ランク文字との食い違いで見つかる', async () => {
    const el = withoutDebuffs(byName('エルコンドルパサー')) as Extract<LineupEntry, { status: unknown }>;
    // 913（A+）を 713 と読み違えた。
    const wrong = { ...el, status: { ...el.status, stamina: 713 } };
    const res = await call('check_lineup', { lineup: [wrong] });
    const [runner] = res.structuredContent!['runners'] as { warnings: { code: string; message: string }[] }[];
    const warning = runner!.warnings.find((w) => w.code === 'rank_mismatch');
    expect(warning?.message).toContain('スタミナ 713');
    expect(warning?.message).toContain('A+');
  });

  it('同じスキルの重複は畳み、同じグループの 2 つは警告する', async () => {
    const el = withoutDebuffs(byName('エルコンドルパサー')) as Extract<LineupEntry, { skills: unknown }>;
    const dirty = { ...el, skills: [...el.skills, '王手', '右回り◎'] };
    const res = await call('check_lineup', { lineup: [dirty] });
    const [runner] = res.structuredContent!['runners'] as { skillCount: number; warnings: { code: string }[] }[];
    const codes = runner!.warnings.map((w) => w.code);
    expect(codes).toContain('duplicate');
    expect(codes).toContain('same_group'); // 右回り○ と 右回り◎
    // 畳んだぶん、採った数は入力より少ない。
    expect(runner!.skillCount).toBe(el.skills.length + 1 /* 固有 */ + 1 /* 右回り◎ */);
  });

  it('保存した個体を指しても、まだ何も保存していなければ見つからないと伝える', async () => {
    const res = await call('check_lineup', { lineup: [{ individual: 'どこにもいない' }] });
    expect((res.structuredContent!['notes'] as string[]).join('')).toContain('見つかりません');
    expect(res.structuredContent!['summary']).toMatchObject({ ok: false, failures: 1 });
  });

  it('入力の誤りは、何が足りないかを返す（必須項目が無い）', async () => {
    const res = await call('check_lineup', { lineup: [{ name: 'だけ' }] }).catch((error: Error) => error);
    // SDK の入力検査で弾かれる。例外か isError のどちらかで、何が足りないかが読める。
    const text = res instanceof Error ? res.message : res.content[0]!.text;
    expect(text).toMatch(/status|aptitude|skills|individual|invalid|Invalid/);
  });
});

describe('win_rate', () => {
  it('解決できないスキルがあれば、回さずに名前と候補を返す', async () => {
    const started = performance.now();
    const res = await call('win_rate', { lineup: LINEUP_11, track: LONGCHAMP, trials: 500 });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('レースを回していません');
    expect(res.content[0]!.text).toContain('先行ためらい');
    expect(res.content[0]!.text).toContain('skip_unresolved');
    // 回していないので、すぐ返る。
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('存在しないコースは、直し方を返す', async () => {
    const res = await call('win_rate', { lineup: LINEUP_11.map(withoutDebuffs), track: { location: 1, course: 2 } });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('list_courses');
  });

  it('直接 runMultiRace と OrderTally を回した値と、1 つも違わない', async () => {
    const names = ['エルコンドルパサー', 'スーパークリーク', 'ツルマルツヨシ'];
    const lineup = names.map((n) => withoutDebuffs(byName(n)));
    const trials = 40;
    const seed = 7;
    const res = await call('win_rate', { lineup, track: LONGCHAMP, trials, seed });
    expect(res.isError).not.toBe(true);
    const rows = res.structuredContent!['runners'] as {
      name: string;
      winRate: number;
      quinellaRate: number;
      showRate: number;
      meanOrder: number;
      meanTime: number;
    }[];

    // 道具を通さずに、同じ設定を組んで同じ種で回す。
    const resolver = new SkillResolver(data.skills);
    const runners = lineup.map((entry) => toLineupRunner(entry as never));
    const track: TrackRef = { ...LONGCHAMP, gateCount: 3, season: 1, weather: 1, time: 1 };
    const popularity = assignPopularity(runners);
    const settings = runners.map((r: LineupRunner, i: number) => {
      const skills = resolver.resolveLineup({
        chara: r.chara,
        unique: r.unique?.name,
        skills: r.skills,
      }).skills;
      return buildRaceSetting(r, skills, track, data.trackData, popularity[i]!).setting;
    });
    const calculator = new RaceCalculator(defaultSystemSetting(), data.trackData);
    const tally = new OrderTally(3);
    for (let t = 0; t < trials; t++) {
      tally.add(runMultiRace(calculator, settings.map((setting) => ({ setting })), { seed, trial: t }));
    }
    for (const [i, name] of names.entries()) {
      const direct = tally.summarize(i);
      const row = rows.find((r) => r.name === name)!;
      expect(row.winRate, name).toBe(round(direct.winRate, 4));
      expect(row.quinellaRate, name).toBe(round(direct.quinellaRate, 4));
      expect(row.showRate, name).toBe(round(direct.showRate, 4));
      expect(row.meanOrder, name).toBe(round(direct.meanOrder, 2));
      expect(row.meanTime, name).toBe(round(direct.meanTime, 3));
    }
  });

  it('会話で使った 11 頭: エルコンドルパサーが ◎、スーパークリークが ○', async () => {
    // 乱数の種を決めてあるので、100 試行でも結果は毎回同じになる。値そのものは固定しない
    // （計算を直すと動くため）。会話で測った 2400 試行では、2 頭は 45.8 % と 24.5 % で大きく離れている。
    const res = await call('win_rate', { lineup: LINEUP_11, track: LONGCHAMP, trials: 100, seed: 1, skip_unresolved: true });
    expect(res.isError).not.toBe(true);
    const structured = res.structuredContent!;
    const rows = structured['runners'] as { name: string; mark: string; droppedSkills: string[]; winRate: number }[];
    expect(rows).toHaveLength(11);
    expect(rows[0]).toMatchObject({ name: 'エルコンドルパサー', mark: '◎' });
    expect(rows[1]).toMatchObject({ name: 'スーパークリーク', mark: '○' });
    // 勝率の高い順に並んでいる。
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.winRate).toBeLessThanOrEqual(rows[i - 1]!.winRate);
    // 印は ◎ ○ ▲ △ △ が 1 つずつ（☆ は付くことも付かないこともある）。
    const marks = rows.map((r) => r.mark).join('');
    expect(marks).toMatch(/^◎○▲△△/);
    // 落としたデバフと、前提の注意が notes に載る。
    const notes = (structured['notes'] as string[]).join('\n');
    expect(notes).toContain('ゲームと突き合わせていません');
    expect(notes).toContain('先行ためらい');
    expect(notes).toContain('他馬に効くデバフ');
    expect(notes).toContain('天候は晴のまま'); // 不良だが雨ではない
    expect(res.content[0]!.text).toContain('| ◎ | エルコンドルパサー');
  });

  it('進捗が通知される', async () => {
    const seen: number[] = [];
    const lineup = ['エルコンドルパサー', 'スーパークリーク'].map((n) => withoutDebuffs(byName(n)));
    const res = await call('win_rate', { lineup, track: TOKYO_2400, trials: 200 }, {
      onprogress: (p) => {
        seen.push(p.progress);
      },
    });
    expect(res.isError).not.toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    // 最後は全試行が終わった通知で、増える一方である。
    expect(seen.at(-1)).toBe(200);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it('途中で中断すると回すのを止め、そのあとも使える', async () => {
    const lineup = LINEUP_11.map(withoutDebuffs);
    const controller = new AbortController();
    const started = performance.now();
    const running = call('win_rate', { lineup, track: LONGCHAMP, trials: 20000 }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 1500);
    await expect(running).rejects.toThrow();
    // 20000 試行を回し切っていない（回し切れば数分かかる）。
    expect(performance.now() - started).toBeLessThan(30_000);

    // 続けて小さい呼び出しが通る。Worker が止まったまま、順番待ちが詰まっていない。
    const after = await call('win_rate', {
      lineup: ['エルコンドルパサー', 'スーパークリーク'].map((n) => withoutDebuffs(byName(n))),
      track: TOKYO_2400,
      trials: 20,
    });
    expect(after.isError).not.toBe(true);
    expect((after.structuredContent!['runners'] as unknown[]).length).toBe(2);
  });

  it('同時に呼んでも、順に回って両方が返る', async () => {
    const lineup = ['エルコンドルパサー', 'スーパークリーク', 'ツルマルツヨシ'].map((n) => withoutDebuffs(byName(n)));
    const [a, b] = await Promise.all([
      call('win_rate', { lineup, track: TOKYO_2400, trials: 30, seed: 1 }),
      call('win_rate', { lineup, track: TOKYO_2400, trials: 30, seed: 1 }),
    ]);
    expect(a.isError).not.toBe(true);
    expect(b.isError).not.toBe(true);
    // 同じ入力と種なので、同じ結果が返る。
    expect(a.structuredContent!['runners']).toEqual(b.structuredContent!['runners']);
  });
});

describe('win_rate: fill_opponents（出走表の頭数が足りないとき、相手を補う）', () => {
  const el = withoutDebuffs(byName('エルコンドルパサー'));
  const tsuyoshi = withoutDebuffs(byName('ツルマルツヨシ'));
  interface FillResult {
    filled: number;
    gateCount: number;
    lineups: number;
    trialsPerLineup: number[];
    keys: { lineup: number; sample: number; raceSeed: number }[];
    opponentsWinRate: number;
    profile: { spBudget: number };
    example: { slot: number; charaName: string | null; styleLabel: string; skillCount: number; uniqueLevel: number }[];
    reasons?: string[];
  }

  it('1 頭の出走表が 9 頭になる。notes に、補ったことと相手の組み方が載る', async () => {
    const args = { lineup: [el], track: TOKYO_2400, trials: 4, seed: 5, fill_opponents: { lineups: 2 } };
    const res = await call('win_rate', args);
    expect(res.isError).not.toBe(true);
    const structured = res.structuredContent!;
    expect(structured['runners']).toHaveLength(1);
    expect(structured['trials']).toBe(4);
    const fill = structured['fillOpponents'] as FillResult;
    expect(fill).toMatchObject({ filled: 8, gateCount: 9, lineups: 2, trialsPerLineup: [2, 2] });
    // 組ごとに相手と乱数の種が違う（同じ種で回すと、組どうしが相関する）。
    expect(new Set(fill.keys.map((k) => k.raceSeed)).size).toBe(2);
    expect(new Set(fill.keys.map((k) => k.sample)).size).toBe(2);
    // 1 組目の相手の例。実在のカードから引かれ、固有 Lv は指定（既定 4）で、スキルを持つ。
    expect(fill.example).toHaveLength(8);
    for (const e of fill.example) {
      expect(e.charaName, `枠 ${e.slot}`).not.toBeNull();
      expect(e.uniqueLevel).toBe(4);
      expect(e.skillCount).toBeGreaterThan(8);
    }
    // 出走表の頭が 1 着になる割合と、補った相手が 1 着になる割合で、ほぼ全部になる。
    const [row] = structured['runners'] as { winRate: number }[];
    expect(row!.winRate + fill.opponentsWinRate).toBeCloseTo(1, 3);
    // notes と本文に、補ったこと・組の数・組み方・推定であることが書いてある。
    const notes = (structured['notes'] as string[]).join('\n');
    expect(notes).toContain('相手を 8 頭補って、9 頭で回しました');
    expect(notes).toContain('2 組を引き');
    expect(notes).toContain('固有 Lv4');
    // sp_budget を省いたので、予算は出走表の頭（エル 1 頭）の白・金・緑の表示 SP に揃う。
    const resolver = new SkillResolver(data.skills);
    const runner = toLineupRunner(el as never);
    const own = resolver.resolveLineup({ chara: runner.chara, unique: runner.unique?.name, skills: runner.skills }).skills;
    const ownSp = own.filter((s) => s.rarity === 'normal' || s.rarity === 'rare').reduce((sum, s) => sum + s.sp, 0);
    expect(ownSp).toBeGreaterThan(0);
    expect(fill.profile.spBudget).toBe(ownSp);
    expect(notes).toContain(`SP ${ownSp} の予算`);
    expect(notes).toContain('平均に揃えました');
    expect(notes).toContain('推定');
    expect(notes).toContain('相手の組の選び方による揺れは含みません');
    expect(notes).toContain('ゲームと突き合わせていません'); // 今までの注意も残っている
    expect(res.content[0]!.text).toContain('9 頭（出走表 1 + 補った 8）');
    expect(res.content[0]!.text).toContain('補った相手の例');
    // 同じ入力なら、同じ相手に同じ乱数で回って、同じ結果になる。
    const again = await call('win_rate', args);
    expect(again.structuredContent!['runners']).toEqual(structured['runners']);
    expect((again.structuredContent!['fillOpponents'] as FillResult).example).toEqual(fill.example);
  });

  it('指定した固有 Lv と SP 予算が、相手と notes に効く。試行より組が多ければ、組を減らす', async () => {
    const res = await call('win_rate', {
      lineup: [el],
      track: TOKYO_2400,
      trials: 2,
      fill_opponents: { gate_count: 5, unique_level: 2, sp_budget: 0, lineups: 1 },
    });
    expect(res.isError).not.toBe(true);
    const fill = res.structuredContent!['fillOpponents'] as FillResult;
    expect(fill).toMatchObject({ filled: 4, gateCount: 5, lineups: 1 });
    expect(fill.example.map((e) => e.uniqueLevel)).toEqual([2, 2, 2, 2]);
    const notes = (res.structuredContent!['notes'] as string[]).join('\n');
    expect(notes).toContain('固有 Lv2');
    expect(notes).toContain('SP 0 の予算');
    expect(notes).toContain('指定の値です');
    // 試行より組が多いときは、組を減らして、そう書く。
    const few = await call('win_rate', { lineup: [el], track: TOKYO_2400, trials: 2, fill_opponents: { gate_count: 4, lineups: 5 } });
    expect((few.structuredContent!['fillOpponents'] as FillResult).lineups).toBe(2);
    expect((few.structuredContent!['notes'] as string[]).join('\n')).toContain('指定の 5 組から 2 組に減らしました');
  });

  it('合算は、組ごとに直接 runMultiRace を回して OrderTally に足した値と、1 つも違わない', async () => {
    const lineup = [el, tsuyoshi, withoutDebuffs(byName('スーパークリーク'))];
    const fillInput = { gate_count: 5, sp_budget: 10000, unique_level: 4, lineups: 2 };
    const trials = 6;
    const seed = 7;
    const res = await call('win_rate', { lineup, track: TOKYO_2400, trials, seed, fill_opponents: fillInput });
    expect(res.isError).not.toBe(true);
    const rows = res.structuredContent!['runners'] as {
      name: string;
      winRate: number;
      quinellaRate: number;
      showRate: number;
      meanOrder: number;
      meanTime: number;
    }[];
    expect(rows).toHaveLength(3);

    // 道具を通さずに、同じ組を作って、組ごとの種で回す。試行番号は組ごとに 0 から数える。
    const resolver = new SkillResolver(data.skills);
    const runners = lineup.map((entry) => toLineupRunner(entry as never));
    const track: TrackRef = { ...TOKYO_2400, gateCount: 5, season: 1, weather: 1, time: 1 };
    const decision = planFill(data, fillInput, runners, TOKYO_2400);
    expect(decision.kind).toBe('fill');
    if (decision.kind !== 'fill') return;
    const popularity = assignPopularity(runners);
    const own = runners.map((r: LineupRunner, i: number) => {
      const skills = resolver.resolveLineup({ chara: r.chara, unique: r.unique?.name, skills: r.skills }).skills;
      return buildRaceSetting(r, skills, track, data.trackData, popularity[i]!).setting;
    });
    const calculator = new RaceCalculator(defaultSystemSetting(), data.trackData);
    const tally = new OrderTally(5);
    const groups = buildFillGroups(decision.plan, data, track, seed, trials);
    expect(groups.map((g) => g.count)).toEqual([3, 3]);
    for (const group of groups) {
      const entries = [...own, ...group.opponents].map((setting) => ({ setting }));
      for (let t = 0; t < group.count; t++) tally.add(runMultiRace(calculator, entries, { seed: group.raceSeed, trial: t }));
    }
    for (const [i, runner] of runners.entries()) {
      const direct = tally.summarize(i);
      const row = rows.find((r) => r.name === runner.name)!;
      expect(row.winRate, runner.name).toBe(round(direct.winRate, 4));
      expect(row.quinellaRate, runner.name).toBe(round(direct.quinellaRate, 4));
      expect(row.showRate, runner.name).toBe(round(direct.showRate, 4));
      expect(row.meanOrder, runner.name).toBe(round(direct.meanOrder, 2));
      expect(row.meanTime, runner.name).toBe(round(direct.meanTime, 3));
    }
  });

  it('省くと今までと同じ。頭数が足りているときも、補わずに同じ結果になる', async () => {
    const lineup = [el, tsuyoshi, withoutDebuffs(byName('スーパークリーク'))];
    const plain = await call('win_rate', { lineup, track: TOKYO_2400, trials: 8, seed: 3 });
    expect(plain.isError).not.toBe(true);
    // 省いたときは、補った相手に関わる項目も、notes も出ない。
    expect(plain.structuredContent).not.toHaveProperty('fillOpponents');
    expect((plain.structuredContent!['notes'] as string[]).join('')).not.toContain('補っ');
    expect(plain.content[0]!.text).toContain('3 頭 / 8 試行');
    // 3 頭の出走表に gate_count 3 を指定しても、補う頭は 0 なので、結果は同じ。理由だけが notes に足される。
    const full = await call('win_rate', { lineup, track: TOKYO_2400, trials: 8, seed: 3, fill_opponents: { gate_count: 3 } });
    expect(full.structuredContent!['runners']).toEqual(plain.structuredContent!['runners']);
    expect(full.structuredContent!['fillOpponents']).toMatchObject({ filled: 0, gateCount: 3 });
    expect((full.structuredContent!['notes'] as string[]).join('')).toContain('相手は補っていません');
  });

  it('進捗は、全組を通した試行数で通知される', async () => {
    const seen: number[] = [];
    const res = await call(
      'win_rate',
      { lineup: [el], track: TOKYO_2400, trials: 20, fill_opponents: { gate_count: 4, lineups: 2 } },
      {
        onprogress: (p) => {
          seen.push(p.progress);
        },
      },
    );
    expect(res.isError).not.toBe(true);
    expect(seen.at(-1)).toBe(20);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it('出走表が 1 頭で、補わないなら、2 頭以上と伝える', async () => {
    const res = await call('win_rate', { lineup: [el], track: TOKYO_2400, trials: 2 });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('2 頭以上');
  });

  describe('順位表が無いコース', () => {
    // スキル一覧が空の場所を指す文脈。順位表が無いので、名簿は作れない。
    const emptyDir = mkdtempSync(join(tmpdir(), 'raceemu-mcp-nolist-'));
    const noListStoreDir = mkdtempSync(join(tmpdir(), 'raceemu-mcp-nolist-store-'));
    const noListContext = createContext({
      data,
      meta,
      concurrency: 1,
      store: new IndividualStore(noListStoreDir),
      skillListDir: emptyDir,
    });
    const noListServer = createRaceemuServer(noListContext);
    const noListClient = new Client({ name: 'no-list-test', version: '0' });
    beforeAll(async () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await Promise.all([noListServer.connect(serverSide), noListClient.connect(clientSide)]);
    });
    afterAll(async () => {
      await noListClient.close();
      await noListContext.runtime.dispose();
      noListContext.store.close();
      rmSync(emptyDir, { recursive: true, force: true });
      rmSync(noListStoreDir, { recursive: true, force: true });
    });
    const callNoList = async (args: Record<string, unknown>) =>
      (await noListClient.callTool({ name: 'win_rate', arguments: args })) as unknown as ToolResult;

    it('補わずに、出走表の頭だけで回し、理由を notes に書く', async () => {
      const res = await callNoList({ lineup: [el, tsuyoshi], track: TOKYO_2400, trials: 4, fill_opponents: {} });
      expect(res.isError).not.toBe(true);
      expect(res.structuredContent!['runners']).toHaveLength(2);
      const fill = res.structuredContent!['fillOpponents'] as FillResult;
      expect(fill.filled).toBe(0);
      expect(fill.reasons!.join('')).toContain('順位表が無いコース');
      const notes = (res.structuredContent!['notes'] as string[]).join('\n');
      expect(notes).toContain('相手を補えませんでした');
      expect(notes).toContain('出走表の頭だけで回します');
      // MCP は相手を 1 頭も足さない。典型スキルの相手で回すとは言わない（CLI の扱いである）。
      expect(notes).not.toContain('典型スキル');
      expect(res.content[0]!.text).toContain('2 頭 / 4 試行');
    });

    it('1 頭だけなら、回せないので、理由つきで伝える', async () => {
      const res = await callNoList({ lineup: [el], track: TOKYO_2400, trials: 4, fill_opponents: {} });
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('2 頭以上');
      expect(res.content[0]!.text).toContain('順位表が無いコース');
    });
  });
});

describe('skill_gain', () => {
  const tsuyoshi = withoutDebuffs(byName('ツルマルツヨシ'));

  it('足しても発動しないスキルは、差が厳密に 0 になる', async () => {
    // 追込専用のスキルは、先行の出走表では発動しない。足す前と足した後で出目が同じなので、差は 0。
    const res = await call('skill_gain', { runner: tsuyoshi, add: ['追込直線◎'], track: TOKYO_2400, trials: 30 });
    expect(res.isError).not.toBe(true);
    expect(res.structuredContent!['bashin']).toEqual({ mean: 0, se: 0 });
    expect((res.structuredContent!['notes'] as string[]).join('')).toContain('0 と区別できません');
  });

  it('効くスキルを足すと、獲得バ身が正になり、誤差と費用が付く', async () => {
    const res = await call('skill_gain', {
      runner: tsuyoshi,
      add: ['円弧のマエストロ'],
      track: TOKYO_2400,
      trials: 60,
      seed: 3,
    });
    expect(res.isError).not.toBe(true);
    const s = res.structuredContent!;
    expect(s['added']).toEqual([expect.objectContaining({ name: '円弧のマエストロ', rarity: 'rare' })]);
    expect(s['costSp']).toBeGreaterThan(0);
    expect(s['bashin'].mean).toBeGreaterThan(0);
    expect(s['bashin'].se).toBeGreaterThanOrEqual(0);
    expect(s['baseline'].endSpeed).toBeGreaterThan(15);
    // 同じ入力と種なら、同じ値が返る。
    const again = await call('skill_gain', { runner: tsuyoshi, add: ['円弧のマエストロ'], track: TOKYO_2400, trials: 60, seed: 3 });
    expect(again.structuredContent!['bashin']).toEqual(s['bashin']);
  });

  it('すでに持っているスキルだけを足そうとしたら、そう伝える', async () => {
    const res = await call('skill_gain', { runner: tsuyoshi, add: ['王手'], track: TOKYO_2400, trials: 10 });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('すべて持っています');
  });

  it('足すスキルの名前を解決できなければ、候補を返して回さない', async () => {
    const res = await call('skill_gain', { runner: tsuyoshi, add: ['存在しないスキル名'], track: TOKYO_2400, trials: 10 });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('解決できません');
  });
});
