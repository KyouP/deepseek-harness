/**
 * Explicit-write memory tools: `memory_store` (pinned card or commitment) and
 * `memory_note` (scratchpad jot). Registered inside the memory-core inject
 * scope so they unload with the store service.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryStoreService } from './service.ts'

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
 */
export function registerStoreTools(ctx: Context, service: MemoryStoreService): void {
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
          id: { type: 'string', required: true },
          kind: { type: 'string', required: true, enum: ['card', 'commitment'] },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Remembered (${value.kind} ${value.id}).` }],
    },
    execute(args, exec) {
      if (args.type === 'commitment') {
        const c = service.store.addCommitment({ content: args.content, dueAt: args.due ?? null })
        return Promise.resolve({ id: c.id, kind: 'commitment' as const })
      }
      const card = service.store.insertCard({
        summary: summarize(args.content),
        content: args.content,
        pinned: args.pinned ?? true,
        salience: 1,
        sessionId: exec.agent ? String(exec.agent.session.id) : null,
      })
      return Promise.resolve({ id: card.id, kind: 'card' as const })
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
