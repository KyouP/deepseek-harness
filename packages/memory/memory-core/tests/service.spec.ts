// packages/memory/memory-core/tests/service.spec.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import * as memory from '../src/index.ts'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('memory-core service', () => {
  it('exposes ctx.memoryStore with an open store at the configured path and disposes it (HMR-safety)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hmem-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(memory, { dbPath: join(dir, 'hmem.db') })
    expect(ctx.memoryStore.store.listTables()).toContain('cards')
    await fiber.dispose()
    expect(ctx.get('memoryStore')).toBeUndefined()
  })

  // Cordis semantics: an unmet inject keeps the fiber PENDING (it never
  // rejects), so apply() never runs and no store is opened.
  it('stays pending without systemPrompt and never opens the store', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hmem-'))
    const ctx = new Context()
    await ctx.plugin(memory, { dbPath: join(dir, 'hmem.db') })
    expect(ctx.get('memoryStore')).toBeUndefined()
  })

  it('resolves the default database path under the harness home when dbPath is empty', () => {
    expect(memory.resolveDbPath({})).toBe(join(dshHomePath('storages'), 'hmem.db'))
  })
})
