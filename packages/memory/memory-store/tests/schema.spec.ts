import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openMemoryStore } from '../src/index.ts'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('memory-store schema', () => {
  it('creates all tables and the FTS virtual table on open', () => {
    dir = mkdtempSync(join(tmpdir(), 'hmem-'))
    const store = openMemoryStore(join(dir, 'hmem.db'))
    const names = store.listTables()
    expect(names).toContain('cards')
    expect(names).toContain('facts')
    expect(names).toContain('links')
    expect(names).toContain('commitments')
    expect(names).toContain('core_blocks')
    expect(names).toContain('cards_fts')
    store.close()
  })

  it('is idempotent across re-open', () => {
    dir = mkdtempSync(join(tmpdir(), 'hmem-'))
    openMemoryStore(join(dir, 'hmem.db')).close()
    const store = openMemoryStore(join(dir, 'hmem.db'))
    expect(store.listTables()).toContain('cards')
    store.close()
  })
})
