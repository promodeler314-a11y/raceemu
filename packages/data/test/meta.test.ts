import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `assets/meta.json`（取り直した日と、4 つのデータの指紋）の検査。
 *
 * 日付だけを持つと、データを取り直したのに日付が古いまま（あるいはその逆）という
 * 食い違いが黙って起きる。指紋を持たせて、データの中身と突き合わせる。
 * 書き方は `packages/data/scripts/sync-game-data.py` の `digest_assets` と同じである。
 * 手順を変えるときは両方を直す。docs/mcp-design.md 5 節を参照。
 */

const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const NAMES = ['skills', 'courses', 'supports', 'charas'] as const;

/** Windows の autocrlf で CRLF になっていても同じ値になるよう、LF にそろえてから求める。 */
function digestOfAssets(): string {
  const hash = createHash('sha256');
  for (const name of NAMES) {
    const body = readFileSync(join(assetsDir, `${name}.json`), 'utf8').replace(/\r\n/g, '\n');
    hash.update(Buffer.concat([Buffer.from(`${name}\0`), Buffer.from(body, 'utf8'), Buffer.from('\0')]));
  }
  return `sha256:${hash.digest('hex')}`;
}

const meta = JSON.parse(readFileSync(join(assetsDir, 'meta.json'), 'utf8')) as {
  syncedAt: string;
  digest: string;
  source: string;
};

describe('assets/meta.json', () => {
  it('指紋がいまのデータと一致する', () => {
    // 落ちたら、データだけを触って meta.json を直していない。
    // 取り直しなら sync-game-data.py が両方を書く。手で直すなら --meta-only を使う。
    expect(meta.digest).toBe(digestOfAssets());
  });

  it('日付は実在する YYYY-MM-DD である', () => {
    expect(meta.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const parsed = new Date(`${meta.syncedAt}T00:00:00Z`);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
    // 2026-02-30 のような存在しない日が、繰り上がって別の日になっていない。
    expect(parsed.toISOString().slice(0, 10)).toBe(meta.syncedAt);
  });

  it('出どころを持つ', () => {
    expect(meta.source).toBe('https://github.com/mee1080/umasim');
  });
});
