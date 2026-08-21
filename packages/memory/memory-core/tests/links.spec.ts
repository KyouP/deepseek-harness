// packages/memory/memory-core/tests/links.spec.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openMemoryStore, type MemoryStore } from '@deepseek-ai/dsh-memory-store'
import type { LlmBackend } from '../src/llm.ts'
import { Consolidator } from '../src/consolidate.ts'
import { routeSedimentItem } from '../src/sediment.ts'
import { autoLink, extractKeywords } from '../src/links.ts'

let dir = ''
let store: MemoryStore | undefined
afterEach(() => {
  store?.close()
  store = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

const logger = { warn: vi.fn() }

const NULL_LLM: LlmBackend = {
  name: 'null',
  async complete(): Promise<string | null> {
    return null
  },
}

function setup(): MemoryStore {
  dir = mkdtempSync(join(tmpdir(), 'hmem-links-'))
  store = openMemoryStore(join(dir, 't.db'))
  return store
}

describe('extractKeywords', () => {
  it('surfaces CJK content words and drops stop characters', () => {
    const kws = extractKeywords('主人最近睡眠不太好，在说装修的事情')
    expect(kws.length).toBeGreaterThan(0)
    expect(kws.length).toBeLessThanOrEqual(8)
    expect(kws).toContain('睡眠')
    expect(kws).toContain('装修')
    for (const kw of kws) expect(kw).not.toMatch(/[的了是在我你他]/)
  })

  it('extracts latin words of ≥4 letters, lowercased, without stop words', () => {
    const kws = extractKeywords('User loves TypeScript and JavaScript but this meeting is about nothing')
    expect(kws).toContain('typescript')
    expect(kws).toContain('javascript')
    expect(kws).not.toContain('this')
    expect(kws).not.toContain('about')
    expect(kws).not.toContain('and') // <4 letters, never a candidate
    expect(kws.length).toBeLessThanOrEqual(8)
  })

  it('honors the max parameter and ranks repeated terms first', () => {
    const text = '睡眠睡眠睡眠 装修 钢琴 预算 加班 出差 健身 读书 旅行 烹饪'
    expect(extractKeywords(text, 3).length).toBeLessThanOrEqual(3)
    expect(extractKeywords(text, 3)[0]).toBe('睡眠')
  })
})

describe('autoLink', () => {
  it('links two cards sharing ≥2 keywords, visible via linkedNeighbors', () => {
    const s = setup()
    const old = s.insertCard({
      summary: '睡眠浅与厨房装修预算',
      content: '上周聊到睡眠浅，还有厨房装修的预算问题',
    })
    const fresh = s.insertCard({
      summary: '主人最近睡眠不太好',
      content: '主人最近睡眠不太好，在说装修的事情',
    })
    const linked = autoLink(s, fresh.id, fresh.content)
    expect(linked).toBeGreaterThanOrEqual(1)
    const neighbors = s.linkedNeighbors(fresh.id)
    const hit = neighbors.find(n => n.id === old.id)
    expect(hit).toBeDefined()
    expect(hit!.weight).toBeGreaterThanOrEqual(2) // weight = co-occurrence count
  })

  it('does not link cards sharing only one keyword', () => {
    const s = setup()
    const old = s.insertCard({
      summary: '睡眠严重不足',
      content: '睡眠严重不足，影响白天的精神状态',
    })
    const fresh = s.insertCard({
      summary: '睡眠监测设备很精确',
      content: '睡眠监测设备记录的数据非常精确',
    })
    // 唯一共享关键词是「睡眠」，共现 1 < 2，不建链。
    const linked = autoLink(s, fresh.id, fresh.content)
    expect(linked).toBe(0)
    expect(s.linkedNeighbors(fresh.id).find(n => n.id === old.id)).toBeUndefined()
  })

  it('never links a card to itself', () => {
    const s = setup()
    const card = s.insertCard({
      summary: '睡眠与装修',
      content: '睡眠和装修都是最近的大事，睡眠第一，装修第二',
    })
    autoLink(s, card.id, card.content)
    expect(s.linkedNeighbors(card.id).find(n => n.id === card.id)).toBeUndefined()
  })

  it('tolerates store failures without throwing', () => {
    const s = setup()
    const card = s.insertCard({ summary: '睡眠装修', content: '睡眠不足，装修烦心' })
    s.close()
    store = undefined // already closed; keep afterEach from double-closing
    expect(() => autoLink(s, card.id, card.content)).not.toThrow()
  })
})

describe('write-path wiring', () => {
  it('routeSedimentItem auto-links a store-tier card', () => {
    const s = setup()
    const old = s.insertCard({
      summary: '睡眠浅与厨房装修预算',
      content: '上周聊到睡眠浅，还有厨房装修的预算问题',
    })
    // emo 1.0 + 全新 + 同内容 suggestion hits=2 → s≈0.733 ≥ 0.7 → store 档
    const content = '主人最近睡眠不太好，在说装修的事情'
    s.addSuggestion({ kind: 'card', content })
    s.addSuggestion({ kind: 'card', content })
    const routed = routeSedimentItem(
      { kind: 'card', content, emotion: 1 },
      { store: s, logger },
    )
    expect(routed).toBe(true)
    const fresh = s.recentCards(1)[0]!
    expect(fresh.id).not.toBe(old.id)
    expect(s.linkedNeighbors(fresh.id).find(n => n.id === old.id)).toBeDefined()
  })
})

describe('Consolidator ③ link evolution', () => {
  it('tops up links among recent cards and reports the count', async () => {
    const s = setup()
    const a = s.insertCard({
      summary: '睡眠浅与厨房装修预算',
      content: '上周聊到睡眠浅，还有厨房装修的预算问题',
    })
    const b = s.insertCard({
      summary: '主人最近睡眠不太好',
      content: '主人最近睡眠不太好，在说装修的事情',
    })
    const consolidator = new Consolidator({ store: s, llm: NULL_LLM, config: {}, logger })
    const report = await consolidator.run()
    expect(report.linked).toBeGreaterThanOrEqual(1)
    expect(s.linkedNeighbors(a.id).find(n => n.id === b.id)).toBeDefined()
  })

  it('reports zero when nothing co-occurs', async () => {
    const s = setup()
    s.insertCard({ summary: '睡眠严重不足', content: '睡眠严重不足，影响白天的精神状态' })
    s.insertCard({ summary: '厨房装修预算超支', content: '厨房装修预算超支，瓷砖涨价厉害' })
    const consolidator = new Consolidator({ store: s, llm: NULL_LLM, config: {}, logger })
    const report = await consolidator.run()
    expect(report.linked).toBe(0)
  })
})
