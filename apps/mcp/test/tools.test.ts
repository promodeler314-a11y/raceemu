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
