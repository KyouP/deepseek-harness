/**
 * Dynamic prompt context providers: the active-commitment block (P0 channel)
 * and the recent scratchpad notes. Both render empty when idle so the
 * assembled snapshot stays clean.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MemoryStore } from '@deepseek-ai/dsh-memory-store'
import type { MemoryStoreService } from './service.ts'
import { truncateChars } from './budget.ts'
import { sanitizeForInjection } from './sanitize.ts'

/** Default hard cap on injected commitment rows — P0 but not unbounded. */
const DEFAULT_COMMITMENT_ROW_CAP = 20
/** Default char budget for the scratchpad context block. */
const DEFAULT_SCRATCHPAD_BUDGET_CHARS = 1200
/** Scratchpad notes younger than this are injected. */
const SCRATCHPAD_WINDOW_MS = 24 * 60 * 60 * 1000

/** Injection budgets/limits resolved from the plugin Config. */
export interface InjectionConfig {
  /** Row cap for the commitments block (P0 channel — rows, not chars). */
  commitmentRowCap: number
  /** Char budget for the scratchpad block. */
  scratchpadBudgetChars: number
}

/**
 * Render the active-commitment context block: overdue items first with an
 * explicit 到期 marker so the persona raises them unprompted. Empty when idle.
 * @param store - the memory store.
 * @param rowCap - maximum number of commitment rows injected.
 * @returns context text, or ''.
 */
export function buildCommitmentsText(store: MemoryStore, rowCap = DEFAULT_COMMITMENT_ROW_CAP): string {
  const now = new Date().toISOString()
  const due = store.dueCommitments(now)
  const active = store.activeCommitments().filter(c => c.dueAt === null || c.dueAt > now)
  const rows = [...due, ...active].slice(0, rowCap)
  if (rows.length === 0) return ''
  const lines = rows.map((c) => {
    const overdue = c.dueAt !== null && c.dueAt <= now
    return `- ${overdue ? '【到期，请主动提起】' : ''}${c.content}${c.dueAt ? `（期限 ${c.dueAt}）` : ''}`
  })
  return `你承诺过的事（务必逐条闭环；到期项要主动提起）：\n${lines.join('\n')}`
}

/**
 * Render recent scratchpad notes. Empty when none in the window.
 * @param store - the memory store.
 * @returns context text, or ''.
 */
export function buildScratchpadText(store: MemoryStore): string {
  const since = new Date(Date.now() - SCRATCHPAD_WINDOW_MS).toISOString()
  const notes = store.recentNotes(since)
  if (notes.length === 0) return ''
  return `会话便签（临时推断，非事实）：\n${notes.map(n => `- ${n.text}`).join('\n')}`
}

/**
 * Mount the two dynamic context providers. Each provider guards its SQLite
 * reads: a store fault (e.g. a closed or corrupted database) must not reject
 * prompt assembly, so on error it logs once per failure and renders empty —
 * the persona stays online without the memory block. Both blocks are
 * sanitized before injection; the scratchpad is additionally truncated to its
 * char budget while commitments stay row-capped only (P0 channel).
 * @param ctx - inject scope carrying the system prompt service.
 * @param service - the memory store service.
 * @param config - injection budgets and limits (defaults applied).
 */
export function mountInjections(ctx: Context, service: MemoryStoreService, config: Partial<InjectionConfig> = {}): void {
  const rowCap = config.commitmentRowCap ?? DEFAULT_COMMITMENT_ROW_CAP
  const scratchpadBudget = config.scratchpadBudgetChars ?? DEFAULT_SCRATCHPAD_BUDGET_CHARS
  ctx.systemPrompt.context({
    name: 'hmem:commitments',
    order: 10,
    text: () => {
      try {
        return sanitizeForInjection(buildCommitmentsText(service.store, rowCap))
      } catch (error) {
        ctx.logger.warn(`memory-core: commitments injection failed: ${String(error)}`)
        return ''
      }
    },
  })
  ctx.systemPrompt.context({
    name: 'hmem:scratchpad',
    order: 20,
    text: () => {
      try {
        return truncateChars(sanitizeForInjection(buildScratchpadText(service.store)), scratchpadBudget)
      } catch (error) {
        ctx.logger.warn(`memory-core: scratchpad injection failed: ${String(error)}`)
        return ''
      }
    },
  })
}
