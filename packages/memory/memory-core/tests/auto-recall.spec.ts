// packages/memory/memory-core/tests/auto-recall.spec.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { MemoryStore, openMemoryStore } from '@deepseek-ai/dsh-memory-store'
import { AutoRecall, mountAutoRecall, RECALL_BLOCK_HEADER } from '../src/auto-recall.ts'
import { TRUNCATION_MARKER } from '../src/budget.ts'

let store: MemoryStore
beforeEach(() => {
  store = openMemoryStore(':memory:')
})
afterEach(() => {
  vi.restoreAllMocks()
  store.close()
})

const config = { recallAutoInject: true, recallBudgetChars: 1800, recallRelevanceFloor: 0.05 }

// The recall channels (trigram phrase / LIKE substring) need the user text to
// appear verbatim in the card; rankedRecall's own semantics are covered by
// recall.spec.ts — these tests exercise the injection plumbing.
function seedSleepCard() {
  return store.insertCard({
    summary: '主人睡眠质量差，经常失眠',
    content: '主人提到：最近的睡眠质量很差，经常失眠到凌晨，白天精神不济。',
  })
}
const QUERY = '最近的睡眠质量很差'

describe('AutoRecall', () => {
  it('recalls on new user text and renders a budget-capped block', () => {
    const card = seedSleepCard()
    const autoRecall = new AutoRecall(store, config)
    expect(autoRecall.render()).toBe('')
    autoRecall.onPreStep([{ content: QUERY }])
    const block = autoRecall.render()
    expect(block.startsWith(RECALL_BLOCK_HEADER)).toBe(true)
    expect(block).toContain('睡眠')
    expect(block).toContain(`- [${card.id}] 主人睡眠质量差，经常失眠`)

    // The block honours the char budget via truncateChars.
    const tiny = new AutoRecall(store, { ...config, recallBudgetChars: 30 })
    tiny.onPreStep([{ content: QUERY }])
    expect(tiny.render()).toContain(TRUNCATION_MARKER)
  })

  it('extracts text from content blocks, ignoring non-text blocks', () => {
    seedSleepCard()
    const autoRecall = new AutoRecall(store, config)
    autoRecall.onPreStep([{
      content: [
        { type: 'image_url', image_url: { url: 'https://example.invalid/x.png' } },
        { type: 'text', text: '最近的睡' },
        { type: 'reasoning', text: '不应计入查询' },
        { type: 'text', text: '眠质量很差' },
      ],
    }])
    expect(autoRecall.render()).toContain('睡眠')
  })

  it('does not re-query when user text is unchanged (byte-stable render)', () => {
    seedSleepCard()
    const fts = vi.spyOn(store, 'searchCardsFts')
    const tri = vi.spyOn(store, 'searchCardsTri')
    const autoRecall = new AutoRecall(store, config)
    autoRecall.onPreStep([{ content: QUERY }])
    const first = autoRecall.render()
    expect(first).not.toBe('')
    autoRecall.onPreStep([{ content: QUERY }])
    const second = autoRecall.render()
    expect(fts).toHaveBeenCalledTimes(1)
    expect(tri).toHaveBeenCalledTimes(1)
    expect(second).toBe(first)
    // render() itself never hits the store: it replays the cached block.
    autoRecall.render()
    autoRecall.render()
    expect(fts).toHaveBeenCalledTimes(1)
  })

  it('skips short/greeting texts (<8 chars) without querying', () => {
    seedSleepCard()
    const fts = vi.spyOn(store, 'searchCardsFts')
    const tri = vi.spyOn(store, 'searchCardsTri')
    const autoRecall = new AutoRecall(store, config)
    autoRecall.onPreStep([{ content: '你好' }])
    expect(autoRecall.render()).toBe('')
    expect(fts).not.toHaveBeenCalled()
    expect(tri).not.toHaveBeenCalled()
  })

  it('respects recallAutoInject=false: render stays empty and no query runs', () => {
    seedSleepCard()
    const fts = vi.spyOn(store, 'searchCardsFts')
    const autoRecall = new AutoRecall(store, { ...config, recallAutoInject: false })
    autoRecall.onPreStep([{ content: QUERY }])
    expect(autoRecall.render()).toBe('')
    expect(fts).not.toHaveBeenCalled()
  })

  it('store failure renders empty without throwing and logs once per failure', () => {
    seedSleepCard()
    const warn = vi.fn()
    vi.spyOn(store, 'searchCardsFts').mockImplementation(() => { throw new Error('db fault') })
    const autoRecall = new AutoRecall(store, config, { warn })
    expect(() => autoRecall.onPreStep([{ content: QUERY }])).not.toThrow()
    expect(autoRecall.render()).toBe('')
    expect(warn).toHaveBeenCalledTimes(1)
    // The failed query is still cached: an unchanged text does not retry the
    // failing store on every step, so the failure logs exactly once.
    autoRecall.onPreStep([{ content: QUERY }])
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('mounts the agent/pre-step listener and the hmem:recall context provider', () => {
    seedSleepCard()
    const contexts: { name: string; order: number; text: () => string }[] = []
    const listeners: ((payload: { messages: { content: unknown }[] }, next: () => unknown) => unknown)[] = []
    const fakeCtx = {
      systemPrompt: {
        context: (c: { name: string; order: number; text: () => string }) => {
          contexts.push(c)
          return () => {}
        },
      },
      on: (_event: string, listener: (payload: { messages: { content: unknown }[] }, next: () => unknown) => unknown) => {
        listeners.push(listener)
      },
      logger: { warn: vi.fn() },
    }
    mountAutoRecall(fakeCtx as unknown as Context, store, config)

    expect(contexts.map(c => [c.name, c.order])).toEqual([['hmem:recall', 15]])
    expect(listeners).toHaveLength(1)

    // Waterfall semantics: the listener's return value IS next()'s value.
    const next = vi.fn(() => 'decision')
    const result = listeners[0]!({ messages: [{ content: QUERY }] }, next)
    expect(result).toBe('decision')
    expect(next).toHaveBeenCalledTimes(1)
    expect(contexts[0]!.text()).toContain('睡眠')

    // A store fault inside the listener still cannot veto the step.
    vi.spyOn(store, 'searchCardsFts').mockImplementation(() => { throw new Error('db fault') })
    const result2 = listeners[0]!({ messages: [{ content: '完全不一样的查询文本' }] }, next)
    expect(result2).toBe('decision')
    expect(next).toHaveBeenCalledTimes(2)
  })
})
