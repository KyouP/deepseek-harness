/**
 * M4 deep-time recall tool: `memory_browse` over the raw session JSONL
 * archive (see browse.ts). Registered inside the memory-core inject scope so
 * it unloads with the store service.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { MemoryStoreService } from './service.ts'
import type { SessionMessage } from './browse.ts'
import { browseSessions, DEFAULT_BROWSE_LIMIT } from './browse.ts'

/** Per-message char cap in the detail view. */
export const BROWSE_MESSAGE_MAX_CHARS = 500
/** Total char cap across all messages in the detail view. */
export const BROWSE_TOTAL_MAX_CHARS = 8000

/** Truncate one session's message flow to the per-message and total budgets. */
export function truncateSessionMessages(messages: SessionMessage[]): { messages: SessionMessage[]; truncated: boolean } {
  const out: SessionMessage[] = []
  let total = 0
  let truncated = false
  for (const message of messages) {
    let text = message.text
    if (text.length > BROWSE_MESSAGE_MAX_CHARS) {
      text = text.slice(0, BROWSE_MESSAGE_MAX_CHARS) + '…'
      truncated = true
    }
    if (total + text.length > BROWSE_TOTAL_MAX_CHARS) {
      truncated = true
      break
    }
    total += text.length
    out.push({ role: message.role, text })
  }
  return { messages: out, truncated }
}

/**
 * Register the `memory_browse` tool: list archived sessions, or replay one
 * session's message flow (budget-truncated).
 * @param ctx - inject scope carrying the tool registry.
 * @param _service - the memory store service (kept for registration symmetry;
 *   browsing reads the session archive, not the memory store).
 */
export function registerBrowseTool(ctx: Context, _service: MemoryStoreService): void {
  ctx.tools.register(defineTool({
    name: 'memory_browse',
    description: 'Browse raw past-session transcripts (deep-time recall). Without sessionId, '
      + 'lists archived sessions (id, createdAt, cwd, message count; newest first, optional '
      + 'since/until ISO date filter). With sessionId, returns that session\'s user/assistant '
      + 'message flow (each message ≤500 chars, total ≤8000 chars, truncated with a marker). '
      + 'Use memory_recall first; this is for reading the original conversation.',
    parameters: {
      sessionId: { type: 'string', description: 'Session id from a prior listing; returns that session\'s messages.' },
      since: { type: 'string', description: 'ISO date/datetime lower bound on session creation (listing only).' },
      until: { type: 'string', description: 'ISO date/datetime upper bound on session creation (listing only).' },
      limit: { type: 'integer', description: `Max sessions listed (default ${DEFAULT_BROWSE_LIMIT}).` },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object', additionalProperties: false,
            properties: {
              sessions: {
                type: 'array', required: true,
                items: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    createdAt: { type: 'string', required: true },
                    cwd: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                    messageCount: { type: 'integer', required: true },
                  },
                },
              },
              skippedZstd: { type: 'integer', required: true },
            },
          },
          {
            type: 'object', additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              createdAt: { type: 'string', required: true },
              cwd: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
              messages: {
                type: 'array', required: true,
                items: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    role: { type: 'string', required: true, enum: ['user', 'assistant'] },
                    text: { type: 'string', required: true },
                  },
                },
              },
              truncated: { type: 'boolean', required: true },
            },
          },
        ],
      },
      render: (args, value) => {
        if ('sessions' in value) {
          const lines = value.sessions.map(s =>
            `- [${s.id}] ${s.createdAt} ${s.cwd ?? '(no cwd)'} — ${s.messageCount} message(s)`)
          if (value.skippedZstd > 0) {
            lines.push(`(${value.skippedZstd} compressed .zstd session(s) skipped — not yet supported)`)
          }
          return [{
            type: 'text',
            text: lines.length === 0 ? 'No archived sessions found.' : lines.join('\n'),
          }]
        }
        const lines = value.messages.map(m => `[${m.role}] ${m.text}`)
        if (value.truncated) {
          lines.push(`… (truncated: each message ≤${BROWSE_MESSAGE_MAX_CHARS} chars, `
            + `total ≤${BROWSE_TOTAL_MAX_CHARS} chars)`)
        }
        return [{
          type: 'text',
          text: lines.length === 0 ? `Session ${args.sessionId ?? value.id} has no messages.` : lines.join('\n'),
        }]
      },
    },
    async execute(args) {
      // TODO(sessionQuery): when a sessionQuery service is present
      // (ctx.get('sessionQuery', false)), prefer it for sessionId lookup; the
      // JSONL scan below is the baseline and the only test-covered path.
      const root = dshHomePath('sessions')
      const logger = { warn: (message: string): void => { ctx.logger.warn(message) } }
      if (args.sessionId !== undefined) {
        const { sessions } = await browseSessions(root, { sessionId: args.sessionId, logger })
        const session = sessions[0]
        if (!session) throw new Error(`no archived session with id ${args.sessionId}`)
        const { messages, truncated } = truncateSessionMessages(session.messages)
        return {
          id: session.id, createdAt: session.createdAt, cwd: session.cwd, messages, truncated,
        }
      }
      const { sessions, skippedZstd } = await browseSessions(root, {
        ...(args.since !== undefined ? { since: args.since } : {}),
        ...(args.until !== undefined ? { until: args.until } : {}),
        limit: args.limit ?? DEFAULT_BROWSE_LIMIT,
        logger,
      })
      return {
        sessions: sessions.map(s => ({
          id: s.id, createdAt: s.createdAt, cwd: s.cwd, messageCount: s.messages.length,
        })),
        skippedZstd,
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Browse sessions', kind: 'read', rawInput: args }),
  }))
}
