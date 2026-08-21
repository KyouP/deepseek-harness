/**
 * Suggestion-queue approval tools (FR-3.8): `memory_suggestions` lists the
 * pending queue and approves or rejects entries by id. Approval is an
 * explicit user action, so landing bypasses the salience gate: card →
 * insertCard (+ detached embed + autoLink, same as memory_store), fact →
 * split `主体 | 属性 | 值` into an insertFact triple, commitment →
 * addCommitment, user → only marked approved (consolidation ④ merges it into
 * the human block later). Registered inside the memory-core inject scope so
 * it unloads with the store service.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryStoreService } from './service.ts'
import type { Embedder } from './llm.ts'
import type { Suggestion } from '@deepseek-ai/dsh-memory-store'
import { embedCard } from './embed.ts'
import { autoLink } from './links.ts'
import { sanitizeForWrite } from './sanitize.ts'

/** Same first-line derivation memory_store uses for explicitly stored cards. */
function summarize(content: string): string {
  const [first = ''] = content.split('\n')
  const line = first.trim()
  return line.length > 60 ? `${line.slice(0, 60)}…` : line
}

interface SuggestionListItem {
  id: string
  kind: Suggestion['kind']
  content: string
  hits: number
  firstSeen: string
}

interface SuggestionsResult {
  action: 'list' | 'approve' | 'reject'
  ok: boolean
  error?: string
  suggestions?: SuggestionListItem[]
  id?: string
  /** What an approve landed as; null for kind=user (merged at consolidation). */
  landedKind?: 'card' | 'fact' | 'commitment' | null
  landedId?: string
}

function failure(action: SuggestionsResult['action'], error: string): SuggestionsResult {
  return { action, ok: false, error }
}

/**
 * Register the suggestion-queue tool: `memory_suggestions`.
 * @param ctx - inject scope carrying the tool registry.
 * @param service - the memory store service.
 * @param embedder - optional vector backend; approved cards are embedded
 *   detached (failures are silent, consolidation backfills them).
 */
