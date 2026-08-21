/**
 * Read-path memory tools: `memory_recall` (v2: ranked multi-channel recall,
 * see recall.ts), `memory_expand` and `memory_forget`. Registered inside the
 * memory-core inject scope so they unload with the store service.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryStoreService } from './service.ts'
import type { Embedder } from './llm.ts'
import { rankedRecall } from './recall.ts'
import { sessionWorkspace } from './workspace.ts'

/** The slice of the plugin Config the recall tools read. */
export interface RecallToolsConfig {
  /** FR-2.9: boost same-workspace cards during recall (default false). */
  workspaceScope?: boolean
}

/**
 * Embed the recall query once (FR-4.1 热路径单次调用); any failure degrades
 * to the bm25-only baseline without a throw (NFR-2.2).
 */
async function embedQuery(embedder: Embedder | null | undefined, query: string): Promise<number[] | null> {
  if (!embedder) return null
  try {
    return (await embedder.embed([query]))?.[0] ?? null
  } catch {
    return null
  }
}

/**
 * Register the read-path tools: `memory_recall`, `memory_expand`, `memory_forget`.
 * @param ctx - inject scope carrying the tool registry.
 * @param service - the memory store service.
 * @param embedder - optional vector backend; memory_recall embeds the query
 *   once per call (failure degrades to bm25-only, never throws).
 * @param config - plugin configuration slice; workspaceScope gates the
 *   same-workspace recall boost (FR-2.9, default off).
 */
export function registerRecallTools(
  ctx: Context,
  service: MemoryStoreService,
  embedder?: Embedder | null,
  config?: RecallToolsConfig,
): void {
  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: 'Search your long-term memory. Returns one-line summaries; call '
      + 'memory_expand(id) for the full text of any hit. Query tips: use one or two '
      + 'distinctive keywords as they likely appear in the memory (Chinese substring '
      + 'matching works, e.g. 身体 finds 主人身体不太好); a full rephrased question is '
      + 'a worse query than a keyword. Results marked [不确定] are low-confidence. '
      + 'Set deep=true to also search faded (archived) memories and revive hits.',
    parameters: {
      query: { type: 'string', required: true, description: 'One or two distinctive keywords, not a full sentence.' },
      limit: { type: 'integer', description: 'Max results (default 10).' },
      deep: { type: 'boolean', description: 'Also search archived (faded) memories; hits are revived.' },
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
                kind: { type: 'string', required: true, description: "'card' or 'fact'." },
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
          : value.results.map(r =>
            `- [${r.id}] ${r.uncertain ? '[不确定] ' : ''}${r.kind === 'fact' ? '[事实] ' : ''}${r.summary}`,
          ).join('\n'),
      }],
    },
    async execute(args, exec) {
      const queryVector = await embedQuery(embedder, args.query)
      const hits = rankedRecall(service.store, args.query, {
        limit: args.limit ?? 10,
        deep: args.deep ?? false,
        queryVector,
        // FR-2.9：scope 开且 cwd 已知时同工作区卡 +0.1；cwd 未知（null）时
        // 与关闭完全一致（保守退化，绝不藏记忆）。
        workspaceScope: config?.workspaceScope ?? false,
        workspace: sessionWorkspace(exec.agent?.session),
      })
      return {
        results: hits.map(h => ({ id: h.id, summary: h.summary, kind: h.kind, uncertain: h.uncertain })),
      }
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
