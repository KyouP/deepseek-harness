// packages/memory/memory-core/src/embed.ts
//
// 向量召回通道的共享工具（FR-4.1）：cosine 相似度、RRF 名次融合、写入侧的
// detached 卡片 embedding。NFR-2.2 降级纪律贯穿全文件：embedder 缺失或失败
// 永远静默，绝不 throw、绝不阻塞热路径；写侧失败由巩固任务 ⑦（consolidate）
// 用 cardsWithoutEmbeddings(20) 回填兜底。

import type { MemoryStore } from '@deepseek-ai/dsh-memory-store'
import type { Embedder } from './llm.ts'

/**
 * Cosine similarity of two equal-length vectors. Zero-norm or mismatched
 * vectors score 0 (never NaN) so a malformed stored blob degrades quietly.
 */
export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Reciprocal-rank fusion: each channel contributes 1/(k+rank) per entry
 * (rank is 1-based within the channel), summed per id. k defaults to 60.
 * Returns a map id → merged RRF score.
 */
export function rrfMerge(channels: { id: string }[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>()
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i++) {
      const id = channel[i]!.id
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1))
    }
  }
  return scores
}

/**
 * 写入侧 embedding：入库成功后异步 detached（queueMicrotask + catch），失败
 * 静默 —— 下一轮巩固任务的 ⑦ 回填会捡起没有 embedding 的卡。embedder 为
 * null（embedEnabled 关闭）时是纯 no-op。
 */
export function embedCard(
  store: MemoryStore,
  embedder: Embedder | null | undefined,
  card: { id: string, summary: string, content: string },
): void {
  if (!embedder) return
  const text = `${card.summary}\n${card.content}`
  queueMicrotask(() => {
    void embedder.embed([text])
      .then((vectors) => {
        const vector = vectors?.[0]
        if (!vector || vector.length === 0) return
        try {
          store.setEmbedding(card.id, vector)
        } catch {
          // store may already be closed during shutdown; the backfill step
          // in consolidation will retry the card on the next run.
        }
      })
      .catch(() => {
        // silent by design (NFR-2.2): consolidation backfills missing embeddings
      })
  })
}
