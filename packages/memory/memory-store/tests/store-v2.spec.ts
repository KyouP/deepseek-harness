import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore, openMemoryStore } from '../src/index.ts'

let store: MemoryStore
beforeEach(() => {
  store = openMemoryStore(':memory:')
})
afterEach(() => {
  store.close()
})

describe('links', () => {
  it('addLink + linkedNeighbors traverse both directions', () => {
    const a = store.insertCard({ summary: 'A', content: 'a' })
    const b = store.insertCard({ summary: 'B', content: 'b' })
    store.addLink(a.id, b.id, 2)
    expect(store.linkedNeighbors(a.id)).toEqual([{ id: b.id, summary: 'B', weight: 2 }])
    expect(store.linkedNeighbors(b.id)).toEqual([{ id: a.id, summary: 'A', weight: 2 }])
  })

  it('addLink accumulates weight on repeat links', () => {
    const a = store.insertCard({ summary: 'A', content: 'a' })
    const b = store.insertCard({ summary: 'B', content: 'b' })
    store.addLink(a.id, b.id, 2)
    store.addLink(a.id, b.id, 3)
    expect(store.linkedNeighbors(a.id)).toEqual([{ id: b.id, summary: 'B', weight: 5 }])
  })

  it('linkedNeighbors skips archived neighbors and caps at limit', () => {
    const hub = store.insertCard({ summary: 'hub', content: 'h' })
    const live = store.insertCard({ summary: 'live', content: 'l' })
    const dead = store.insertCard({ summary: 'dead', content: 'd' })
    store.addLink(hub.id, live.id, 1)
    store.addLink(hub.id, dead.id, 2)
    store.updateCardDerived(dead.id, { archived: true })
    expect(store.linkedNeighbors(hub.id)).toEqual([{ id: live.id, summary: 'live', weight: 1 }])
    expect(store.linkedNeighbors(hub.id, 0)).toEqual([])
  })
})

describe('decay', () => {
  it('settleDecay decays unpinned, archives below threshold, spares pinned', () => {
    // Δt 由 meta decay:last 或逐卡 recorded_at 起算：把 recorded_at 回拨 30 天，
    // 以 now 为结算点，模拟 30 天的指数衰减。
    const old = new Date(Date.now() - 30 * 864e5).toISOString()
    const weak = store.insertCard({ summary: 'w', content: 'w', strength: 0.21 })
    const pin = store.insertCard({ summary: 'p', content: 'p', strength: 0.21, pinned: true })
    store.db.prepare('UPDATE cards SET recorded_at = ?').run(old)
    const r = store.settleDecay(new Date().toISOString(), 0.02, 0.2)
    expect(r.decayed).toBe(1)
    expect(r.archived).toBe(1)
    expect(store.getCard(weak.id)?.archived).toBe(true)
    expect(store.getCard(weak.id)?.strength).toBeLessThan(0.2)
    expect(store.getCard(pin.id)?.archived).toBe(false)
    expect(store.getCard(pin.id)?.strength).toBe(0.21)
  })

  it('settling decay is incremental (meta watermark), not cumulative', () => {
    const c = store.insertCard({ summary: 'x', content: 'x', strength: 1 })
    store.settleDecay(new Date().toISOString(), 0.02, 0.2)
    const once = store.getCard(c.id)!.strength
    store.settleDecay(new Date().toISOString(), 0.02, 0.2) // 同一时刻第二次 Δt≈0
    expect(store.getCard(c.id)!.strength).toBeCloseTo(once, 5)
  })

  it('already-archived cards are not decayed again', () => {
    const old = new Date(Date.now() - 30 * 864e5).toISOString()
    const c = store.insertCard({ summary: 'x', content: 'x', strength: 0.5 })
    store.db.prepare('UPDATE cards SET recorded_at = ?').run(old)
    store.updateCardDerived(c.id, { archived: true })
    const r = store.settleDecay(new Date().toISOString(), 0.02, 0.2)
    expect(r.decayed).toBe(0)
    expect(store.getCard(c.id)?.strength).toBe(0.5)
  })
})

