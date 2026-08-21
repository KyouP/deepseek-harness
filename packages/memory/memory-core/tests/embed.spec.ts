// packages/memory/memory-core/tests/embed.spec.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryStore, openMemoryStore } from '@deepseek-ai/dsh-memory-store'
import { cosine, embedCard, rrfMerge } from '../src/embed.ts'
import { createEmbedder, OllamaEmbedder, type Embedder } from '../src/llm.ts'
import { rankedRecall } from '../src/recall.ts'
import { routeSedimentItem } from '../src/sediment.ts'
import { Consolidator } from '../src/consolidate.ts'
import { AutoRecall } from '../src/auto-recall.ts'

let dir = ''
let store: MemoryStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hmem-'))
  store = openMemoryStore(join(dir, 'hmem.db'))
})
afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Flush the detached queueMicrotask + promise chain used by embedCard/AutoRecall. */
async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

const noopLogger = { warn: () => {} }

describe('cosine', () => {
  it('orthogonal vectors score 0, same direction scores 1', () => {
    expect(cosine([1, 0, 0], [0, 1, 0])).toBe(0)
    expect(cosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10)
  })

  it('zero-norm or mismatched vectors score 0 instead of NaN', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0)
    expect(cosine([1, 1], [0, 0])).toBe(0)
    expect(cosine([1, 2, 3], [1, 2])).toBe(0)
  })
})

describe('rrfMerge', () => {
  it('accumulates 1/(k+rank) per channel and orders by the merged score', () => {
    const merged = rrfMerge([
      [{ id: 'a' }, { id: 'b' }],
      [{ id: 'b' }, { id: 'c' }],
    ])
    expect(merged.get('a')).toBeCloseTo(1 / 61, 10)
    expect(merged.get('b')).toBeCloseTo(1 / 62 + 1 / 61, 10)
    expect(merged.get('c')).toBeCloseTo(1 / 62, 10)
    const ordered = [...merged.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id)
    expect(ordered).toEqual(['b', 'a', 'c'])
  })

  it('honours a custom k', () => {
    const merged = rrfMerge([[{ id: 'x' }]], 10)
    expect(merged.get('x')).toBeCloseTo(1 / 11, 10)
  })
})

describe('OllamaEmbedder', () => {
  it('posts /api/embed with {model, input} and returns the embeddings', async () => {
    const calls: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, JSON.parse(String(init.body))])
      return jsonResponse({ embeddings: [[0.1, 0.2], [0.3, 0.4]] })
    }))
    const embedder = new OllamaEmbedder('http://127.0.0.1:11434', 'bge-m3')
    const result = await embedder.embed(['你好', '世界'])
    expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]])
    expect(calls[0]).toEqual(['http://127.0.0.1:11434/api/embed', { model: 'bge-m3', input: ['你好', '世界'] }])
  })

  it('returns null on network error, non-200 and malformed bodies', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500))
      .mockResolvedValueOnce(jsonResponse({ unexpected: true }))
    vi.stubGlobal('fetch', fetchMock)
    const embedder = new OllamaEmbedder('http://127.0.0.1:11434', 'bge-m3')
    expect(await embedder.embed(['x'])).toBeNull()
    expect(await embedder.embed(['x'])).toBeNull()
    expect(await embedder.embed(['x'])).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('createEmbedder gates on embedEnabled and defaults the model to bge-m3', async () => {
    expect(createEmbedder({ embedEnabled: false })).toBeNull()
    expect(createEmbedder({})).toBeNull()
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return jsonResponse({ embeddings: [[1]] })
    }))
    const embedder = createEmbedder({ embedEnabled: true })!
    expect(embedder).not.toBeNull()
    await embedder.embed(['x'])
    expect((bodies[0] as { model: string }).model).toBe('bge-m3')
  })
})

