import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import type { UmaStatus } from '../../../packages/sim/src/setting.ts';

// import ではなく require で読む。vite の SSR 解決（vitest がテストで使う）が
// 実験的な node:sqlite を組み込みモジュール一覧に見つけられず、"node:" を
// 落とした "sqlite" という存在しないファイルとして解決しようとして落ちる。
// require はその解決を経由しないので影響を受けない。
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface Individual {
  readonly id: string;
  readonly label: string;
  readonly uma: UmaStatus;
  readonly skillIds: readonly string[];
  readonly createdAt: string;
}

export interface NewIndividual {
  readonly label: string;
  readonly uma: UmaStatus;
  readonly skillIds: readonly string[];
}

interface Row {
  readonly id: string;
  readonly label: string;
  readonly uma_json: string;
  readonly skill_ids_json: string;
  readonly created_at: string;
}

function fromRow(row: Row): Individual {
  return {
    id: row.id,
    label: row.label,
    uma: JSON.parse(row.uma_json) as UmaStatus,
    skillIds: JSON.parse(row.skill_ids_json) as readonly string[],
    createdAt: row.created_at,
  };
}

/**
 * 個体（ステータス+スキル構成）の保存。
 *
 * レース結果は持たない。レース条件（コース・馬場・出走頭数など）はその都度
 * 変わるので、勝率や統計に使うときはブラウザ側の Worker で都度再シミュレート
 * する前提である。ここは構成の置き場でしかない。
 *
 * `dataDir` が null なら `:memory:`（プロセスと運命をともにする）。
 * 自前の k3s に置く版だけ永続化したいので、既定はこれでよい。
 */
export class IndividualStore {
  private readonly db: DatabaseSyncType;

  constructor(dataDir: string | null) {
    if (dataDir === null) {
      this.db = new DatabaseSync(':memory:');
    } else {
      mkdirSync(dataDir, { recursive: true });
      this.db = new DatabaseSync(join(dataDir, 'individuals.db'));
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS individuals (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        uma_json TEXT NOT NULL,
        skill_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  }

  create(input: NewIndividual): Individual {
    const record: Individual = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
    this.db
      .prepare('INSERT INTO individuals (id, label, uma_json, skill_ids_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(record.id, record.label, JSON.stringify(record.uma), JSON.stringify(record.skillIds), record.createdAt);
    return record;
  }

  list(): Individual[] {
    // created_at はミリ秒までなので、同じミリ秒に複数保存すると同点になる。
    // rowid は挿入順に単調増加するので、同点を安定して割るタイブレークに使う。
    const rows = this.db
      .prepare(
        'SELECT id, label, uma_json, skill_ids_json, created_at FROM individuals ORDER BY created_at DESC, rowid DESC',
      )
      .all() as unknown as Row[];
    return rows.map(fromRow);
  }

  remove(id: string): boolean {
    return this.db.prepare('DELETE FROM individuals WHERE id = ?').run(id).changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
