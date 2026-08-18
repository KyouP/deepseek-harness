/**
 * Read-path memory tools: `memory_recall` (v1: FTS5 single-channel),
 * `memory_expand` and `memory_forget`. Registered inside the memory-core
 * inject scope so they unload with the store service.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryStoreService } from './service.ts'

/**
 * Register the read-path tools: `memory_recall`, `memory_expand`, `memory_forget`.
 * @param ctx - inject scope carrying the tool registry.
 * @param service - the memory store service.
 */
export function registerRecallTools(ctx: Context, service: MemoryStoreService): void {
  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: 'Search your long-term memory. Returns one-line summaries; call '
      + 'memory_expand(id) for the full text of any hit. Low-confidence entries are '
      + 'marked [不确定] — treat them as hints, not facts.',
    parameters: {
      query: { type: 'string', required: true, description: 'Keywords describing what you are trying to remember.' },
      limit: { type: 'integer', description: 'Max results (default 10).' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          results: {
            type: 'array', required: true,
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                summary: { type: 'string', required: true },
                uncertain: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.results.length === 0
          ? 'No memories found.'
          : value.results.map(r => `- [${r.id}] ${r.uncertain ? '[不确定] ' : ''}${r.summary}`).join('\n'),
      }],
    },
    execute(args) {
      const hits = service.store.searchCardsFts(args.query, args.limit ?? 10)
      return Promise.resolve({
        results: hits.map(h => ({ id: h.id, summary: h.summary, uncertain: false })),
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Recall memory', kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_expand',
    description: 'Expand one memory to its full text, using an id from memory_recall.',
    parameters: {
      id: { type: 'string', required: true, description: 'The memory id.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          content: { type: 'string', required: true },
          contextDesc: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          emotion: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
          recordedAt: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.content }],
    },
    execute(args) {
      const card = service.store.getCard(args.id)
      if (!card) throw new Error(`no memory with id ${args.id}`)
      return Promise.resolve({
        id: card.id, content: card.content,
        contextDesc: card.contextDesc, emotion: card.emotion, recordedAt: card.recordedAt,
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Expand memory', kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_forget',
    description: 'Precisely and permanently forget one memory: deletes the card, every '
      + 'fact derived from it, and its links, immediately. Use when the user asks you '
      + 'to forget something. This cannot be undone.',
    parameters: {
      id: { type: 'string', required: true, description: 'The memory id to erase.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          cards: { type: 'integer', required: true },
          facts: { type: 'integer', required: true },
          links: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Forgot: ${value.cards} card(s), ${value.facts} derived fact(s), ${value.links} link(s).`,
      }],
    },
    execute(args) {
      const report = service.store.forgetCard(args.id)
      if (report.cards === 0) throw new Error(`no memory with id ${args.id}`)
      return Promise.resolve(report)
    },
    presentCall: args => ({ card: 'generic', title: 'Forget memory', kind: 'other', rawInput: args }),
  }))
}
