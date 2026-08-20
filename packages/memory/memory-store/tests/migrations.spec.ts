import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openMemoryStore } from '../src/index.ts'
import { migrate } from '../src/migrations.ts'

/** v1 baseline: the original cards DDL, before the workspace column existed. */
const V1_CARDS_DDL = `
CREATE TABLE cards (
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
`

let tmpDirs: string[] = []
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  tmpDirs = []
})

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hmem-migrate-'))
  tmpDirs.push(dir)
  return join(dir, 'hmem.db')
}

describe('migrations', () => {
  it('creates meta and suggestions tables on a fresh db', () => {
    const store = openMemoryStore(':memory:')
    expect(store.listTables()).toEqual(
      expect.arrayContaining(['meta', 'suggestions', 'cards_fts_tri']),
    )
    store.close()
  })

  it('round-trips the workspace column through insertCard/getCard', () => {
    const store = openMemoryStore(':memory:')
    const card = store.insertCard({ summary: 's', content: 'c', workspace: 'f:/proj' })
    expect(card.workspace).toBe('f:/proj')
    expect(store.getCard(card.id)?.workspace).toBe('f:/proj')
    store.close()
  })

  it('adds workspace column to an existing v1 database, keeping old rows', () => {
    const path = tmpDbPath()
    const v1 = new DatabaseSync(path)
    v1.exec(V1_CARDS_DDL)
    v1.prepare(
      "INSERT INTO cards (id, summary, content, recorded_at) VALUES ('old-1', 'old summary', 'old content', '2026-01-01T00:00:00.000Z')",
    ).run()
    v1.close()

    const store = openMemoryStore(path)
    const cols = (store.db.prepare("SELECT name FROM pragma_table_info('cards')").all() as { name: string }[])
      .map(r => r.name)
    expect(cols).toContain('workspace')
    const old = store.getCard('old-1')
    expect(old?.summary).toBe('old summary')
    expect(old?.workspace).toBeNull()
    // trigram backfill must cover pre-migration rows
    expect(store.searchCardsTri('old summary').map(h => h.id)).toContain('old-1')
    store.close()
  })

  it('is idempotent — re-opening and re-migrating throws nothing, data intact', () => {
    const path = tmpDbPath()
    const first = openMemoryStore(path)
    const card = first.insertCard({ summary: 'persist me', content: 'body', workspace: 'f:/p' })
    first.setMeta('schema_version', '2')
    first.close()

    const second = openMemoryStore(path)
    expect(() => migrate(second.db)).not.toThrow()
    expect(second.getCard(card.id)?.summary).toBe('persist me')
    expect(second.getCard(card.id)?.workspace).toBe('f:/p')
    expect(second.getMeta('schema_version')).toBe('2')
    // rebuild must not duplicate trigram rows
    expect(second.searchCardsTri('persist').length).toBe(1)
    second.close()
  })

  it('trigram index finds a mid-sentence CJK term', () => {
    const store = openMemoryStore(':memory:')
    store.insertCard({ summary: '主人最近睡眠不太好', content: '主人最近睡眠不太好，半夜醒' })
    const hits = store.searchCardsTri('睡眠')
    expect(hits.map(h => h.summary)).toContain('主人最近睡眠不太好')
    store.close()
  })

  it('meta get/set round-trips and overwrites', () => {
    const store = openMemoryStore(':memory:')
    expect(store.getMeta('missing')).toBeNull()
    store.setMeta('k', 'v1')
    store.setMeta('k', 'v2')
    expect(store.getMeta('k')).toBe('v2')
    store.close()
  })
})
