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

describe('facts', () => {
  it('supersede expires the old fact instead of overwriting it', () => {
    const old = store.insertFact({ subject: 'user', predicate: 'preference.editor', object: 'vim' })
    const next = store.supersedeFact(old.id, { subject: 'user', predicate: 'preference.editor', object: 'vscode' })
    const active = store.activeFacts('user')
    expect(active.map(f => f.id)).toEqual([next.id])
    // 旧行仍在，且带失效标记（双时间验证可查旧版）
    const rows = store.db.prepare('SELECT superseded_by, valid_to FROM facts WHERE id = ?')
      .get(old.id) as { superseded_by: string | null; valid_to: string | null }
    expect(rows.superseded_by).toBe(next.id)
    expect(rows.valid_to).toBeTruthy()
  })

  it('activeFacts without subject returns every live fact', () => {
    store.insertFact({ subject: 'user', predicate: 'p1', object: 'a' })
    store.insertFact({ subject: 'agent', predicate: 'p2', object: 'b', pinned: true })
    expect(store.activeFacts()).toHaveLength(2)
    const agentFacts = store.activeFacts('agent')
    expect(agentFacts).toHaveLength(1)
    expect(agentFacts[0]?.pinned).toBe(true)
  })
})
