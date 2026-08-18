/**
 * H-MEM persistence layer: a single node:sqlite database holding M2 cards, M3
 * bi-temporal facts, links, commitments and M1 core blocks, with FTS5 over
 * cards. Raw card/fact rows are insert-only; only whitelisted derived columns
 * may update.
 * @module @deepseek-ai/dsh-memory-store
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SCHEMA_SQL } from './schema.ts'

export type * from './types.ts'

/** The H-MEM database handle. Methods are added by Tasks 2-4. */
export class MemoryStore {
  constructor(/** exposed for tests only */ readonly db: DatabaseSync) {}

  /** Table names in the main schema, for smoke tests. */
  listTables(): string[] {
    const rows = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','virtual table')")
      .all() as { name: string }[]
    return rows.map(r => r.name)
  }

  /** Close the underlying database. */
  close(): void {
    this.db.close()
  }
}

/**
 * Open (creating when absent) the H-MEM store at `path`, applying the schema.
 * @param path - database file path; parent directory is created when missing.
 * @returns the ready store.
 */
export function openMemoryStore(path: string): MemoryStore {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(SCHEMA_SQL)
  return new MemoryStore(db)
}
