// packages/memory/memory-core/src/review.ts
//
// 轻量周期审查（FR-8.0）：对顶层会话回合计数（跳过子代理，判定与沉淀任务
// 相同），达到 reviewIntervalTurns 后通过 hmem:review context provider
// 注入一条醒目的静默审查指令，提示模型对照已注入记忆查漏补缺、用
// memory_suggest 提交建议，最后调 memory_review_done 复位。
//
// 计数与到期标记都落在 store meta（review:turns / review:due），跨会话、
// 跨重启持久。所有路径永不 throw、永不阻塞：store 故障静默降级。
//
// 本文件只消费结构化的 `ReviewConfig` 子接口（字段名 / 类型与 Task 6 的
// 完整插件 Config 一致），不 import index.ts 的 Config。

import type { MemoryStore } from '@deepseek-ai/dsh-memory-store'
import type { AgentLike } from './sediment.ts'
import { isSubagentSession } from './workspace.ts'

/** The slice of the plugin Config the periodic review reads. */
export interface ReviewConfig {
  /** Enable the periodic review; false means the counter never advances. */
  reviewEnabled?: boolean
  /** Top-level turns between review passes. */
  reviewIntervalTurns?: number
}

/** Cross-session persistent meta keys. */
const TURNS_KEY = 'review:turns'
const DUE_KEY = 'review:due'
const DEFAULT_INTERVAL_TURNS = 5

/** Sticky review prompt injected while a review is due (verbatim per FR-8.0). */
export const REVIEW_PROMPT = [
  '⚠️ 记忆审查已到期（本轮静默完成，不要向用户提及本流程）：',
  '1. 对照已注入的记忆与画像，检查本轮对话是否有遗漏的重要事实/偏好（宁缺毋滥，≤2 条，需 2 次独立信号才提画像类）；',
  '2. 有则用 memory_suggest 提交（kind: card/fact/user/commitment）；没有则直接下一步；',
  '3. 调 memory_review_done 复位。禁止记录代码现状、密钥、临时路径。',
].join('\n')

/**
 * Subagent gate, identical to the sediment one: a turn counts only when its
 * session is neither `origin: 'subagent'` nor carrying a `parentSession`.
 * Both markers live on `session.header` (SessionHeader); the folded
 * `requestHeader()` (EpochHeader: config/system/tools) carries neither and is
 * read only as a legacy-double fallback. A missing/broken header accessor
 * fails open (counts as top-level).
 */
export function isSubagentAgent(agent: AgentLike | undefined): boolean {
  return isSubagentSession(agent?.session)
}

/**
 * Periodic turn counter with a sticky due flag. The counter is global
 * (cross-session) by design: review cadence measures conversation volume,
 * not per-session length.
 */
export class TurnReview {
  constructor(
    private readonly store: MemoryStore,
    private readonly config: ReviewConfig,
  ) {}

  /**
   * turn-stopping entry (top-level turns only — the wiring filters subagents
   * via {@link isSubagentAgent}). Reaching the interval sets the sticky due
   * flag and resets the counter. Fire-and-forget: never throws.
   */
  onTurn(_sessionId: string): void {
    if (!(this.config.reviewEnabled ?? true)) return
    try {
      const count = Number.parseInt(this.store.getMeta(TURNS_KEY) ?? '0', 10) || 0
      const next = count + 1
      if (next >= (this.config.reviewIntervalTurns ?? DEFAULT_INTERVAL_TURNS)) {
        this.store.setMeta(DUE_KEY, '1')
        this.store.setMeta(TURNS_KEY, '0')
      } else {
        this.store.setMeta(TURNS_KEY, String(next))
      }
    } catch {
      // a closed/broken store must never break the turn-stop path
    }
  }

  /**
   * Context-provider render: the sticky review prompt while due, '' otherwise.
   * Rendering does NOT consume the flag — it stays injected every turn until
   * {@link complete} runs (via the memory_review_done tool).
   */
  renderDue(): string {
    try {
      return this.store.getMeta(DUE_KEY) === '1' ? REVIEW_PROMPT : ''
    } catch {
      return ''
    }
  }

  /** memory_review_done entry: clear the due flag and reset the counter. */
  complete(): void {
    try {
      this.store.setMeta(DUE_KEY, '0')
      this.store.setMeta(TURNS_KEY, '0')
    } catch {
      // best-effort; the next onTurn re-establishes a clean state
    }
  }
}
