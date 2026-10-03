import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDataMeta, loadGameData } from '../../../packages/data/src/node.ts';
import { createContext } from '../src/context.ts';
import { IndividualStore, identityOf } from '../src/individuals.ts';
import { createRaceemuServer } from '../src/server.ts';
import { toLineupRunner, type LineupEntry } from '../src/schemas.ts';
import { DEBUFF_NAMES, LINEUP_11 } from './fixtures/race-lineup.ts';

/**
 * 個体の保存の検査。docs/mcp-design.md 3.8 節と 8 節に対応する。
 * 保存先は、いつも一時ディレクトリ。実際のホーム（~/.raceemu）は触らない。
 */

const TOKYO_2400 = { location: 10006, course: 10606, condition: 1 };
const entryOf = (name: string): Extract<LineupEntry, { skills: unknown }> =>
  LINEUP_11.find((e) => 'name' in e && e.name === name)! as Extract<LineupEntry, { skills: unknown }>;
const clean = (entry: Extract<LineupEntry, { skills: unknown }>) => ({
  ...entry,
  skills: entry.skills.filter((s) => !DEBUFF_NAMES.includes(s)),
});

describe('保存先（IndividualStore）', () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'raceemu-mcp-store-'));
    dirs.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  const el = toLineupRunner(clean(entryOf('エルコンドルパサー')));
  const creek = toLineupRunner(clean(entryOf('スーパークリーク')));

  it('保存して、一覧に出る。新しい順に並ぶ', () => {
    const store = new IndividualStore(tempDir());
    const a = store.save(el, ['1', '2']);
    const b = store.save(creek, ['3']);
    expect(a.updated).toBe(false);
    expect(store.list().map((i) => i.id)).toEqual([b.individual.id, a.individual.id]);
    expect(store.get(a.individual.id)?.runner.name).toBe('エルコンドルパサー');
    store.close();
  });

  it('呼び名を省くと chara から作る', () => {
    const store = new IndividualStore(tempDir());
    expect(store.save(el, []).individual.label).toBe('エルコンドルパサー');
    store.close();
  });

  it('ウマ娘名・ステータス・固有 Lv が同じ個体は上書きされ、数が増えない', () => {
    const store = new IndividualStore(tempDir());
    const first = store.save(el, ['1'], '勝負服のエル');
    const second = store.save({ ...el, skills: [...el.skills, '新しいスキル'] }, ['1', '2']);
    expect(second.updated).toBe(true);
    expect(second.individual.id).toBe(first.individual.id);
    expect(store.list()).toHaveLength(1);
    // 呼び名を指定しなければ、これまでの呼び名が残る。作成日も変わらない。
    expect(second.individual.label).toBe('勝負服のエル');
    expect(second.individual.createdAt).toBe(first.individual.createdAt);
    expect(store.get(first.individual.id)?.skillIds).toEqual(['1', '2']);
    // 呼び名を指定すれば変わる。
    expect(store.save(el, ['1'], '改名').individual.label).toBe('改名');
    store.close();
  });

  it('ステータスが 1 つでも違えば、別の個体になる', () => {
    const store = new IndividualStore(tempDir());
    store.save(el, []);
    store.save({ ...el, status: { ...el.status, guts: el.status.guts + 1 } }, []);
    expect(store.list()).toHaveLength(2);
    // 固有の Lv が違っても別の個体。
    store.save({ ...el, unique: { name: el.unique!.name, level: 3 } }, []);
    expect(store.list()).toHaveLength(3);
    // 評価点や脚質の指定は同じ個体の中身なので、別の個体にならない。
    store.save({ ...el, rating: 1, style: 'sasi' }, []);
    expect(store.list()).toHaveLength(3);
    store.close();
  });

  it('同じ個体かどうかの鍵は、ウマ娘名の表記の揺れを吸収する', () => {
    expect(identityOf({ ...el, chara: 'エルコンドルパサー' })).toBe(identityOf({ ...el, chara: 'エルコンドルパサー ' }));
    expect(identityOf(el)).not.toBe(identityOf(creek));
  });

  it('プロセスを起動し直しても残る', () => {
    const dir = tempDir();
    const first = new IndividualStore(dir);
    const saved = first.save(el, ['1', '2', '3'], '残るエル');
    first.close();
    const reopened = new IndividualStore(dir);
    const found = reopened.get(saved.individual.id);
    expect(found?.label).toBe('残るエル');
    expect(found?.skillIds).toEqual(['1', '2', '3']);
    // 適性は全部残っている（別のコースで使えるように）。
    expect(found?.runner.aptitude).toEqual(el.aptitude);
    reopened.close();
  });

  it('使うまでファイルを作らない', () => {
    const dir = join(tempDir(), '作られていないはずの場所');
    const store = new IndividualStore(dir);
    expect(existsSync(dir)).toBe(false);
    store.list();
    expect(existsSync(join(dir, 'mcp-individuals.db'))).toBe(true);
    store.close();
  });

  it('apps/api の保存先（individuals.db）とはファイルが別である', () => {
    const dir = tempDir();
    const store = new IndividualStore(dir);
    store.list();
    expect(existsSync(join(dir, 'individuals.db'))).toBe(false);
    expect(existsSync(join(dir, 'mcp-individuals.db'))).toBe(true);
    store.close();
  });

  it('find は id、呼び名の完全一致、部分一致の順に引く', () => {
    const store = new IndividualStore(tempDir());
    const a = store.save(el, [], '本番用エル');
    store.save(creek, [], 'クリーク');
    expect(store.find(a.individual.id).runners.map((r) => r.id)).toEqual([a.individual.id]);
    expect(store.find('本番用エル').runners).toHaveLength(1);
    expect(store.find('本番').runners).toHaveLength(1); // 部分一致
    expect(store.find('エルコンドル').runners).toHaveLength(1); // ウマ娘名の部分一致
    expect(store.find('どこにもいない').runners).toEqual([]);
    expect(store.find('   ').runners).toEqual([]);
    store.close();
  });

  it('remove は消して、あればそのことを返す', () => {
    const store = new IndividualStore(tempDir());
    const a = store.save(el, []);
    expect(store.remove(a.individual.id)).toBe(true);
    expect(store.remove(a.individual.id)).toBe(false);
    expect(store.list()).toEqual([]);
    store.close();
  });

  it('メモリ上の保存先（null）も使える', () => {
    const store = new IndividualStore(null);
    store.save(el, []);
    expect(store.list()).toHaveLength(1);
    store.close();
  });
});

