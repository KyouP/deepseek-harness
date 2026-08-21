// packages/memory/memory-core/tests/recall.spec.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore, openMemoryStore } from '@deepseek-ai/dsh-memory-store'
import { rankedRecall } from '../src/recall.ts'

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

describe('rankedRecall', () => {
  it('pinned low-bm25 card outranks unpinned when query ties', () => {
    const plain = store.insertCard({ summary: '深色模式偏好记录', content: '深色模式偏好记录 日常' })
    const pinned = store.insertCard({ summary: '深色模式偏好记录', content: '深色模式偏好记录 日常', pinned: true })
    const hits = rankedRecall(store, '深色模式偏好记录')
    expect(hits).toHaveLength(2)
    expect(hits[0]!.id).toBe(pinned.id)
    expect(hits[1]!.id).toBe(plain.id)
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
  })

  it('relevance floor keeps weak-only batches whole, every hit marked uncertain', () => {
    // 幻星 is two characters sitting mid-run in every card: FTS prefix and the
    // trigram index both miss it, so only the LIKE substring fallback hits —
    // the weakest channel, scoring below the default floor. A weak-evidence-only
    // batch returns ALL hits (v1.1 CJK multi-hit must not regress), each
    // marked uncertain (FR-3.4).
    store.insertCard({ summary: '游戏', content: '主人喜欢玩幻星大陆游戏' })
    store.insertCard({ summary: '天气', content: '据说幻星大陆的天气不错' })
    store.insertCard({ summary: '邮票', content: '他收集了幻星主题邮票' })
    const hits = rankedRecall(store, '幻星')
    expect(hits).toHaveLength(3)
    expect(hits.every(h => h.uncertain)).toBe(true)
  })

  it('mixed batches drop the below-floor weak hits', () => {
    // 苹果 prefixes the FTS-matched card's CJK run; the other two only
    // substring-match mid-run, so they fall below the floor and are dropped
    // as long as the genuine hit clears it.
    const strong = store.insertCard({ summary: '苹果种植技术指南', content: '苹果种植技术指南 全文' })
    store.insertCard({ summary: '运输', content: '据说苹果运输要注意保鲜' })
    store.insertCard({ summary: '价格', content: '今年的苹果价格很稳定' })
    const hits = rankedRecall(store, '苹果')
    expect(hits.map(h => h.id)).toEqual([strong.id])
    expect(hits[0]!.uncertain).toBe(false)
  })

  it('one-hop neighbors of top hits get link boost', () => {
    const a = store.insertCard({ summary: '苹果种植技术指南', content: '苹果种植技术指南 全文' })
    const b = store.insertCard({ summary: '香蕉运输保鲜方案', content: '香蕉运输保鲜方案 全文' })
    store.addLink(a.id, b.id)
    const hits = rankedRecall(store, '苹果种植')
    expect(hits.map(h => h.id)).toContain(b.id)
    // The genuine FTS hit still ranks above the link-only neighbor.
    expect(hits[0]!.id).toBe(a.id)
  })

  it('facts surface as kind=fact hits, low confidence marked uncertain', () => {
    store.insertFact({ subject: '主人', predicate: '职业', object: '工程师', confidence: 0.5 })
    const hits = rankedRecall(store, '职业')
    expect(hits[0]).toMatchObject({ kind: 'fact', uncertain: true, summary: '主人 职业 → 工程师' })
  })

  it('high-confidence facts are not marked uncertain', () => {
    store.insertFact({ subject: '主人', predicate: '职业', object: '工程师', confidence: 0.9 })
    const hits = rankedRecall(store, '职业')
    expect(hits[0]).toMatchObject({ kind: 'fact', uncertain: false })
  })

  it('deep recall revives archived cards', () => {
    const card = store.insertCard({ summary: '深海档案馆的秘密条目', content: '深海档案馆的秘密条目 全文' })
    store.updateCardDerived(card.id, { archived: true, strength: 0.1 })
    expect(rankedRecall(store, '深海档案馆')).toEqual([])
    const hits = rankedRecall(store, '深海档案馆', { deep: true })
    expect(hits.map(h => h.id)).toEqual([card.id])
    const after = store.getCard(card.id)!
    expect(after.archived).toBe(false)
    expect(after.strength).toBeGreaterThanOrEqual(0.5)
  })

  it('strength/recency ordering: recently touched card beats stale equal-text card', () => {
    const weak = store.insertCard({ summary: '晨跑记录周三', content: '晨跑记录周三 全文', strength: 0.5 })
    const strong = store.insertCard({ summary: '晨跑记录周三', content: '晨跑记录周三 全文', strength: 2 })
    const hits = rankedRecall(store, '晨跑记录')
    expect(hits).toHaveLength(2)
    expect(hits[0]!.id).toBe(strong.id)
    expect(hits[1]!.id).toBe(weak.id)
  })

  it('returns no hits for an empty query', () => {
    store.insertCard({ summary: 's', content: 'c' })
    store.insertFact({ subject: '主人', predicate: '职业', object: '工程师' })
    expect(rankedRecall(store, '')).toEqual([])
    expect(rankedRecall(store, '   ')).toEqual([])
  })

  it('honours the limit option', () => {
    store.insertCard({ summary: '偏好深色模式', content: '偏好深色模式 一' })
    store.insertCard({ summary: '偏好浅色图标', content: '偏好浅色图标 二' })
    expect(rankedRecall(store, '偏好', { limit: 1 })).toHaveLength(1)
  })

  it('workspace-scoped recall boosts same-workspace cards', () => {
    const other = store.insertCard({ summary: '烘焙温度记录', content: '烘焙温度记录 全文', workspace: 'ws-b' })
    const mine = store.insertCard({ summary: '烘焙温度记录', content: '烘焙温度记录 全文', workspace: 'ws-a' })
    const hits = rankedRecall(store, '烘焙温度', { workspace: 'ws-a', workspaceScope: true })
    expect(hits).toHaveLength(2)
    expect(hits[0]!.id).toBe(mine.id)
    expect(hits[1]!.id).toBe(other.id)
  })

  it('reinforces accessed cards through touchCards (FR-7.1)', () => {
    const card = store.insertCard({ summary: ' touched 强化目标', content: 'touched 强化目标 全文', strength: 1 })
    const before = store.getCard(card.id)!.strength
    rankedRecall(store, 'touched')
    expect(store.getCard(card.id)!.strength).toBeGreaterThan(before)
  })

  it('pinned cards are reinforced too, but the +0.1 stays capped at 5', () => {
    // The strength cap lives store-side (touchCards: MIN(5, strength + boost))
    // and applies to pinned cards as well — pinning exempts decay, not the cap.
    const pinned = store.insertCard({ summary: '钉住的高强卡', content: '钉住的高强卡 全文', strength: 4.98, pinned: true })
    const hits = rankedRecall(store, '钉住的高强卡')
    expect(hits.map(h => h.id)).toEqual([pinned.id])
    expect(store.getCard(pinned.id)!.strength).toBe(5)
  })

  it('link-boosts a neighbor that is already a search hit', () => {
    const a = store.insertCard({ summary: '苹果种植技术指南', content: '苹果种植技术指南 全文' })
    const b = store.insertCard({ summary: '苹果运输保鲜方案', content: '苹果运输保鲜方案 全文' })
    store.addLink(a.id, b.id)
    const hits = rankedRecall(store, '苹果')
    expect(hits.map(h => h.id)).toEqual(expect.arrayContaining([a.id, b.id]))
  })

  it('deep recall on a live card leaves it untouched and unrevived', () => {
    const card = store.insertCard({ summary: '浅色图标偏好', content: '浅色图标偏好 全文' })
    const hits = rankedRecall(store, '浅色图标', { deep: true })
    expect(hits.map(h => h.id)).toEqual([card.id])
    expect(store.getCard(card.id)!.archived).toBe(false)
  })

  it('honours a custom relevance floor', () => {
    store.insertCard({ summary: '早起喝水提醒', content: '早起喝水提醒 全文' })
    // A floor above every possible score forces the lone-survivor arm.
    const hits = rankedRecall(store, '早起喝水', { floor: 99 })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.uncertain).toBe(true)
    // A zero floor disables filtering entirely.
    expect(rankedRecall(store, '早起喝水', { floor: 0 })).toHaveLength(1)
  })

  it('returns no hits for a non-positive limit', () => {
    store.insertCard({ summary: '限制条数', content: '限制条数 全文' })
    expect(rankedRecall(store, '限制条数', { limit: 0 })).toEqual([])
  })

  it('workspaceScope without a workspace id boosts nothing', () => {
    store.insertCard({ summary: '烘焙温度记录', content: '烘焙温度记录 全文', workspace: 'ws-a' })
    const hits = rankedRecall(store, '烘焙温度', { workspaceScope: true })
    expect(hits).toHaveLength(1)
  })
})
