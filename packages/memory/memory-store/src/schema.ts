/** DDL for the H-MEM store. Executed wholesale on open; every statement is idempotent. */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS cards (
  id            TEXT PRIMARY KEY,
  summary       TEXT NOT NULL,
  content       TEXT NOT NULL,
  context_desc  TEXT,
  keywords      TEXT NOT NULL DEFAULT '[]',
  emotion       TEXT,
  salience      REAL NOT NULL DEFAULT 0,
  strength      REAL NOT NULL DEFAULT 1,
  pinned        INTEGER NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0,
  session_id    TEXT,
  valid_from    TEXT,
  valid_to      TEXT,
  recorded_at   TEXT NOT NULL,
  embedding     BLOB
) STRICT;

CREATE TABLE IF NOT EXISTS facts (
  id            TEXT PRIMARY KEY,
  subject       TEXT NOT NULL,
  predicate     TEXT NOT NULL,
  object        TEXT NOT NULL,
  confidence    REAL NOT NULL DEFAULT 1,
  source_card   TEXT REFERENCES cards(id),
  superseded_by TEXT REFERENCES facts(id),
  valid_from    TEXT,
  valid_to      TEXT,
  recorded_at   TEXT NOT NULL,
  pinned        INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE IF NOT EXISTS links (
  src         TEXT NOT NULL REFERENCES cards(id),
  dst         TEXT NOT NULL REFERENCES cards(id),
  weight      REAL NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (src, dst)
) STRICT;

CREATE TABLE IF NOT EXISTS commitments (
  id         TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  promisee   TEXT NOT NULL DEFAULT 'user',
  due_at     TEXT,
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  closed_at  TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS core_blocks (
  name     TEXT PRIMARY KEY,
  text     TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
  summary, content, keywords,
  content='cards', content_rowid='rowid', tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS cards_ai AFTER INSERT ON cards BEGIN
  INSERT INTO cards_fts(rowid, summary, content, keywords)
  VALUES (new.rowid, new.summary, new.content, new.Keywords);
END;

CREATE TRIGGER IF NOT EXISTS cards_ad AFTER DELETE ON cards BEGIN
  INSERT INTO cards_fts(cards_fts, rowid, summary, content, keywords)
  VALUES ('delete', old.rowid, old.summary, old.content, old.Keywords);
END;
`
