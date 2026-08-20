/**
 * M1 core blocks: seeding from config, in-memory cache feeding the two prompt
 * sections, and the `memory_update_core` self-edit tool.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CoreBlock } from '@deepseek-ai/dsh-memory-store'
import type { MemoryStoreService } from './service.ts'
import { truncateChars } from './budget.ts'
import { sanitizeForInjection } from './sanitize.ts'

/** Prompt order after the deployment persona (0) — M1 blocks sit right behind it. */
export const PERSONA_BLOCK_ORDER = 10
export const HUMAN_BLOCK_ORDER = 11

/** In-memory face of the M1 blocks so prompt assembly never touches disk. */
export class CoreBlockCache {
  private persona = ''
  private human = ''

  constructor(private readonly service: MemoryStoreService) {
    this.refresh('persona')
    this.refresh('human')
  }

  /** Current cached text of one block (empty string when unwritten). */
  get(name: 'persona' | 'human'): string {
    return name === 'persona' ? this.persona : this.human
  }

  /** Reload one block from the store after a write. */
  refresh(name: 'persona' | 'human'): void {
    const row: CoreBlock | null = this.service.store.getCoreBlock(name)
    if (name === 'persona') this.persona = row?.text ?? ''
    else this.human = row?.text ?? ''
  }
}

/**
 * Seed unwritten blocks from config, mount the two M1 prompt sections and the
 * `memory_update_core` self-edit tool. Section text is sanitized and truncated
 * to the configured per-block budget at every assembly.
 * @param ctx - plugin context with systemPrompt and tools composed.
 * @param service - the memory store service.
 * @param seeds - config seed texts.
 * @param budgets - per-block char budgets (marker not counted).
 * @returns the live cache, shared with context providers of later tasks.
 */
export function mountCoreBlocks(
  ctx: Context,
  service: MemoryStoreService,
  seeds: { persona?: string | undefined; human?: string | undefined },
  budgets: { persona: number; human: number },
): CoreBlockCache {
  if (service.store.getCoreBlock('persona') === null && seeds.persona) {
    service.store.setCoreBlock('persona', seeds.persona)
  }
  if (service.store.getCoreBlock('human') === null && seeds.human) {
    service.store.setCoreBlock('human', seeds.human)
  }
  const cache = new CoreBlockCache(service)
  ctx.systemPrompt.section({
    name: 'hmem:persona',
    order: PERSONA_BLOCK_ORDER,
    text: () => truncateChars(sanitizeForInjection(cache.get('persona')), budgets.persona),
  })
  ctx.systemPrompt.section({
    name: 'hmem:human',
    order: HUMAN_BLOCK_ORDER,
    text: () => truncateChars(sanitizeForInjection(cache.get('human')), budgets.human),
  })
  ctx.tools.register(defineTool({
    name: 'memory_update_core',
    description: 'Rewrite one of your core memory blocks. `persona` is who you are '
      + '(traits, values, speech style); `human` is what you know about the user and '
      + 'your relationship. The full new text REPLACES the block — carry over anything '
      + 'you want to keep. Use when the user asks you to change how you address them, '
      + 'or when your understanding of them has materially shifted.',
    parameters: {
      block: { type: 'string', required: true, enum: ['persona', 'human'], description: 'Which block to rewrite.' },
      content: { type: 'string', required: true, description: 'The COMPLETE new block text.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          block: { type: 'string', required: true },
          revision: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Updated ${value.block} block (revision ${value.revision}).` }],
    },
    execute(args) {
      // `defineTool` validates the parameters enum before this body runs, so
      // `args.block` is already narrowed to 'persona' | 'human'.
      const row = service.store.setCoreBlock(args.block, args.content)
      cache.refresh(args.block)
      return Promise.resolve({ block: row.name, revision: row.revision })
    },
    presentCall: args => ({ card: 'generic', title: 'Update core memory', kind: 'other', rawInput: args }),
  }))
  return cache
}
