// packages/memory/memory-store/tests/cards.spec.ts
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

describe('cards', () => {
  it('round-trips an inserted card with defaults applied', () => {
    const card = store.insertCard({ summary: '喜欢深色模式', content: '用户说界面偏好深色模式。' })
    const got = store.getCard(card.id)
    expect(got).toMatchObject({
      summary: '喜欢深色模式',
      pinned: false,
      archived: false,
      salience: 0,
      strength: 1,
      keywords: [],
    })
    expect(got!.recordedAt).toBeTruthy()
  })

  it('finds inserted cards through FTS and excludes archived ones', () => {
    const a = store.insertCard({ summary: '深色模式偏好', content: '用户偏好深色模式界面' })
    store.insertCard({ summary: '无关卡片', content: '今天天气不错' })
    const hits = store.searchCardsFts('深色模式')
    expect(hits.map(h => h.id)).toEqual([a.id])
    store.updateCardDerived(a.id, { archived: true })
    expect(store.searchCardsFts('深色模式')).toEqual([])
  })

  it('rejects non-whitelisted derived updates', () => {
    const card = store.insertCard({ summary: 's', content: 'c' })
    expect(() => { store.updateCardDerived(card.id, { summary: 'evil' } as never) }).toThrow(/whitelist/)
  })

  it('returns null for an unknown card id', () => {
    expect(store.getCard('missing')).toBeNull()
  })

  it('round-trips all optional fields when provided', () => {
    const card = store.insertCard({
      summary: 's', content: 'c', contextDesc: 'ctx', keywords: ['a', 'b'],
      emotion: 'calm', salience: 0.5, strength: 2, pinned: true,
      sessionId: 'sess-1', validFrom: '2026-01-01', validTo: '2026-02-01',
    })
    expect(store.getCard(card.id)).toMatchObject({
      contextDesc: 'ctx', keywords: ['a', 'b'], emotion: 'calm',
      salience: 0.5, strength: 2, pinned: true, sessionId: 'sess-1',
      validFrom: '2026-01-01', validTo: '2026-02-01',
    })
  })

  it('updates each whitelisted derived column and ignores empty patches', () => {
    const card = store.insertCard({ summary: 's', content: 'c' })
    store.updateCardDerived(card.id, { strength: 3, contextDesc: 'new ctx' })
    store.updateCardDerived(card.id, { archived: true })
    store.updateCardDerived(card.id, { archived: false })
    store.updateCardDerived(card.id, {})
    expect(store.getCard(card.id)).toMatchObject({
      strength: 3, contextDesc: 'new ctx', archived: false,
    })
  })

  it('returns no hits for an empty query', () => {
    store.insertCard({ summary: 's', content: 'c' })
    expect(store.searchCardsFts('')).toEqual([])
    expect(store.searchCardsFts('   ')).toEqual([])
  })
})
