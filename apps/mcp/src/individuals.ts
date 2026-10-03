import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { normalizeSkillName } from '../../../packages/data/src/skill-match.ts';
import type { LineupRunner } from '../../../packages/sim/src/multi/lineup.ts';
import type { IndividualLookup } from './lineup-service.ts';

// import ではなく require で読む。vite の SSR 解決（vitest がテストで使う）が実験的な
// node:sqlite を組み込みモジュールとして見つけられず落ちる。apps/api/src/individuals.ts と同じ理由。
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

/**
 * 書き起こした個体の保存。docs/mcp-design.md 3.8 節を参照。
 *
 * **保存するのは書き起こした個体で、画像ではない。** 適性は全部持つので、別のコースでも使える。
 * `apps/api` の `IndividualStore`（コース用に絞った適性しか持たない）とは形が違うので、
 * ファイルも分ける（`mcp-individuals.db`）。同じディレクトリを指しても衝突しない。
 */

export interface StoredIndividual {
  readonly id: string;
  readonly label: string;
  readonly runner: LineupRunner;
  /** 保存したときに解決したスキルの ID。あとで解決結果が変わったかを見るのに使う。 */
  readonly skillIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SaveResult {
  readonly individual: StoredIndividual;
  /** 同じ個体を上書きしたか */
  readonly updated: boolean;
}

interface Row {
  readonly id: string;
  readonly label: string;
  readonly identity: string;
  readonly runner_json: string;
  readonly skill_ids_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

function fromRow(row: Row): StoredIndividual {
  return {
    id: row.id,
    label: row.label,
    runner: JSON.parse(row.runner_json) as LineupRunner,
    skillIds: JSON.parse(row.skill_ids_json) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 同じ個体かどうかの鍵。ウマ娘名、ステータス 5 つ、固有 Lv が全部同じなら同じ個体とみなして上書きする。
 * スキルを足した育成の途中経過を、貼り直しのたびに別の個体として増やさないため。
 * ステータスが 1 つでも違えば別の個体になる。
 */
export function identityOf(runner: LineupRunner): string {
  const { speed, stamina, power, guts, wisdom } = runner.status;
  return [
    normalizeSkillName(runner.chara ?? runner.name),
    speed,
    stamina,
    power,
    guts,
    wisdom,
    runner.unique?.level ?? '',
  ].join('|');
}

/** 保存先のディレクトリ。環境変数 `RACEEMU_MCP_DATA_DIR`、無ければ `~/.raceemu`。 */
export function defaultDataDir(): string {
  const env = process.env['RACEEMU_MCP_DATA_DIR'];
  return env !== undefined && env !== '' ? env : join(homedir(), '.raceemu');
}

export class IndividualStore implements IndividualLookup {
  private database: DatabaseSyncType | null = null;

  /**
   * `dataDir` が null なら `:memory:`（プロセスと運命をともにする）。
   * ファイルは最初に使われるまで開かない。`data_info` を呼ぶだけで、ホームにディレクトリを作らない。
   */
  constructor(private readonly dataDir: string | null) {}

  private db(): DatabaseSyncType {
    if (this.database !== null) return this.database;
    let db: DatabaseSyncType;
    if (this.dataDir === null) {
      db = new DatabaseSync(':memory:');
    } else {
      mkdirSync(this.dataDir, { recursive: true });
      db = new DatabaseSync(join(this.dataDir, 'mcp-individuals.db'));
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS individuals (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        identity TEXT NOT NULL,
        runner_json TEXT NOT NULL,
        skill_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS individuals_identity ON individuals (identity)');
    this.database = db;
    return db;
  }

  /** 保存する。同じ個体（ウマ娘名、ステータス 5 つ、固有 Lv が同じ）があれば上書きする。 */
  save(runner: LineupRunner, skillIds: readonly string[], label?: string): SaveResult {
    const db = this.db();
    const identity = identityOf(runner);
    const now = new Date().toISOString();
    const existing = db
      .prepare('SELECT id, label, created_at FROM individuals WHERE identity = ? ORDER BY rowid LIMIT 1')
      .get(identity) as { id: string; label: string; created_at: string } | undefined;
    if (existing !== undefined) {
      // 呼び名を指定しなければ、これまでの呼び名を残す。
      const nextLabel = label !== undefined && label !== '' ? label : existing.label;
      db.prepare('UPDATE individuals SET label = ?, runner_json = ?, skill_ids_json = ?, updated_at = ? WHERE id = ?').run(
        nextLabel,
        JSON.stringify(runner),
        JSON.stringify(skillIds),
        now,
        existing.id,
      );
      return {
        updated: true,
        individual: {
          id: existing.id,
          label: nextLabel,
          runner,
          skillIds: [...skillIds],
          createdAt: existing.created_at,
          updatedAt: now,
        },
      };
    }
    const individual: StoredIndividual = {
      id: randomUUID(),
      label: label !== undefined && label !== '' ? label : runner.chara ?? runner.name,
      runner,
      skillIds: [...skillIds],
      createdAt: now,
      updatedAt: now,
    };
    db.prepare(
      'INSERT INTO individuals (id, label, identity, runner_json, skill_ids_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      individual.id,
      individual.label,
      identity,
      JSON.stringify(runner),
      JSON.stringify(skillIds),
      individual.createdAt,
      individual.updatedAt,
    );
    return { updated: false, individual };
  }

  /** 新しく保存した順（更新も含む）。呼び名の一部で絞れる。 */
  list(query?: string): StoredIndividual[] {
    const rows = this.db()
      .prepare(
        'SELECT id, label, identity, runner_json, skill_ids_json, created_at, updated_at FROM individuals ORDER BY updated_at DESC, rowid DESC',
      )
      .all() as unknown as Row[];
    const all = rows.map(fromRow);
    const key = query === undefined ? '' : normalizeSkillName(query);
    if (key === '') return all;
    return all.filter((i) => matchesLabel(i, key));
  }

  get(id: string): StoredIndividual | null {
    const row = this.db()
      .prepare('SELECT id, label, identity, runner_json, skill_ids_json, created_at, updated_at FROM individuals WHERE id = ?')
      .get(id) as Row | undefined;
    return row === undefined ? null : fromRow(row);
  }

  remove(id: string): boolean {
    return this.db().prepare('DELETE FROM individuals WHERE id = ?').run(id).changes > 0;
  }

  /**
   * `id` または呼び名で引く。出走表の `individual` に使う。
   * 順に、id の完全一致、呼び名の完全一致、呼び名とウマ娘名の部分一致を見て、当たった段で止める。
   * 複数に当たれば、全部返す（呼び出し側が候補を見せて止まる）。
   */
  find(key: string): { readonly runners: readonly { id: string; label: string; runner: LineupRunner; skillIds: readonly string[] }[] } {
    const byId = this.get(key);
    const toHit = (i: StoredIndividual) => ({ id: i.id, label: i.label, runner: i.runner, skillIds: i.skillIds });
    if (byId !== null) return { runners: [toHit(byId)] };
    const normalized = normalizeSkillName(key);
    if (normalized === '') return { runners: [] };
    const all = this.list();
    const exact = all.filter((i) => normalizeSkillName(i.label) === normalized);
    if (exact.length > 0) return { runners: exact.map(toHit) };
    return { runners: all.filter((i) => matchesLabel(i, normalized)).map(toHit) };
  }

  close(): void {
    this.database?.close();
    this.database = null;
  }
}

function matchesLabel(individual: StoredIndividual, key: string): boolean {
  return (
    normalizeSkillName(individual.label).includes(key) ||
    normalizeSkillName(individual.runner.chara ?? individual.runner.name).includes(key)
  );
}
