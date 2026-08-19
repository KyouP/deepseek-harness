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

describe('commitments', () => {
  it('tracks active commitments and due ones by deadline', () => {
    store.addCommitment({ content: '帮用户 review 代码', dueAt: '2026-08-20T00:00:00.000Z' })
    store.addCommitment({ content: '无期限约定' })
    expect(store.activeCommitments()).toHaveLength(2)
    expect(store.dueCommitments('2026-08-19T00:00:00.000Z')).toHaveLength(0)
    expect(store.dueCommitments('2026-08-21T00:00:00.000Z')).toHaveLength(1)
  })

  it('defaults promisee to user and keeps a custom promisee', () => {
    const mine = store.addCommitment({ content: '自有约定' })
    const theirs = store.addCommitment({ content: '给 agent 的约定', promisee: 'agent' })
    expect(mine.promisee).toBe('user')
    expect(theirs.promisee).toBe('agent')
    expect(mine.status).toBe('active')
    expect(mine.closedAt).toBeNull()
  })

  it('closes a commitment with a terminal status and timestamp', () => {
    const c = store.addCommitment({ content: '发周报' })
    store.closeCommitment(c.id, 'done')
    expect(store.activeCommitments()).toHaveLength(0)
    const row = store.db.prepare('SELECT status, closed_at FROM commitments WHERE id = ?')
      .get(c.id) as { status: string; closed_at: string | null }
    expect(row.status).toBe('done')
    expect(row.closed_at).toBeTruthy()
  })

  it('returns the existing row instead of duplicating identical active content', () => {
    const first = store.addCommitment({ content: '提醒主人多运动' })
    const again = store.addCommitment({ content: '提醒主人多运动' })
    expect(again.id).toBe(first.id)
    expect(store.activeCommitments()).toHaveLength(1)
  })

  it('inserts a fresh row when the identical commitment was already closed', () => {
    const first = store.addCommitment({ content: '提醒主人多喝水' })
    store.closeCommitment(first.id, 'done')
    const second = store.addCommitment({ content: '提醒主人多喝水' })
    expect(second.id).not.toBe(first.id)
    expect(store.activeCommitments()).toHaveLength(1)
  })
})
