import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore, openMemoryStore } from '../src/index.ts'

let dir = ''
let store: MemoryStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hmem-'))
  store = openMemoryStore(join(dir, 'hmem.db'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('scratchpad', () => {
  it('round-trips notes oldest first with a null or set session', () => {
    store.addNote(null, '全局便签')
    store.addNote('session-1', '会话便签')
    const notes = store.recentNotes(new Date(0).toISOString())
    expect(notes.map(n => n.text)).toEqual(['全局便签', '会话便签'])
    expect(notes[0]!.id).toBeTruthy()
    expect(notes[0]!.createdAt).toBeTruthy()
    const row = store.db.prepare('SELECT session_id FROM scratchpad WHERE text = ?')
      .get('会话便签') as { session_id: string | null }
    expect(row.session_id).toBe('session-1')
  })

  it('filters by the since timestamp', () => {
    store.addNote(null, '新便签')
    expect(store.recentNotes(new Date(Date.now() + 60_000).toISOString())).toEqual([])
  })

  it('caps the result at the requested limit, keeping the newest notes', () => {
    for (let i = 0; i < 25; i++) store.addNote(null, `便签-${i}`)
    const capped = store.recentNotes(new Date(0).toISOString(), 5)
    expect(capped).toHaveLength(5)
    expect(capped.map(n => n.text)).toEqual(['便签-20', '便签-21', '便签-22', '便签-23', '便签-24'])
    expect(store.recentNotes(new Date(0).toISOString())).toHaveLength(20)
  })
})
