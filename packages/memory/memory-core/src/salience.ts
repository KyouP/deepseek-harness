// packages/memory/memory-core/src/salience.ts
//
// 显著性公式与三档写入门控（FR-3.1 / FR-3.2）：每条候选 CARD 在入库前按
//   s = 0.3·emotion + 0.3·novelty + 0.2·repeat + 0.2·explicit
// 打分，再按阈值分流：
//   s < 0.3  → drop（丢弃，不落任何存储）
//   s < 0.7  → scratchpad（addNote 便签，留给冷路径蒸馏）
//   s ≥ 0.7  → store（insertCard，salience=s，strength=1+0.5·s）
// 输入信号：
//   emotion  —— 提炼器在 [CARD][emo:0.0-1.0] 标记里自评的情绪强度，缺省 0.5；
//   novelty  —— 1/(1 + searchCardsFts(内容首20字, 3).length)，查询失败按全新 1；
//   repeat   —— 同内容 suggestion 的 hits 归一 min(1, hits/3)，查询失败按 0；
//   explicit —— memory_store 直写路径恒 1（直接 store 档），沉淀提取恒 0。

import type { MemoryStore } from '@deepseek-ai/dsh-memory-store'

export interface SalienceInput {
  emotion: number
  novelty: number
  repeat: number
  explicit: number
} // 各项 0..1（越界按 clamp01 收敛）

export function salienceScore(i: SalienceInput): number {
  return 0.3 * clamp01(i.emotion) + 0.3 * clamp01(i.novelty)
    + 0.2 * clamp01(i.repeat) + 0.2 * clamp01(i.explicit)
}

export type SalienceTier = 'drop' | 'scratchpad' | 'store'

export function salienceTier(s: number): SalienceTier {
  if (s < 0.3) return 'drop'
  if (s < 0.7) return 'scratchpad'
  return 'store'
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** novelty = 1/(1+前20字 FTS 命中数)；FTS 语法异常等失败按全新（1）处理。 */
export function cardNovelty(store: MemoryStore, content: string): number {
  try {
    return 1 / (1 + store.searchCardsFts(content.slice(0, 20), 3).length)
  } catch {
    return 1
  }
}

/** repeat = 同内容 suggestion hits 归一 min(1, hits/3)；查询失败按 0。 */
export function cardRepeat(store: MemoryStore, content: string): number {
  try {
    const match = store.listSuggestions().find(suggestion => suggestion.content === content)
    return match ? Math.min(1, match.hits / 3) : 0
  } catch {
    return 0
  }
}
