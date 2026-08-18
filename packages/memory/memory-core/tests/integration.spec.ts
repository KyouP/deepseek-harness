// packages/memory/memory-core/tests/integration.spec.ts
// Whole-mount smoke: the memory-core plugin over the real SystemPrompt +
// ToolRuntime pair, proving the six v1 tools register and the store survives
// a dispose/re-open cycle against the same database file.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as memory from '../src/index.ts'

let dir = ''
let fiber: { dispose(): Promise<void> } | undefined
afterEach(async () => {
  await fiber?.dispose()
  fiber = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

async function mount(dbPath: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  fiber = await ctx.plugin(memory, { dbPath })
  return ctx
}

describe('memory-core integration', () => {
  it('registers all five v1 tools plus memory_note', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hmem-'))
    const ctx = await mount(join(dir, 'hmem.db'))
    const names = ctx.tools.schemas().map(s => s.name).sort()
    for (const expected of [
      'memory_store', 'memory_note', 'memory_update_core',
      'memory_recall', 'memory_expand', 'memory_forget',
    ]) {
      expect(names).toContain(expected)
    }
  })

  it('survives disposal and re-open with data intact (durability)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hmem-'))
    const dbPath = join(dir, 'hmem.db')
    let ctx = await mount(dbPath)
    ctx.memoryStore.store.addCommitment({ content: '持久化验证' })
    await fiber!.dispose()
    fiber = undefined
    ctx = await mount(dbPath)
    expect(ctx.memoryStore.store.activeCommitments().map(c => c.content)).toEqual(['持久化验证'])
  })
})