describe('touchCards / reviveCard / recentCards', () => {
  it('touchCards boosts strength, capped at 5', () => {
    const near = store.insertCard({ summary: 'n', content: 'n', strength: 4.95 })
    const low = store.insertCard({ summary: 'l', content: 'l', strength: 1 })
    store.touchCards([near.id, low.id], 0.1)
    expect(store.getCard(near.id)?.strength).toBe(5)
    expect(store.getCard(low.id)?.strength).toBeCloseTo(1.1, 5)
    store.touchCards([low.id]) // default boost 0.1
    expect(store.getCard(low.id)?.strength).toBeCloseTo(1.2, 5)
  })

  it('reviveCard clears archived and raises strength to at least 0.5', () => {
    const weakCard = store.insertCard({ summary: 'w', content: 'w', strength: 0.1 })
    store.updateCardDerived(weakCard.id, { archived: true })
    store.reviveCard(weakCard.id)
    expect(store.getCard(weakCard.id)?.archived).toBe(false)
    expect(store.getCard(weakCard.id)?.strength).toBe(0.5)

    const strong = store.insertCard({ summary: 's', content: 's', strength: 0.8 })
    store.updateCardDerived(strong.id, { archived: true })
    store.reviveCard(strong.id)
    expect(store.getCard(strong.id)?.archived).toBe(false)
    expect(store.getCard(strong.id)?.strength).toBe(0.8) // max(0.5)：不压低强卡
  })

  it('recentCards returns newest first and excludes archived', () => {
    const c1 = store.insertCard({ summary: 'one', content: '1' })
    const c2 = store.insertCard({ summary: 'two', content: '2' })
    const c3 = store.insertCard({ summary: 'three', content: '3' })
    store.updateCardDerived(c3.id, { archived: true })
    expect(store.recentCards().map(c => c.id)).toEqual([c2.id, c1.id])
    expect(store.recentCards(1).map(c => c.id)).toEqual([c2.id])
  })
})

describe('searchFacts', () => {
  it('returns only active facts, LIKE-matching subject/predicate/object', () => {
    const live = store.insertFact({ subject: '用户', predicate: '偏好', object: '简洁回复' })
    const dead = store.insertFact({ subject: '用户', predicate: '偏好', object: '冗长回复' })
    const next = store.supersedeFact(dead.id, { subject: '用户', predicate: '风格', object: '直接' })

    const byObject = store.searchFacts('简洁')
    expect(byObject.map(f => f.id)).toEqual([live.id])

    const bySubject = store.searchFacts('用户')
    expect(bySubject.map(f => f.id).sort()).toEqual([live.id, next.id].sort())

    const byPredicate = store.searchFacts('风格')
    expect(byPredicate.map(f => f.id)).toEqual([next.id])

    // 被取代的旧事实即使 LIKE 命中也不返回
    expect(store.searchFacts('冗长')).toEqual([])
  })
})

describe('scratchpad windowing', () => {
  it('deleteNotesBefore deletes strictly older notes and returns the count', () => {
    store.addNote(null, 'a')
    store.addNote(null, 'b')
    const future = new Date(Date.now() + 60e3).toISOString()
    expect(store.deleteNotesBefore(future)).toBe(2)
    expect(store.deleteNotesBefore(future)).toBe(0)
    store.addNote(null, 'c')
    expect(store.deleteNotesBefore(new Date(Date.now() - 60e3).toISOString())).toBe(0)
    expect(store.recentNotes(new Date(0).toISOString()).map(n => n.text)).toEqual(['c'])
  })

  it('notesBetween filters by the [since, until] window, oldest first', () => {
    store.addNote(null, 'n1')
    store.addNote(null, 'n2')
    const now = Date.now()
    const inside = store.notesBetween(
      new Date(now - 60e3).toISOString(),
      new Date(now + 60e3).toISOString(),
    )
    expect(inside.map(n => n.text)).toEqual(['n1', 'n2'])
    expect(store.notesBetween(
      new Date(now + 60e3).toISOString(),
      new Date(now + 120e3).toISOString(),
    )).toEqual([])
  })
})

describe('dueSoonCommitments', () => {
  it('includes commitments due within the window, excludes closed and overdue', () => {
    const now = Date.now()
    const in24h = new Date(now + 24 * 3600e3).toISOString()
    store.addCommitment({ content: '24h 后到期', dueAt: in24h })
    store.addCommitment({ content: '72h 后到期', dueAt: new Date(now + 72 * 3600e3).toISOString() })
    store.addCommitment({ content: '已过期', dueAt: new Date(now - 3600e3).toISOString() })
    const closed = store.addCommitment({ content: '已关闭', dueAt: in24h })
    store.closeCommitment(closed.id, 'done')
    store.addCommitment({ content: '无期限' })

    const soon = store.dueSoonCommitments(new Date(now).toISOString(), 48)
    expect(soon.map(c => c.content)).toEqual(['24h 后到期'])
  })
})

