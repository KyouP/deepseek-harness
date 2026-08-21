/**
 * Explicit-write memory tools: `memory_store` (pinned card or commitment) and
 * `memory_note` (scratchpad jot). Registered inside the memory-core inject
 * scope so they unload with the store service.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryStoreService } from './service.ts'
import type { Embedder } from './llm.ts'
import { embedCard } from './embed.ts'
import { autoLink } from './links.ts'
import { sanitizeForWrite } from './sanitize.ts'
import { sessionWorkspace } from './workspace.ts'

/** One-line summary derivation for explicitly stored memories: first line, capped. */
function summarize(content: string): string {
  const [first = ''] = content.split('\n')
  const line = first.trim()
  return line.length > 60 ? `${line.slice(0, 60)}…` : line
}

/**
 * Register the explicit-write tools: `memory_store` and `memory_note`.
 * @param ctx - inject scope carrying the tool registry.
 * @param service - the memory store service.
 * @param embedder - optional vector backend; stored cards are embedded
 *   detached (failures are silent, consolidation backfills them).
 */
export function registerStoreTools(ctx: Context, service: MemoryStoreService, embedder?: Embedder | null): void {
  ctx.tools.register(defineTool({
    name: 'memory_store',
    description: 'Explicitly remember something, permanently. Use when the user says '
      + '"remember this" / "别忘了". Choose `type` carefully: memory (default) records '
      + 'a fact, preference, event or state about the user or world to recall later; '
      + 'commitment is ONLY for an open promise you made to do something (optionally '
      + 'with ISO `due`) — it stays pinned in context until closed, so never use it '
      + 'just to record what the user told you. Pinned memories never decay. Before '
      + 'storing again, check memory_recall — the store deduplicates identical '
      + 'commitments but repeated memories create noise.',
    parameters: {
      content: { type: 'string', required: true, description: 'What to remember, in one self-contained sentence.' },
      type: { type: 'string', enum: ['memory', 'commitment'], description: 'memory (default) | commitment.' },
      due: { type: 'string', description: 'ISO 8601 deadline; only meaningful for commitments.' },
      pinned: { type: 'boolean', description: 'Pin against decay (default true for explicit stores).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: ['card', 'commitment'] },
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => value.ok
        ? [{ type: 'text', text: `Remembered (${value.kind} ${value.id}).` }]
        : [{ type: 'text', text: `Error: ${value.error ?? 'unknown error'}` }],
    },
    execute(args, exec) {
      // FR-3.6 write hygiene gate — same as every other write path (sediment
      // routing, suggestion-approve, human recompile). One gate covers both
      // arms: commitment text lands in the store too.
      const verdict = sanitizeForWrite(args.content)
      if (!verdict.ok) {
        return Promise.resolve({ ok: false as const, error: `content rejected by write hygiene (${verdict.reason})` })
      }
      if (args.type === 'commitment') {
        const c = service.store.addCommitment({ content: verdict.text, dueAt: args.due ?? null })
        return Promise.resolve({ id: c.id, kind: 'commitment' as const, ok: true as const })
      }
      const card = service.store.insertCard({
        summary: summarize(verdict.text),
        content: verdict.text,
        pinned: args.pinned ?? true,
        salience: 1,
        sessionId: exec.agent ? String(exec.agent.session.id) : null,
        // FR-2.9 打标：仅 cards 打 workspace；cwd 未知时 null（全局卡，不罚分）。
        workspace: sessionWorkspace(exec.agent?.session),
      })
      // FR-4.1 写侧向量：detached，失败静默（NFR-2.2），巩固任务 ⑦ 回填。
      embedCard(service.store, embedder, card)
      // FR-2.4 入库后自动建链：本地关键词共现，失败容忍，绝不打断写路径。
      autoLink(service.store, card.id, verdict.text)
      return Promise.resolve({ id: card.id, kind: 'card' as const, ok: true as const })
    },
    presentCall: args => ({ card: 'generic', title: 'Store memory', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_note',
    description: 'Jot a short working note for this session (scratchpad). For transient '
      + 'inferences and hypotheses, NOT facts — use memory_store for anything that '
      + 'should survive the session. Notes are reviewed during sleep consolidation.',
    parameters: {
      text: { type: 'string', required: true, description: 'The note, one short line.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { noted: { type: 'boolean', required: true } },
      },
      render: () => [{ type: 'text', text: 'Noted.' }],
    },
    execute(args, exec) {
      service.store.addNote(exec.agent ? String(exec.agent.session.id) : null, args.text)
      return Promise.resolve({ noted: true })
    },
    presentCall: args => ({ card: 'generic', title: 'Add note', kind: 'other', rawInput: args }),
  }))
}
