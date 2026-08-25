/**
 * Commitment-closure and pinning tools: `memory_close_commitment`,
 * `memory_pin` and `memory_unpin`. Registered inside the mem-enhance inject
 * scope so they unload with the store service.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryStore } from './store/index.ts'
import type { MemoryStoreService } from './service.ts'

/**
 * Resolve a commitment id or unique id prefix against the ACTIVE commitments
 * (closing already-closed ones is an error either way). The injected
 * commitment list shows 8-char prefixes, so the model quotes prefixes, not
 * full uuids. Throws on no match or an ambiguous prefix.
 */
function resolveCommitmentId(store: MemoryStore, input: string): string {
  const actives = store.activeCommitments()
  if (actives.some(c => c.id === input)) return input
  const matches = actives.filter(c => c.id.startsWith(input))
  const [only] = matches
  if (matches.length === 1 && only !== undefined) return only.id
  if (matches.length > 1) {
    throw new Error(`id prefix "${input}" matches ${matches.length} active commitments; use a longer prefix`)
  }
  throw new Error(`no active commitment with id ${input}`)
}

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
      + 'unknown commitment is an error. The injected commitment list shows each id\'s '
      + '8-char prefix in [brackets] — quoting the prefix is enough.',
    parameters: {
      id: { type: 'string', required: true, description: 'The commitment id or its unique prefix (as shown in [brackets] in the injected list).' },
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
      const id = resolveCommitmentId(service.store, args.id)
      service.store.closeCommitment(id, status)
      return Promise.resolve({ closed: true, id, status })
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
