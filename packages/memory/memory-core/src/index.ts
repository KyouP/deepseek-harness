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
import type { LlmConfig, LlmStreamLike } from './llm.ts'
import { createBackend } from './llm.ts'
import { Sedimenter, type AgentLike } from './sediment.ts'
import { mountAutoRecall } from './auto-recall.ts'

export const name = 'memory-core'
export const inject = ['systemPrompt', 'tools']

/**
 * Static discipline section (order 5): teaches the model how the memory
 * system behaves. A constant string so the rendered bytes are stable across
 * assemblies (NFR-3.1) — no dynamic data ever lands here.
 */
export const MEMORY_DISCIPLINE = [
  '记忆系统：你的长期记忆由 memory 系列工具支撑，每轮对话结束后会自动沉淀要点，无需每轮手动保存。',
  '用户明确要求「记住/别忘了」时，仍应调用 memory_store（type=memory）。亲口许下待办时用 type=commitment，完成后用 memory_close_commitment 闭环。',
  '回忆往事优先 memory_recall（一两个特征关键词），命中后用 memory_expand 看全文；翻更早的会话原文用 memory_browse。',
].join('\n')

/**
 * Memory-core configuration. All fields optional; every field carries a
 * schema default because the profile cordis.patch.yml replaces the WHOLE
 * config by id. Defaults stay fully local.
 *
 * The llm* fields mirror {@link LlmConfig} (same names and types) so the
 * resolved Config stays structurally assignable to it.
 */
export interface Config extends LlmConfig {
  /** Database file path; empty resolves to `$DSH_HOME/storages/hmem.db`. */
  dbPath?: string
  /** Seed text for the persona block (only when the block has never been written). */
  persona?: string
  /** Seed text for the human block (only when the block has never been written). */
  human?: string
  /** Char budget for the persona core block section. */
  personaBudgetChars?: number
  /** Char budget for the human core block section. */
  humanBudgetChars?: number
  /** Row cap for the commitments injection (P0 channel — rows, not chars). */
  commitmentRowCap?: number
  /** Char budget for the scratchpad injection. */
  scratchpadBudgetChars?: number
  /** Char budget for the automatic recall injection (v2 recall channel). */
  recallBudgetChars?: number
  /** Char budget for the preheat (session-start) recall injection. */
  preheatBudgetChars?: number
  /** Enable automatic post-turn sedimentation of conversation points. */
  sedimentEnabled?: boolean
  /** Minimum turn size (chars) before sedimentation considers it. */
  sedimentMinChars?: number
  /** Maximum sedimentations per day. */
  sedimentDailyMax?: number
  /** Cooldown between sedimentation runs (minutes). */
  sedimentCooldownMinutes?: number
  /** Automatically inject recall hits into the prompt. */
  recallAutoInject?: boolean
  /** Minimum relevance score for an automatic recall hit. */
  recallRelevanceFloor?: number
  /** Enable periodic memory review. */
  reviewEnabled?: boolean
  /** Turns between review passes. */
  reviewIntervalTurns?: number
  /** Idle time (minutes) before consolidation runs. */
  consolidateIdleMinutes?: number
  /** Daily decay factor applied to card salience. */
  decayLambdaPerDay?: number
  /** Archive cards whose salience decays below this. */
  decayArchiveBelow?: number
  /** Enable the embedding backend for semantic recall. */
  embedEnabled?: boolean
  /** Embedding model name. */
  embedModel?: string
  /** Queue memory writes for confirmation instead of applying directly. */
  confirmQueue?: boolean
  /** Scope memories to the current workspace. */
  workspaceScope?: boolean
}

