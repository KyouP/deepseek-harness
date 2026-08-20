/**
 * Automatic per-turn recall injection (FR-4.8): listens on `agent/pre-step`,
 * re-queries only when the latest user text changed, and renders a
 * budget-capped recall block through the `hmem:recall` context provider
 * (NFR-3.2/3.3: unchanged turns replay the cached block byte-for-byte and
 * never touch the database; failures degrade to no injection).
 *
 * NFR-1.3 note: the refresh is a synchronous local SQLite query (no LLM), so
 * it sits comfortably inside the "one parallel hybrid recall" hot-path budget
 * — p95 300ms leaves orders of magnitude of headroom.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MemoryStore } from '@deepseek-ai/dsh-memory-store'
import { truncateChars } from './budget.ts'
import { rankedRecall, type RankedHit } from './recall.ts'

/** Block header; names memory_expand so the model can pull the full text. */
export const RECALL_BLOCK_HEADER = '【可能相关的记忆（memory_expand 看全文）】'

/** Texts shorter than this (greetings, acknowledgements) never trigger a query. */
const MIN_QUERY_CHARS = 8
/** Row cap for the automatic recall channel. */
const AUTO_RECALL_LIMIT = 5
/** Fallbacks mirroring the plugin Config schema defaults. */
const DEFAULT_BUDGET_CHARS = 1800
const DEFAULT_FLOOR = 0.05

/** The slice of the plugin Config the auto-recall channel reads. */
export interface AutoRecallConfig {
  /** Master switch; when false, onPreStep is a no-op and render() is ''. */
  recallAutoInject?: boolean
  /** Char budget for the rendered recall block. */
  recallBudgetChars?: number
  /** Minimum relevance score forwarded to {@link rankedRecall}. */
  recallRelevanceFloor?: number
}

/** Minimal warn sink; defaults to silent so the class is usable stand-alone. */
export interface AutoRecallLogger {
  warn(message: string): void
}

const NOOP_LOGGER: AutoRecallLogger = { warn: () => {} }

/**
 * Extract the user text from one message's content: a plain string, or the
 * concatenation of its `type: 'text'` blocks (reasoning/image/etc. blocks
 * carry no query signal and are skipped).
 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object') {
      const b = block as { type?: unknown, text?: unknown }
      if (b.type === 'text' && typeof b.text === 'string') text += b.text
    }
  }
  return text
}

/** Render the recall block: header line plus one `- [id] summary` per hit. */
function renderRecallBlock(hits: RankedHit[], budgetChars: number): string {
  if (hits.length === 0) return ''
  const lines = hits.map(h => `- [${h.id}] ${h.summary}`)
  return truncateChars(`${RECALL_BLOCK_HEADER}\n${lines.join('\n')}`, budgetChars)
}

/**
 * Per-turn auto-recall state: the last queried user text and the block it
 * rendered to. Deduping on the query bytes means an unchanged turn (every
 * tool-call step of a long turn reuses the same user text) costs zero
 * database reads.
 */
export class AutoRecall {
  private readonly enabled: boolean
  private readonly budgetChars: number
  private readonly floor: number
  private lastQuery: string | null = null
  private lastBlock = ''

  constructor(
    private readonly store: MemoryStore,
    config: AutoRecallConfig,
    private readonly logger: AutoRecallLogger = NOOP_LOGGER,
  ) {
    this.enabled = config.recallAutoInject ?? true
    this.budgetChars = config.recallBudgetChars ?? DEFAULT_BUDGET_CHARS
    this.floor = config.recallRelevanceFloor ?? DEFAULT_FLOOR
  }

  /**
   * Pre-step entry: refresh the recall block from the latest user text when
   * it changed. Synchronous — a local SQLite ranked recall, no LLM. A store
   * fault degrades to an empty block and one warn per failure; it never
   * throws into the pre-step waterfall.
   */
  onPreStep(messages: { content: unknown }[]): void {
    if (!this.enabled) return
    const text = textOf(messages.at(-1)?.content).trim()
    if (text.length < MIN_QUERY_CHARS || text === this.lastQuery) return
    // Cache the query even when the recall fails: an unchanged text must not
    // retry (and re-log) the same fault on every step of the turn.
    this.lastQuery = text
    let hits: RankedHit[]
    try {
      hits = rankedRecall(this.store, text, { limit: AUTO_RECALL_LIMIT, floor: this.floor })
    } catch (error) {
      this.lastBlock = ''
      this.logger.warn(`memory-core: auto recall failed: ${String(error)}`)
      return
    }
    this.lastBlock = renderRecallBlock(hits, this.budgetChars)
  }

  /** Context-provider render: the cached budgeted block, or '' when idle/off. */
  render(): string {
    return this.enabled ? this.lastBlock : ''
  }
}

/**
 * Mount the auto-recall channel: the `agent/pre-step` waterfall listener that
 * refreshes the block, and the `hmem:recall` context provider (order 15,
 * between commitments at 10 and the scratchpad at 20) that renders it.
 * @param ctx - inject scope carrying the system prompt service.
 * @param store - the memory store.
 * @param config - plugin configuration (recallAutoInject gates both halves).
 */
export function mountAutoRecall(ctx: Context, store: MemoryStore, config: AutoRecallConfig): void {
  const autoRecall = new AutoRecall(store, config, {
    warn: (message) => { ctx.logger.warn(message) },
  })
  // This package does not depend on @deepseek-ai/dsh-agent, so the event is
  // not in the local Events augmentation (same pattern as the sediment hook).
  const events = ctx as unknown as {
    on(event: 'agent/pre-step', listener: (payload: { messages?: { content: unknown }[] }, next: () => unknown) => unknown): void
  }
  events.on('agent/pre-step', (payload, next) => {
    // Waterfall semantics: the return value must always be next()'s — a
    // recall fault must never veto or rewrite the step.
    try {
      autoRecall.onPreStep(payload.messages ?? [])
    } catch {
      // AutoRecall already swallows store faults; this guards everything else.
    }
    return next()
  })
  ctx.systemPrompt.context({ name: 'hmem:recall', order: 15, text: () => autoRecall.render() })
}
