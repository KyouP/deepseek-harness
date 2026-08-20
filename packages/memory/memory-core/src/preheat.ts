/**
 * Session preheat injection (FR-9.1): when a session starts it is marked, and
 * its FIRST context render emits a one-time warmup block with up to three
 * optional sections — commitments overdue or due within 48h, recent topics,
 * and "on this day" anniversaries. The block is sanitized, budgeted with
 * `preheatBudgetChars`, and consumed on render so later renders of the same
 * session are empty; an entirely empty preheat renders ''.
 *
 * The context provider cannot read the active session id without injecting
 * the agent service, so Preheat keeps an in-memory set of marked session ids:
 * the provider renders (and consumes) the most recently marked id, which is
 * the active session because context assembly runs synchronously after
 * session-start. Concurrent sessions each get their own one-shot preheat.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MemoryStore } from '@deepseek-ai/dsh-memory-store'
import { truncateChars } from './budget.ts'
import { sanitizeForInjection } from './sanitize.ts'

/** Commitments due within this many hours join the overdue ones. */
const DUE_SOON_WITHIN_HOURS = 48
/** Row caps for the two card-based sections. */
const RECENT_TOPIC_LIMIT = 5
const ANNIVERSARY_LIMIT = 5
/** Fallback mirroring the plugin Config schema default. */
const DEFAULT_PREHEAT_BUDGET_CHARS = 800

/** The slice of the plugin Config the preheat channel reads. */
export interface PreheatConfig {
  /** Char budget for the rendered preheat block. */
  preheatBudgetChars?: number
}

/** Minimal warn sink; defaults to silent so the class is usable stand-alone. */
export interface PreheatLogger {
  warn(message: string): void
}

const NOOP_LOGGER: PreheatLogger = { warn: () => {} }

/**
 * One-shot session warmup block. Marking is idempotent per session id;
 * rendering consumes exactly one mark.
 */
export class Preheat {
  private readonly budgetChars: number
  /** Marked session ids, in mark order (re-marks move to the back). */
  private readonly marked = new Set<string>()

  constructor(
    private readonly store: MemoryStore,
    config: PreheatConfig,
    private readonly logger: PreheatLogger = NOOP_LOGGER,
  ) {
    this.budgetChars = config.preheatBudgetChars ?? DEFAULT_PREHEAT_BUDGET_CHARS
  }

  /** session-start entry: flag this session for a one-time preheat. */
  markSession(sessionId: string): void {
    this.marked.delete(sessionId)
    this.marked.add(sessionId)
  }

  /**
   * Context-provider render. With a `sessionId`, renders only when that exact
   * session is marked; with null, renders the most recently marked session
   * (the active one — assembly runs right after session-start). Either way
   * the mark is consumed, so a session preheats at most once. Empty preheat
   * content (or a store fault) renders ''.
   */
  render(sessionId: string | null = null): string {
    if (this.consume(sessionId) === null) return ''
    try {
      return truncateChars(sanitizeForInjection(this.buildBlock()), this.budgetChars)
    } catch (error) {
      this.logger.warn(`memory-core: preheat injection failed: ${String(error)}`)
      return ''
    }
  }

  /** Remove one mark and return its session id; null when nothing applies. */
  private consume(sessionId: string | null): string | null {
    if (sessionId !== null) return this.marked.delete(sessionId) ? sessionId : null
    let last: string | null = null
    for (const id of this.marked) last = id
    if (last !== null) this.marked.delete(last)
    return last
  }

  /**
   * Assemble the three optional sections; '' when all are empty. Anniversary
   * year math reads the ISO year prefixes (zero-padded strings) directly.
   */
  private buildBlock(): string {
    const now = new Date().toISOString()
    const sections: string[] = []

    const overdue = this.store.dueCommitments(now)
    const dueSoon = this.store.dueSoonCommitments(now, DUE_SOON_WITHIN_HOURS)
    if (overdue.length + dueSoon.length > 0) {
      const lines = [
        ...overdue.map(c => `- 【已到期】${c.content}${c.dueAt ? `（期限 ${c.dueAt}）` : ''}`),
        ...dueSoon.map(c => `- ${c.content}${c.dueAt ? `（期限 ${c.dueAt}）` : ''}`),
      ]
      sections.push(`临期/到期承诺（进入会话时主动提起）：\n${lines.join('\n')}`)
    }

    const topics = this.store.recentCards(RECENT_TOPIC_LIMIT)
    if (topics.length > 0) {
      sections.push(`最近的话题：\n${topics.map(c => `- ${c.summary}`).join('\n')}`)
    }

    const anniversaries = this.store.anniversaryCards(now, ANNIVERSARY_LIMIT)
    if (anniversaries.length > 0) {
      const currentYear = Number(now.slice(0, 4))
      const lines = anniversaries.map((c) => {
        const years = Math.max(1, currentYear - Number(c.recordedAt.slice(0, 4)))
        return `- ${years} 年前的今天：${c.summary}`
      })
      sections.push(`纪念日：\n${lines.join('\n')}`)
    }

    return sections.join('\n\n')
  }
}

/**
 * Mount the preheat channel: an `agent/session-start` listener that marks the
 * starting session, and the `hmem:preheat` context provider (order 12,
 * between commitments at 10 and the recall block at 15) that renders the
 * one-shot block for the most recently marked session.
 * @param ctx - inject scope carrying the system prompt service.
 * @param store - the memory store.
 * @param config - plugin configuration (preheatBudgetChars caps the block).
 */
export function mountPreheat(ctx: Context, store: MemoryStore, config: PreheatConfig): void {
  const preheat = new Preheat(store, config, {
    warn: (message) => { ctx.logger.warn(message) },
  })
  // This package does not depend on @deepseek-ai/dsh-agent, so the event is
  // not in the local Events augmentation (same pattern as the sediment hook).
  // session-start is a plain emit — no veto — so the listener just marks.
  const events = ctx as unknown as {
    on(event: 'agent/session-start', listener: (payload: { agent?: { session?: { id?: unknown } } }) => void): void
  }
  events.on('agent/session-start', (payload) => {
    const id = payload?.agent?.session?.id
    if (id !== undefined && id !== null) preheat.markSession(String(id))
  })
  ctx.systemPrompt.context({ name: 'hmem:preheat', order: 12, text: () => preheat.render(null) })
}
