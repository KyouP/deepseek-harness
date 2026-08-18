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

describe('core blocks', () => {
  it('upserts with incrementing revision', () => {
    expect(store.getCoreBlock('persona')).toBeNull()
    store.setCoreBlock('persona', 'v1 文本')
    const v2 = store.setCoreBlock('persona', 'v2 文本')
    expect(v2.revision).toBe(2)
    expect(store.getCoreBlock('persona')!.text).toBe('v2 文本')
  })

  it('keeps persona and human blocks independent', () => {
    store.setCoreBlock('human', '用户档案')
    expect(store.getCoreBlock('persona')).toBeNull()
    expect(store.getCoreBlock('human')!.revision).toBe(1)
  })
})

describe('forgetCard', () => {
  it('cascades to derived facts, links and FTS in one transaction', () => {
    const card = store.insertCard({ summary: '秘密', content: '用户的秘密内容 secret-xyz' })
    const other = store.insertCard({ summary: '无关', content: '别的内容' })
    store.db.prepare('INSERT INTO links (src, dst, weight, created_at) VALUES (?, ?, 1, ?)')
      .run(card.id, other.id, new Date().toISOString())
    store.insertFact({ subject: 'user', predicate: 'secret', object: 'x', sourceCard: card.id })
    const report = store.forgetCard(card.id)
    expect(report).toEqual({ cards: 1, facts: 1, links: 1 })
    expect(store.getCard(card.id)).toBeNull()
    expect(store.searchCardsFts('secret-xyz')).toEqual([])
    expect(store.activeFacts('user')).toHaveLength(0)
    expect(store.getCard(other.id)).not.toBeNull()
  })

  it('forgetting an unknown id reports zero counts and does not throw', () => {
    expect(store.forgetCard('no-such-card')).toEqual({ cards: 0, facts: 0, links: 0 })
  })

  it('rolls back every delete when the cascade fails mid-transaction', () => {
    const card = store.insertCard({ summary: '秘密', content: '用户的秘密内容 secret-xyz' })
    const other = store.insertCard({ summary: '无关', content: '别的内容' })
    store.db.prepare('INSERT INTO links (src, dst, weight, created_at) VALUES (?, ?, 1, ?)')
      .run(card.id, other.id, new Date().toISOString())
    store.insertFact({ subject: 'user', predicate: 'secret', object: 'x', sourceCard: card.id })
    store.db.exec(`
      CREATE TRIGGER fail_card_delete BEFORE DELETE ON cards BEGIN
        SELECT RAISE(FAIL, 'boom');
      END
    `)
    expect(() => store.forgetCard(card.id)).toThrow(/boom/)
    // ROLLBACK 生效：facts 与 links 的先行删除一并撤销
    expect(store.getCard(card.id)).not.toBeNull()
    expect(store.activeFacts('user')).toHaveLength(1)
    const links = store.db.prepare('SELECT COUNT(*) AS n FROM links WHERE src = ? OR dst = ?')
      .get(card.id, card.id) as { n: number }
    expect(links.n).toBe(1)
    expect(store.searchCardsFts('secret-xyz')).toHaveLength(1)
  })
})
