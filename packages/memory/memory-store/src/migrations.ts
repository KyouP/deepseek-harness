/**
 * Idempotent schema upgrades beyond the v1 `CREATE IF NOT EXISTS` baseline in
 * schema.ts. Runs on every open; safe to re-run on an already-migrated db.
 */
import type { DatabaseSync } from 'node:sqlite'

/**
 * Apply v2 schema changes: meta/suggestions tables, the cards.workspace
 * column, and a trigram FTS5 mirror of cards (external content, trigger-synced,
 * fully rebuilt here so pre-existing rows are backfilled).
 */
export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS suggestions (
      id         TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      content    TEXT NOT NULL,
      hits       INTEGER NOT NULL DEFAULT 1,
      status     TEXT NOT NULL DEFAULT 'pending',
      first_seen TEXT NOT NULL,
      last_seen  TEXT NOT NULL
    ) STRICT;

    CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts_tri USING fts5(
      summary, content, keywords,
      content='cards', content_rowid='rowid', tokenize='trigram'
    );

    CREATE TRIGGER IF NOT EXISTS cards_tri_ai AFTER INSERT ON cards BEGIN
      INSERT INTO cards_fts_tri(rowid, summary, content, keywords)
      VALUES (new.rowid, new.summary, new.content, new.keywords);
    END;

    CREATE TRIGGER IF NOT EXISTS cards_tri_ad AFTER DELETE ON cards BEGIN
      INSERT INTO cards_fts_tri(cards_fts_tri, rowid, summary, content, keywords)
      VALUES ('delete', old.rowid, old.summary, old.content, old.Keywords);
    END;
  `)
  const cols = (db.prepare("SELECT name FROM pragma_table_info('cards')").all() as { name: string }[])
    .map(r => r.name)
  if (!cols.includes('workspace')) db.exec('ALTER TABLE cards ADD COLUMN workspace TEXT')
  // Backfill rows that predate the trigram table. An external-content rebuild
  // is an idempotent full re-index, so running it on every open is safe.
  db.exec(`INSERT INTO cards_fts_tri(cards_fts_tri) VALUES('rebuild')`)
}
