/**
 * H-MEM core plugin: owns the memory database and (from Task 6 on) the M1 core
 * blocks, commitment injection, scratchpad and the model-facing memory tools.
 * @module @deepseek-ai/dsh-memory-core
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { openMemoryStore } from '@deepseek-ai/dsh-memory-store'
import type { MemoryStore } from '@deepseek-ai/dsh-memory-store'
import { join } from 'node:path'
import { MemoryStoreService } from './service.ts'
import { mountCoreBlocks } from './core-blocks.ts'
import { registerStoreTools } from './tools-store.ts'
import { registerRecallTools } from './tools-recall.ts'
import { registerCommitmentTools } from './tools-commitments.ts'
import { mountInjections } from './injections.ts'

export const name = 'memory-core'
export const inject = ['systemPrompt', 'tools']

/** One-line prompt hint (order 30) telling the model the recall tool exists. */
export const RECALL_HINT = '长期记忆：需要回忆用户的过往信息时，调用 memory_recall 检索，再用 memory_expand 查看全文。'

/** Memory-core configuration. All fields optional; defaults stay fully local. */
export interface Config {
  /** Database file path; empty resolves to `$DSH_HOME/storages/hmem.db`. */
  dbPath?: string
  /** Seed text for the persona block (only when the block has never been written). */
  persona?: string
  /** Seed text for the human block (only when the block has never been written). */
  human?: string
}

/** Schemastery configuration for the memory-core consumer. */
export const Config: z<Config> = z.object({
  dbPath: z.string().default(''),
  persona: z.string().default(''),
  human: z.string().default(''),
})

/**
 * Resolve the database path: configured value wins, then the harness home.
 * @param config - plugin configuration.
 * @returns absolute database file path.
 */
export function resolveDbPath(config: Config): string {
  return config.dbPath ? config.dbPath : join(dshHomePath('storages'), 'hmem.db')
}

/**
 * Mount the memory store service, then seed and expose the M1 core blocks.
 * @param ctx - plugin context carrying the injected prompt and tool registries.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const dbPath = resolveDbPath(config)
  // Open the store synchronously here, before mounting the service. Cordis
  // defers plugin-callback errors into an async fiber rejection (logged via
  // `logger.error`, surfaced only when the fiber is awaited), so a throwing
  // `openMemoryStore` inside the service constructor could tear down a boot
  // loader that awaits fibers. Guarding the open here degrades to "no memory"
  // instead: the service is never provided, so the inject scope below never
  // runs and no core blocks, tools or injections are mounted.
  let store: MemoryStore
  try {
    store = openMemoryStore(dbPath)
  } catch (error) {
    ctx.logger.warn(`memory-core: cannot open memory store at ${dbPath}: ${String(error)}; memory features disabled`)
    return
  }
  ctx.plugin(MemoryStoreService, store)
  // Cordis guards service access by `inject`: the store is provided by the child
  // fiber above, so this fiber cannot read `ctx.memoryStore` directly. The
  // inject scope runs synchronously here (the dependency is already provided)
  // and unloads the sections/tool automatically if the store is ever disposed.
  ctx.inject(['memoryStore'], (scope) => {
    mountCoreBlocks(scope, scope.memoryStore, { persona: config.persona, human: config.human })
    registerStoreTools(scope, scope.memoryStore)
    registerRecallTools(scope, scope.memoryStore)
    registerCommitmentTools(scope, scope.memoryStore)
    mountInjections(scope, scope.memoryStore)
    // Lightweight static hint; v2 replaces this with automatic recall injection.
    scope.systemPrompt.context({ name: 'hmem:recall-hint', order: 30, text: () => RECALL_HINT })
  })
}

export { MemoryStoreService } from './service.ts'
export { CoreBlockCache, HUMAN_BLOCK_ORDER, PERSONA_BLOCK_ORDER } from './core-blocks.ts'