describe('embedCard', () => {
  it('detached-embeds a stored card; the vector lands in the store', async () => {
    const card = store.insertCard({ summary: '猫', content: '主人养了一只叫年糕的猫' })
    const embedder: Embedder = { embed: async () => [[1, 0, 0]] }
    embedCard(store, embedder, card)
    await flush()
    const embedded = store.cardsWithEmbeddings()
    expect(embedded).toHaveLength(1)
    expect(embedded[0]!.id).toBe(card.id)
    expect(embedded[0]!.vector[0]).toBeCloseTo(1, 5)
  })

  it('failure is silent: a rejecting embedder leaves no embedding and never throws', async () => {
    const card = store.insertCard({ summary: '猫', content: '主人养了一只叫年糕的猫' })
    const embedder: Embedder = { embed: async () => { throw new Error('ollama down') } }
    embedCard(store, embedder, card)
    const nullEmbedder: Embedder = { embed: async () => null }
    embedCard(store, nullEmbedder, card)
    await flush()
    expect(store.cardsWithEmbeddings()).toHaveLength(0)
  })

  it('null embedder is a no-op', async () => {
    const card = store.insertCard({ summary: '猫', content: '主人养了一只叫年糕的猫' })
    embedCard(store, null, card)
    await flush()
    expect(store.cardsWithEmbeddings()).toHaveLength(0)
  })
})

describe('rankedRecall vector channel', () => {
  function seedKeywordAndSemantic() {
    const keyword = store.insertCard({ summary: '苹果种植技术指南', content: '苹果种植技术指南 全文' })
    // Semantically adjacent to the query vector but sharing NO keyword with it.
    const semantic = store.insertCard({ summary: '深度神经网络调参笔记', content: '深度神经网络调参笔记 全文' })
    store.setEmbedding(semantic.id, [1, 0, 0])
    return { keyword, semantic }
  }

  it('a semantic hit with no keyword match enters the results via RRF fusion', () => {
    const { keyword, semantic } = seedKeywordAndSemantic()
    const hits = rankedRecall(store, '苹果', { queryVector: [1, 0, 0] })
    const ids = hits.map(h => h.id)
    expect(ids).toContain(semantic.id)
    expect(ids[0]).toBe(keyword.id)
    expect(hits.find(h => h.id === semantic.id)!.uncertain).toBe(false)
  })

  it('without a query vector the semantic-only card stays absent (baseline unchanged)', () => {
    const { keyword, semantic } = seedKeywordAndSemantic()
    const hits = rankedRecall(store, '苹果')
    expect(hits.map(h => h.id)).toEqual([keyword.id])
    expect(hits.map(h => h.id)).not.toContain(semantic.id)
  })

  it('a query vector with no embedded cards yields results identical to the disabled channel', () => {
    store.insertCard({ summary: '苹果种植技术指南', content: '苹果种植技术指南 全文' })
    const withVector = rankedRecall(store, '苹果', { queryVector: [1, 0, 0] })
    const without = rankedRecall(store, '苹果')
    // Scores themselves shift between the two calls because the first recall
    // reinforces strength via touchCards — compare the observable hit shape.
    expect(withVector.map(h => [h.id, h.kind, h.uncertain])).toEqual(without.map(h => [h.id, h.kind, h.uncertain]))
  })

  it('a store whose cardsWithEmbeddings throws degrades to the baseline results', () => {
    const { keyword } = seedKeywordAndSemantic()
    const original = store.cardsWithEmbeddings.bind(store)
    store.cardsWithEmbeddings = () => { throw new Error('store exploded') }
    try {
      const hits = rankedRecall(store, '苹果', { queryVector: [1, 0, 0] })
      expect(hits.map(h => h.id)).toEqual([keyword.id])
    } finally {
      store.cardsWithEmbeddings = original
    }
  })

  it('higher similarity ranks above lower similarity inside the vector channel', () => {
    const near = store.insertCard({ summary: '向量近邻卡甲', content: '向量近邻卡甲 全文' })
    const far = store.insertCard({ summary: '向量近邻卡乙', content: '向量近邻卡乙 全文' })
    store.setEmbedding(near.id, [1, 0.1, 0])
    store.setEmbedding(far.id, [1, 0.9, 0])
    const hits = rankedRecall(store, '苹果', { queryVector: [1, 0, 0] })
    expect(hits.map(h => h.id)).toEqual([near.id, far.id])
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
  })
})