export function registerSuggestionTools(
  ctx: Context,
  service: MemoryStoreService,
  embedder?: Embedder | null,
): void {
  ctx.tools.register(defineTool({
    name: 'memory_suggestions',
    description: 'Review the memory suggestion queue. action=list shows pending '
      + 'suggestions (id, kind, content, hits — most-hit first, at most 20). '
      + 'action=approve lands one suggestion permanently by kind: card → pinned '
      + 'memory card, fact → fact triple (content must be "主体 | 属性 | 值"), '
      + 'commitment → open commitment, user → queued for the human profile block '
      + '(merged during sleep consolidation, not immediately). action=reject '
      + 'discards it. approve/reject require id; only act on explicit user '
      + 'confirmation, and only on pending entries.',
    parameters: {
      action: {
        type: 'string', required: true,
        enum: ['list', 'approve', 'reject'],
        description: 'list the pending queue, or approve/reject one entry by id.',
      },
      id: { type: 'string', description: 'The suggestion id; required for approve and reject.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, enum: ['list', 'approve', 'reject'] },
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          suggestions: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                kind: { type: 'string', required: true, enum: ['card', 'fact', 'user', 'commitment'] },
                content: { type: 'string', required: true },
                hits: { type: 'number', required: true },
                firstSeen: { type: 'string', required: true },
              },
            },
          },
          id: { type: 'string' },
          landedKind: { oneOf: [{ type: 'string', enum: ['card', 'fact', 'commitment'] }, { type: 'null' }] },
          landedId: { type: 'string' },
        },
      },
      render: (_args, value: SuggestionsResult) => {
        if (!value.ok) return [{ type: 'text', text: `Error: ${value.error ?? 'unknown error'}` }]
        if (value.action === 'list') {
          const items = value.suggestions ?? []
          return [{
            type: 'text',
            text: items.length === 0
              ? 'No pending memory suggestions.'
              : items.map(s => `- [${s.id}] (${s.kind}, hits ${s.hits}) ${s.content}`).join('\n'),
          }]
        }
        if (value.action === 'reject') return [{ type: 'text', text: `Rejected suggestion ${value.id}.` }]
        if (value.landedKind == null) {
          return [{
            type: 'text',
            text: `Approved suggestion ${value.id} (user profile — merged into the human block during consolidation).`,
          }]
        }
        return [{ type: 'text', text: `Approved suggestion ${value.id} → landed as ${value.landedKind} ${value.landedId}.` }]
      },
    },
    execute(args): Promise<SuggestionsResult> {
      const action = args.action as SuggestionsResult['action']
      if (action === 'list') {
        const suggestions = service.store.listSuggestions('pending').slice(0, 20)
          .map(({ id, kind, content, hits, firstSeen }) => ({ id, kind, content, hits, firstSeen }))
        return Promise.resolve({ action, ok: true, suggestions })
      }
      const id = args.id as string | undefined
      if (!id) return Promise.resolve(failure(action, `id is required for ${action}`))
      const suggestion = service.store.listSuggestions().find(s => s.id === id)
      if (!suggestion) return Promise.resolve(failure(action, `no suggestion with id ${id}`))
      if (suggestion.status !== 'pending') {
        return Promise.resolve(failure(action, `suggestion ${id} is already ${suggestion.status}`))
      }
      if (action === 'reject') {
        service.store.resolveSuggestion(id, 'rejected')
        return Promise.resolve({ action, ok: true, id })
      }
      // approve: explicit user action → direct landing, no salience gate.
      switch (suggestion.kind) {
        case 'user':
          // Consolidation ④ recompiles approved user suggestions into the
          // human block; the tool must not touch core blocks directly.
          service.store.resolveSuggestion(id, 'approved')
          return Promise.resolve({ action, ok: true, id, landedKind: null })
        case 'card': {
          // FR-3.6 write hygiene gate — same as every other write path.
          const verdict = sanitizeForWrite(suggestion.content)
          if (!verdict.ok) {
            return Promise.resolve(failure(action, `content rejected by write hygiene (${verdict.reason})`))
          }
          try {
            const card = service.store.insertCard({
              summary: summarize(verdict.text),
              content: verdict.text,
              pinned: true,
              salience: 1,
              sessionId: null,
            })
            // Detached embedding (FR-4.1) + auto-linking (FR-2.4), both
            // failure-tolerant, identical to the memory_store explicit path.
            embedCard(service.store, embedder, card)
            autoLink(service.store, card.id, verdict.text)
            service.store.resolveSuggestion(id, 'approved')
            return Promise.resolve({ action, ok: true, id, landedKind: 'card', landedId: card.id })
          } catch (error) {
            return Promise.resolve(failure(action, `failed to land card: ${String(error)}`))
          }
        }
        case 'fact': {
          const parts = suggestion.content.split('|').map(part => part.trim())
          const [subject, predicate, object] = parts
          if (parts.length < 3 || !subject || !predicate || !object) {
            return Promise.resolve(failure(
              action,
              'malformed fact content; expected "主体 | 属性 | 值" (subject | attribute | value)',
            ))
          }
          try {
            const fact = service.store.insertFact({ subject, predicate, object: parts.slice(2).join(' | ') })
            service.store.resolveSuggestion(id, 'approved')
            return Promise.resolve({ action, ok: true, id, landedKind: 'fact', landedId: fact.id })
          } catch (error) {
            return Promise.resolve(failure(action, `failed to land fact: ${String(error)}`))
          }
        }
        case 'commitment': {
          try {
            const commitment = service.store.addCommitment({ content: suggestion.content, dueAt: null })
            service.store.resolveSuggestion(id, 'approved')
            return Promise.resolve({ action, ok: true, id, landedKind: 'commitment', landedId: commitment.id })
          } catch (error) {
            return Promise.resolve(failure(action, `failed to land commitment: ${String(error)}`))
          }
        }
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Review memory suggestions', kind: 'other', rawInput: args }),
  }))
}