/** Schemastery configuration for the memory-core consumer. */
export const Config: z<Config> = z.object({
  dbPath: z.string().default(''),
  persona: z.string().default(''),
  human: z.string().default(''),
  personaBudgetChars: z.number().default(3000),
  humanBudgetChars: z.number().default(2500),
  commitmentRowCap: z.number().default(20),
  scratchpadBudgetChars: z.number().default(1200),
  recallBudgetChars: z.number().default(1800),
  preheatBudgetChars: z.number().default(800),
  llmBackend: z.union(['auto', 'ollama', 'openai', 'main', 'off'] as const).default('auto'),
  ollamaHost: z.string().default('http://127.0.0.1:11434'),
  ollamaModel: z.string().default('qwen3.5:4b'),
  openaiBaseUrl: z.string().default(''),
  openaiApiKey: z.string().default(''),
  openaiModel: z.string().default(''),
  mainProvider: z.string().default(''),
  mainModel: z.string().default(''),
  llmTimeoutMs: z.number().default(90_000),
  sedimentEnabled: z.boolean().default(true),
  sedimentMinChars: z.number().default(240),
  sedimentDailyMax: z.number().default(8),
  sedimentCooldownMinutes: z.number().default(30),
  recallAutoInject: z.boolean().default(true),
  recallRelevanceFloor: z.number().default(0.05),
  reviewEnabled: z.boolean().default(true),
  reviewIntervalTurns: z.number().default(5),
  consolidateIdleMinutes: z.number().default(30),
  decayLambdaPerDay: z.number().default(0.02),
  decayArchiveBelow: z.number().default(0.2),
  embedEnabled: z.boolean().default(false),
  embedModel: z.string().default('bge-m3'),
  confirmQueue: z.boolean().default(false),
  workspaceScope: z.boolean().default(false),
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
    mountCoreBlocks(
      scope, scope.memoryStore,
      { persona: config.persona, human: config.human },
      { persona: config.personaBudgetChars ?? 3000, human: config.humanBudgetChars ?? 2500 },
    )
    registerStoreTools(scope, scope.memoryStore)
    registerRecallTools(scope, scope.memoryStore)
    registerCommitmentTools(scope, scope.memoryStore)
    mountInjections(scope, scope.memoryStore, {
      commitmentRowCap: config.commitmentRowCap ?? 20,
      scratchpadBudgetChars: config.scratchpadBudgetChars ?? 1200,
    })
    // Static discipline section (constant text, byte-stable); it replaces the
    // v1 dynamic recall-hint context.
    scope.systemPrompt.section({ name: 'hmem:discipline', order: 5, text: MEMORY_DISCIPLINE })

    // Automatic per-turn recall injection (FR-4.8): a pre-step listener
    // refreshes the recall block from the latest user text (synchronous local
    // SQLite — no LLM — so it stays within the NFR-1.3 hot-path budget), and
    // the hmem:recall context provider renders it. recallAutoInject=false
    // turns both halves into no-ops.
    mountAutoRecall(scope, scope.memoryStore.store, config)

    // Warm-path auto sedimentation (FR-3.5/FR-6.5): after each turn closes,
    // distill its memorable items through the LLM backend and route them into
    // the store. Fire-and-forget — the hook never blocks the turn stop.
    const sedimenter = new Sedimenter({
      store: scope.memoryStore.store,
      llm: createBackend(config, scope.get('llm', false) as unknown as LlmStreamLike | undefined),
      config,
      logger: { warn: (msg) => { scope.logger.warn(msg) } },
    })
    // This package does not depend on @deepseek-ai/dsh-agent, so the event is
    // not in the local Events augmentation; the runtime payload carries
    // { agent, turn, signal } (api-catalog) and older dispatches may omit agent.
    const events = scope as unknown as {
      on(event: 'agent/turn-stopping', listener: (payload: { agent?: AgentLike; turn?: number }) => void): void
    }
    events.on('agent/turn-stopping', (payload) => {
      sedimenter.onTurnStopping(payload.agent ?? (payload as unknown as AgentLike), payload.turn ?? 0)
    })
  })
}

export { MemoryStoreService } from './service.ts'
export { CoreBlockCache, HUMAN_BLOCK_ORDER, PERSONA_BLOCK_ORDER } from './core-blocks.ts'
export { TRUNCATION_MARKER, budgetText, truncateChars } from './budget.ts'
export { rankedRecall } from './recall.ts'
export type { RankedHit, RankedRecallOptions } from './recall.ts'
export { AutoRecall, mountAutoRecall, RECALL_BLOCK_HEADER } from './auto-recall.ts'
export type { AutoRecallConfig, AutoRecallLogger } from './auto-recall.ts'
