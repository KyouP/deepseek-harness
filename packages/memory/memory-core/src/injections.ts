/**
 * Dynamic prompt context providers: the active-commitment block (P0 channel)
 * and the recent scratchpad notes. Both render empty when idle so the
 * assembled snapshot stays clean.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MemoryStore } from '@deepseek-ai/dsh-memory-store'
import type { MemoryStoreService } from './service.ts'

/** Hard cap on injected commitment rows — the channel is P0 but not unbounded. */
const COMMITMENT_ROW_CAP = 20
/** Scratchpad notes younger than this are injected. */
const SCRATCHPAD_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Render the active-commitment context block: overdue items first with an
 * explicit 到期 marker so the persona raises them unprompted. Empty when idle.
 * @param store - the memory store.
 * @returns context text, or ''.
 */
export function buildCommitmentsText(store: MemoryStore): string {
  const now = new Date().toISOString()
  const due = store.dueCommitments(now)
  const active = store.activeCommitments().filter(c => c.dueAt === null || c.dueAt > now)
  const rows = [...due, ...active].slice(0, COMMITMENT_ROW_CAP)
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
 * Mount the two dynamic context providers.
 * @param ctx - inject scope carrying the system prompt service.
 * @param service - the memory store service.
 */
export function mountInjections(ctx: Context, service: MemoryStoreService): void {
  ctx.systemPrompt.context({
    name: 'hmem:commitments',
    order: 10,
    text: () => buildCommitmentsText(service.store),
  })
  ctx.systemPrompt.context({
    name: 'hmem:scratchpad',
    order: 20,
    text: () => buildScratchpadText(service.store),
  })
}