describe('MCP を通した保存と呼び出し', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'raceemu-mcp-individuals-'));
  const data = loadGameData();
  const context = createContext({ data, meta: loadDataMeta(), concurrency: 2, store: new IndividualStore(dataDir) });
  const client = new Client({ name: 'individuals-test', version: '0' });

  beforeAll(async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([createRaceemuServer(context).connect(serverSide), client.connect(clientSide)]);
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
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as unknown as ToolResult;

  it('何も保存していないときは、そう伝える', async () => {
    const res = await call('list_individuals');
    expect(res.structuredContent!['total']).toBe(0);
    expect(res.content[0]!.text).toContain('保存した個体はありません');
  });

  it('保存する。呼び名で一覧に出る', async () => {
    const res = await call('save_individual', { runner: clean(entryOf('エルコンドルパサー')), label: '本番のエル' });
    expect(res.isError).not.toBe(true);
    expect(res.structuredContent).toMatchObject({ saved: true, updated: false });
    expect(res.structuredContent!['individual'].label).toBe('本番のエル');
    // 画像は保存せず、読み取った内容だけを持つ。応答にもスキルの全文は載せない。
    expect(res.structuredContent!['individual']).not.toHaveProperty('image');

    const list = await call('list_individuals', { query: '本番' });
    expect(list.structuredContent!['total']).toBe(1);
    expect(list.content[0]!.text).toContain('本番のエル');
  });

  it('同じ個体をもう一度保存すると、上書きになる', async () => {
    const again = await call('save_individual', { runner: clean(entryOf('エルコンドルパサー')) });
    expect(again.structuredContent).toMatchObject({ updated: true });
    expect(again.structuredContent!['individual'].label).toBe('本番のエル'); // 呼び名は残る
    expect(again.content[0]!.text).toContain('上書き');
    expect((await call('list_individuals')).structuredContent!['total']).toBe(1);
  });

  it('解決できないスキル名が残っていれば、保存しない', async () => {
    // ファインモーションは、デバフ（逃げけん制、追込ためらい）が付いている。
    const res = await call('save_individual', { runner: entryOf('ファインモーション') });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('保存していません');
    expect(res.content[0]!.text).toContain('逃げけん制');
    expect((await call('list_individuals', { query: 'ファイン' })).structuredContent!['total']).toBe(0);
  });

  it('skip_unresolved で、名前だけを残して保存できる', async () => {
    const res = await call('save_individual', { runner: entryOf('ファインモーション'), skip_unresolved: true });
    expect(res.isError).not.toBe(true);
    expect(res.structuredContent!['unresolved']).toEqual(['逃げけん制', '追込ためらい']);
    expect(res.content[0]!.text).toContain('計算には入りません');
  });

  it('ステータス 1 つ違いは別の個体として、2 つ並ぶ', async () => {
    const el = clean(entryOf('エルコンドルパサー'));
    await call('save_individual', { runner: { ...el, status: { ...el.status, speed: el.status.speed + 1 } }, label: '別のエル' });
    const list = await call('list_individuals', { query: 'エルコンドル' });
    expect(list.structuredContent!['total']).toBe(2);
  });

  it('出走表で、呼び名で指しても、id で指しても、全項目を書いたときと同じ結果になる', async () => {
    const full = clean(entryOf('スーパークリーク'));
    const saved = await call('save_individual', { runner: full, label: 'クリーク本番' });
    const id = saved.structuredContent!['individual'].id as string;
    const others = ['エルコンドルパサー', 'ツルマルツヨシ'].map((n) => clean(entryOf(n)));
    const args = { track: TOKYO_2400, trials: 30, seed: 5 };

    const direct = await call('win_rate', { ...args, lineup: [full, ...others] });
    const byLabel = await call('win_rate', { ...args, lineup: [{ individual: 'クリーク本番' }, ...others] });
    const byId = await call('win_rate', { ...args, lineup: [{ individual: id }, ...others] });
    expect(direct.isError).not.toBe(true);
    expect(byLabel.isError, byLabel.content[0]?.text).not.toBe(true);
    expect(byId.isError, byId.content[0]?.text).not.toBe(true);
    // 保存した個体は、全項目を書いたものと同じ計算になる。違うのは、個体から引いたという印（individualId）だけ。
    const strip = (res: ToolResult) =>
      (res.structuredContent!['runners'] as Record<string, unknown>[]).map(({ individualId: _ignored, ...rest }) => rest);
    expect(strip(byLabel)).toEqual(strip(direct));
    expect(strip(byId)).toEqual(strip(direct));
    const ids = (res: ToolResult) =>
      (res.structuredContent!['runners'] as { name: string; individualId: string | null }[]).find(
        (r) => r.name === 'スーパークリーク',
      )!.individualId;
    expect(ids(direct)).toBeNull();
    expect(ids(byLabel)).toBe(id);
    expect(ids(byId)).toBe(id);
  });

  it('脚質は、その場で上書きできる', async () => {
    const res = await call('check_lineup', { lineup: [{ individual: 'クリーク本番', style: 'sasi' }], track: TOKYO_2400 });
    const [runner] = res.structuredContent!['runners'] as { style: { key: string; source: string }; individualId: string }[];
    expect(runner!.style).toMatchObject({ key: 'sasi', source: 'given' });
    expect(runner!.individualId).toBeTruthy();
  });

  it('呼び名が複数に当たるときは、候補を返して止まる', async () => {
    // 「エル」は、本番のエルと別のエルの両方に当たる。
    const check = await call('check_lineup', { lineup: [{ individual: 'エル' }] });
    expect(check.structuredContent!['summary']).toMatchObject({ ok: false, failures: 1 });
    expect((check.structuredContent!['notes'] as string[]).join('')).toContain('複数に当たります');

    const win = await call('win_rate', {
      lineup: [{ individual: 'エル' }, clean(entryOf('スーパークリーク'))],
      track: TOKYO_2400,
      trials: 10,
    });
    expect(win.isError).toBe(true);
    expect(win.content[0]!.text).toContain('id で指してください');
  });

  it('保存したときと、スキルの解決結果が変わっていれば警告する', async () => {
    // データが更新されて採るスキルが変わった状況を、保存した ID をずらして再現する。
    const runner = toLineupRunner(clean(entryOf('ツルマルツヨシ')));
    const saved = context.store.save(runner, ['999999999'], 'ずれたツヨシ');
    const res = await call('check_lineup', { lineup: [{ individual: saved.individual.id }] });
    const [r] = res.structuredContent!['runners'] as { warnings: { code: string; message: string }[] }[];
    const warning = r!.warnings.find((w) => w.code === 'individual_changed');
    expect(warning?.message).toContain('保存したときと違います');
  });

  it('消す。消すと一覧から無くなり、出走表でも指せなくなる', async () => {
    const list = await call('list_individuals', { query: 'クリーク本番' });
    const id = (list.structuredContent!['individuals'] as { id: string }[])[0]!.id;
    const res = await call('delete_individual', { id });
    expect(res.isError).not.toBe(true);
    expect(res.structuredContent).toMatchObject({ deleted: true });
    expect((await call('list_individuals', { query: 'クリーク本番' })).structuredContent!['total']).toBe(0);
    const check = await call('check_lineup', { lineup: [{ individual: id }] });
    expect(check.structuredContent!['summary']).toMatchObject({ ok: false, failures: 1 });
  });

  it('消すのは id だけ。無い id は、直し方を返す', async () => {
    const res = await call('delete_individual', { id: '存在しない' });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('list_individuals');
    // 呼び名では消せない。
    const byLabel = await call('delete_individual', { id: '本番のエル' });
    expect(byLabel.isError).toBe(true);
    expect((await call('list_individuals', { query: '本番のエル' })).structuredContent!['total']).toBe(1);
  });
});
