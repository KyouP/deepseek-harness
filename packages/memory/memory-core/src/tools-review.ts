/**
 * Periodic-review tools (FR-8.0): `memory_suggest` queues one memory
 * suggestion for review (deduped by kind+content into a hit count), and
 * `memory_review_done` resets the review cycle. Registered inside the
 * memory-core inject scope so they unload with the store service.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryStoreService } from './service.ts'
import type { TurnReview } from './review.ts'

/**
 * Register the review tools: `memory_suggest` and `memory_review_done`.
 * @param ctx - inject scope carrying the tool registry.
 * @param service - the memory store service.
 * @param review - the periodic review state to reset on completion.
 */
export function registerReviewTools(ctx: Context, service: MemoryStoreService, review: TurnReview): void {
  ctx.tools.register(defineTool({
    name: 'memory_suggest',
    description: 'Propose one memory suggestion during a periodic memory review. The '
      + 'suggestion is queued for approval — it does NOT take effect immediately. '
      + 'Repeating the same kind+content merges into the existing suggestion and '
      + 'bumps its hit count, which strengthens the case for approval. Submit at '
      + 'most the few highest-value items; user-profile (kind: user) suggestions '
      + 'require two independent signals.',
    parameters: {
      kind: {
        type: 'string', required: true,
        enum: ['card', 'fact', 'commitment', 'user'],
        description: 'card: event/preference/state; fact: stable subject-attribute fact; '
          + 'commitment: an open promise; user: user-profile increment.',
      },
      content: { type: 'string', required: true, description: 'The suggestion, one self-contained sentence.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          suggestionId: { type: 'string', required: true },
          hits: { type: 'number', required: true },
          status: { type: 'string', required: true, enum: ['pending', 'approved', 'rejected'] },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Suggestion queued (${value.suggestionId}, hits ${value.hits}, ${value.status}).`,
      }],
    },
    execute(args) {
      const { suggestion } = service.store.addSuggestion({ kind: args.kind, content: args.content })
      return Promise.resolve({ suggestionId: suggestion.id, hits: suggestion.hits, status: suggestion.status })
    },
    presentCall: args => ({ card: 'generic', title: 'Suggest memory', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_review_done',
    description: 'Mark the periodic memory review complete. Call exactly once per review '
      + 'cycle, after submitting any memory_suggest items (or deciding there is nothing '
      + 'worth suggesting). This clears the sticky review prompt and restarts the turn '
      + 'counter.',
    parameters: {},
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: { done: { type: 'boolean', required: true } },
      },
      render: () => [{ type: 'text', text: 'Memory review complete.' }],
    },
    execute() {
      review.complete()
      return Promise.resolve({ done: true })
    },
    presentCall: () => ({ card: 'generic', title: 'Finish memory review', kind: 'other', rawInput: {} }),
  }))
}
