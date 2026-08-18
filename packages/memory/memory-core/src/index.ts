/**
 * H-MEM core plugin: owns the memory database and (from Task 6 on) the M1 core
 * blocks, commitment injection, scratchpad and the model-facing memory tools.
 * @module @deepseek-ai/dsh-memory-core
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { join } from 'node:path'
import { MemoryStoreService } from './service.ts'

export const name = 'memory-core'
export const inject = ['systemPrompt', 'tools']

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
 * Mount the memory store service; later tasks register sections and tools here.
 * @param ctx - plugin context carrying the injected prompt and tool registries.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(MemoryStoreService, resolveDbPath(config))
}

export { MemoryStoreService } from './service.ts'