describe('sediment routing embed trigger', () => {
  it('routeSedimentItem embeds a routed card detached when deps carry an embedder', async () => {
    const embedder: Embedder = { embed: async () => [[0, 1, 0]] }
    // emo 1.0 + 同内容 suggestion hits=2 → s≈0.733 ≥ 0.7 → store 档（Task 16 门控）
    store.addSuggestion({ kind: 'card', content: '主人喜欢喝手冲咖啡' })
    store.addSuggestion({ kind: 'card', content: '主人喜欢喝手冲咖啡' })
    const ok = routeSedimentItem(
      { kind: 'card', content: '主人喜欢喝手冲咖啡', emotion: 1 },
      { store, logger: noopLogger, embedder },
    )
    expect(ok).toBe(true)
    await flush()
    expect(store.cardsWithEmbeddings()).toHaveLength(1)
  })
})

describe('Consolidator ⑦ embedding backfill', () => {
  it('backfills up to 20 cards without embeddings and reports the count', async () => {
    store.insertCard({ summary: '甲', content: '内容甲' })
    store.insertCard({ summary: '乙', content: '内容乙' })
    const seen: string[][] = []
    const embedder: Embedder = {
      embed: async (texts) => { seen.push(texts); return texts.map(() => [1, 0, 0]) },
    }
    const consolidator = new Consolidator({
      store,
      llm: { name: 'off', complete: async () => null },
      config: { embedEnabled: true },
      logger: noopLogger,
      embedder,
    })
    const report = await consolidator.run()
    expect(report.embedded).toBe(2)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toHaveLength(2)
    expect(store.cardsWithEmbeddings()).toHaveLength(2)
    expect(store.cardsWithoutEmbeddings(20)).toHaveLength(0)
  })

  it('embedEnabled=false never touches the embedder', async () => {
    store.insertCard({ summary: '甲', content: '内容甲' })
    let called = 0
    const embedder: Embedder = { embed: async () => { called++; return [[1]] } }
    const consolidator = new Consolidator({
      store,
      llm: { name: 'off', complete: async () => null },
      config: { embedEnabled: false },
      logger: noopLogger,
      embedder,
    })
    const report = await consolidator.run()
    expect(report.embedded).toBe(0)
    expect(called).toBe(0)
    expect(store.cardsWithEmbeddings()).toHaveLength(0)
  })

  it('embedder failure is tolerated: report 0, no throw, cards stay pending', async () => {
    store.insertCard({ summary: '甲', content: '内容甲' })
    const embedder: Embedder = { embed: async () => null }
    const consolidator = new Consolidator({
      store,
      llm: { name: 'off', complete: async () => null },
      config: { embedEnabled: true },
      logger: noopLogger,
      embedder,
    })
    const report = await consolidator.run()
    expect(report.embedded).toBe(0)
    expect(store.cardsWithoutEmbeddings(20)).toHaveLength(1)
  })
})

describe('AutoRecall vector refresh', () => {
  it('re-renders the block with the vector channel once the detached query embed lands', async () => {
    const semantic = store.insertCard({ summary: '深度神经网络调参笔记', content: '深度神经网络调参笔记 全文' })
    store.setEmbedding(semantic.id, [1, 0, 0])
    const embedder: Embedder = { embed: async () => [[1, 0, 0]] }
    const autoRecall = new AutoRecall(store, { recallAutoInject: true }, noopLogger, embedder)
    autoRecall.onPreStep([{ content: '今天天气怎么样呢' }])
    // The synchronous first render cannot await the embed: no vector channel yet.
    expect(autoRecall.render()).not.toContain(semantic.id)
    await flush()
    expect(autoRecall.render()).toContain(semantic.id)
  })

  it('embedder failure keeps the bm25-only block and never throws', async () => {
    const keyword = store.insertCard({ summary: '苹果种植技术指南', content: '苹果种植技术指南 全文' })
    const embedder: Embedder = { embed: async () => null }
    const autoRecall = new AutoRecall(store, { recallAutoInject: true }, noopLogger, embedder)
    // 8 chars: exactly at the auto-recall minimum query length, FTS-prefix hit.
    autoRecall.onPreStep([{ content: '苹果种植技术指南' }])
    await flush()
    expect(autoRecall.render()).toContain(keyword.id)
  })
})
