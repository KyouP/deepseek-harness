/**
 * Commitment-closure and pinning tools: `memory_close_commitment`,
 * `memory_pin` and `memory_unpin`. Registered inside the memory-core inject
 * scope so they unload with the store service.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryStoreService } from './service.ts'

/**
 * Register the commitment/pin tools: `memory_close_commitment`, `memory_pin`,
 * `memory_unpin`.
 * @param ctx - inject scope carrying the tool registry.
 * @param service - the memory store service.
 */
export function registerCommitmentTools(ctx: Context, service: MemoryStoreService): void {
  ctx.tools.register(defineTool({
    name: 'memory_close_commitment',
    description: 'Close one open commitment you previously recorded with memory_store '
      + '(type: commitment). Call ONLY when the user confirmed the promise is fulfilled '
      + 'or when it is cancelled — never close on your own guess. Closed commitments '
      + 'stop appearing in the injected commitment list. Closing an already-closed or '
      + 'unknown commitment is an error.',
    parameters: {
      id: { type: 'string', required: true, description: 'The commitment id.' },
      status: {
        type: 'string', enum: ['done', 'cancelled'],
        description: 'done (default) when fulfilled, cancelled when dropped.',
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          closed: { type: 'boolean', required: true },
          id: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['done', 'cancelled'] },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Closed commitment ${value.id} (${value.status}).`,
      }],
    },
    execute(args) {
      const status = args.status ?? 'done'
      service.store.closeCommitment(args.id, status)
      return Promise.resolve({ closed: true, id: args.id, status })
    },
    presentCall: args => ({ card: 'generic', title: 'Close commitment', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_pin',
    description: 'Pin one memory so it never decays or gets archived by forgetting, '
      + 'and ranks higher in recall. Use for durable facts the user clearly cares '
      + 'about; memory_store already pins explicit "remember this" stores.',
    parameters: {
      id: { type: 'string', required: true, description: 'The memory id to pin.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          pinned: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Pinned memory ${value.id}.` }],
    },
    execute(args) {
      if (!service.store.getCard(args.id)) throw new Error(`no memory with id ${args.id}`)
      service.store.setCardPinned(args.id, true)
      return Promise.resolve({ id: args.id, pinned: true })
    },
    presentCall: args => ({ card: 'generic', title: 'Pin memory', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_unpin',
    description: 'Unpin one pinned memory, letting it decay and archive normally again. '
      + 'Use when the user says something is no longer important enough to keep pinned.',
    parameters: {
      id: { type: 'string', required: true, description: 'The memory id to unpin.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          pinned: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Unpinned memory ${value.id}.` }],
    },
    execute(args) {
      if (!service.store.getCard(args.id)) throw new Error(`no memory with id ${args.id}`)
      service.store.setCardPinned(args.id, false)
      return Promise.resolve({ id: args.id, pinned: false })
    },
    presentCall: args => ({ card: 'generic', title: 'Unpin memory', kind: 'other', rawInput: args }),
  }))
}