describe('suggestions', () => {
  it('suggestions merge identical content and count hits', () => {
    const s1 = store.addSuggestion({ kind: 'user', content: '用户喜欢简洁回复' })
    const s2 = store.addSuggestion({ kind: 'user', content: '用户喜欢简洁回复' })
    expect(s1.merged).toBe(false)
    expect(s2.merged).toBe(true)
    expect(s2.suggestion.id).toBe(s1.suggestion.id)
    expect(store.listSuggestions()[0]?.hits).toBe(2)
  })

  it('merge key is kind + content: same text with another kind inserts new', () => {
    const a = store.addSuggestion({ kind: 'user', content: '同一段文本' })
    const b = store.addSuggestion({ kind: 'fact', content: '同一段文本' })
    expect(b.merged).toBe(false)
    expect(b.suggestion.id).not.toBe(a.suggestion.id)
  })

  it('listSuggestions filters by status; resolveSuggestion updates status', () => {
    const a = store.addSuggestion({ kind: 'user', content: '建议A' })
    const b = store.addSuggestion({ kind: 'fact', content: '建议B' })
    expect(store.listSuggestions()).toHaveLength(2)
    expect(store.listSuggestions('pending')).toHaveLength(2)

    store.resolveSuggestion(b.suggestion.id, 'approved')
    expect(store.listSuggestions('pending').map(s => s.id)).toEqual([a.suggestion.id])
    expect(store.listSuggestions('approved').map(s => s.id)).toEqual([b.suggestion.id])
    expect(store.listSuggestions('rejected')).toEqual([])
  })
})

describe('embeddings', () => {
  it('embedding round-trips as float32', () => {
    const c = store.insertCard({ summary: 'e', content: 'e' })
    store.setEmbedding(c.id, [0.1, 0.2, 0.3])
    const v = store.cardsWithEmbeddings().find(r => r.id === c.id)?.vector
    expect(v).toHaveLength(3)
    expect(v?.[0]).toBeCloseTo(0.1, 5)
    expect(v?.[1]).toBeCloseTo(0.2, 5)
    expect(v?.[2]).toBeCloseTo(0.3, 5)
  })

  it('cardsWithoutEmbeddings lists only live cards missing a vector', () => {
    const bare = store.insertCard({ summary: '无向量', content: '正文内容' })
    const embedded = store.insertCard({ summary: '有向量', content: 'x' })
    store.setEmbedding(embedded.id, [1, 2])
    const archived = store.insertCard({ summary: '已归档', content: 'y' })
    store.updateCardDerived(archived.id, { archived: true })

    const rows = store.cardsWithoutEmbeddings()
    expect(rows.map(r => r.id)).toEqual([bare.id])
    expect(rows[0]?.text).toContain('无向量')
    expect(rows[0]?.text).toContain('正文内容')
  })
})

describe('dump', () => {
  it('dump round-trips every table', () => {
    const card = store.insertCard({ summary: 'd', content: 'd' })
    store.insertFact({ subject: 's', predicate: 'p', object: 'o' })
    store.addCommitment({ content: 'c' })
    store.setCoreBlock('persona', '人格文本')
    store.addNote(null, '便签')
    store.addLink(card.id, card.id, 1)

    const dump = store.dump()
    expect(Object.keys(dump).sort()).toEqual(
      ['cards', 'commitments', 'coreBlocks', 'facts', 'links', 'notes'].sort(),
    )
    expect(dump.cards).toHaveLength(1)
    expect(dump.facts).toHaveLength(1)
    expect(dump.commitments).toHaveLength(1)
    expect(dump.coreBlocks).toHaveLength(1)
    expect(dump.notes).toHaveLength(1)
    expect(dump.links).toHaveLength(1)

    expect(dump.cards[0]?.id).toBe(card.id)
    expect(dump.coreBlocks[0]).toMatchObject({ name: 'persona', text: '人格文本', revision: 1 })
    expect(dump.links[0]).toEqual({ src: card.id, dst: card.id, weight: 1 })
    expect(dump.notes[0]?.text).toBe('便签')
  })
})
