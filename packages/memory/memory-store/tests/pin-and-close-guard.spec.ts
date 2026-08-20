// packages/memory/memory-store/tests/pin-and-close-guard.spec.ts
// Store-level coverage for setCardPinned (dedicated SQL outside the
// updateCardDerived whitelist) and the closeCommitment active-row guard.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore, openMemoryStore } from '../src/index.ts'

let store: MemoryStore
beforeEach(() => {
  store = openMemoryStore(':memory:')
})
afterEach(() => {
  store.close()
})

describe('setCardPinned', () => {
  it('flips pinned both ways, visible via getCard', () => {
    const card = store.insertCard({ summary: 's', content: 'c' })
    expect(card.pinned).toBe(false)
    store.setCardPinned(card.id, true)
    expect(store.getCard(card.id)?.pinned).toBe(true)
    store.setCardPinned(card.id, false)
    expect(store.getCard(card.id)?.pinned).toBe(false)
  })

  it('leaves other columns untouched', () => {
    const card = store.insertCard({ summary: 's', content: 'c', salience: 0.7, strength: 2 })
    store.setCardPinned(card.id, true)
    const after = store.getCard(card.id)!
    expect(after.summary).toBe('s')
    expect(after.content).toBe('c')
    expect(after.salience).toBe(0.7)
    expect(after.strength).toBe(2)
  })

  it('pinned is still rejected by the updateCardDerived whitelist', () => {
    const card = store.insertCard({ summary: 's', content: 'c' })
    expect(() => store.updateCardDerived(card.id, { pinned: true } as never))
      .toThrow('cards UPDATE whitelist violation: pinned')
  })
})

describe('closeCommitment guard', () => {
  it('closes an active commitment', () => {
    const c = store.addCommitment({ content: '可关闭' })
    expect(() => store.closeCommitment(c.id, 'done')).not.toThrow()
    expect(store.activeCommitments()).toHaveLength(0)
  })

  it('throws on a non-existent id', () => {
    expect(() => store.closeCommitment('nope', 'done'))
      .toThrow('no active commitment with id nope')
  })

  it('throws when closing an already-closed commitment', () => {
    const c = store.addCommitment({ content: '重复关闭' })
    store.closeCommitment(c.id, 'done')
    expect(() => store.closeCommitment(c.id, 'cancelled'))
      .toThrow(`no active commitment with id ${c.id}`)
  })
})
