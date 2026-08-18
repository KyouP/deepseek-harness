// packages/memory/memory-core/tests/core-blocks.spec.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import * as memory from '../src/index.ts'

const sig = new AbortController().signal
let dir = ''
let counter = 0
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

async function setup(config: memory.Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // Cordis root Context has no dispose(); disposing the memory fiber closes the
  // store (also needed on Windows so the temp DB file is unlocked for cleanup).
  const fiber = await ctx.plugin(memory, config)
  return { ctx, fiber }
}

function call(ctx: Context, name_: string, args: unknown) {
  return ctx.tools.execute({ signal: sig, callId: CallId(`c-${++counter}`), name: name_, arguments: args })
}

describe('core blocks', () => {
  it('seeds blocks from config only when unwritten', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hmem-'))
    const dbPath = join(dir, 'hmem.db')
    const { ctx, fiber } = await setup({ dbPath, persona: '初始人格', human: '初始用户画像' })
    expect(ctx.memoryStore.store.getCoreBlock('persona')!.text).toBe('初始人格')
    await fiber.dispose()
    // 二次挂载不覆盖已有内容
    const second = await setup({ dbPath, persona: '不应覆盖' })
    expect(second.ctx.memoryStore.store.getCoreBlock('persona')!.text).toBe('初始人格')
    await second.fiber.dispose()
  })

  it('memory_update_core rewrites a block and bumps revision', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hmem-'))
    const { ctx, fiber } = await setup({ dbPath: join(dir, 'hmem.db'), persona: '旧人格' })
    const result = await call(ctx, 'memory_update_core', { block: 'persona', content: '新人格' })
    expect(result.isError).toBe(false)
    expect(ctx.memoryStore.store.getCoreBlock('persona')).toMatchObject({ text: '新人格', revision: 2 })
    // The human arm of the tool and of the cache.
    const human = await call(ctx, 'memory_update_core', { block: 'human', content: '新画像' })
    expect(human.isError).toBe(false)
    expect(ctx.memoryStore.store.getCoreBlock('human')).toMatchObject({ text: '新画像', revision: 1 })
    await fiber.dispose()
  })

  it('feeds the prompt sections from the live cache', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hmem-'))
    const { ctx, fiber } = await setup({ dbPath: join(dir, 'hmem.db'), persona: '人格文本' })
    // Before any human write the section renders empty; persona is seeded.
    expect(renderPrompt(await ctx.systemPrompt.assemble())).toContain('人格文本')
    await call(ctx, 'memory_update_core', { block: 'human', content: '用户画像文本' })
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('人格文本')
    expect(prompt).toContain('用户画像文本')
    await fiber.dispose()
  })

  it('presents a call card for memory_update_core', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hmem-'))
    const { ctx, fiber } = await setup({ dbPath: join(dir, 'hmem.db') })
    const view = ctx.tools.get('memory_update_core')!.presentCall!({ block: 'persona', content: 'x' })
    expect(view).toMatchObject({ title: 'Update core memory' })
    await fiber.dispose()
  })

  it('rejects an unknown block name', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hmem-'))
    const { ctx, fiber } = await setup({ dbPath: join(dir, 'hmem.db') })
    const result = await call(ctx, 'memory_update_core', { block: 'evil', content: 'x' })
    expect(result.isError).toBe(true)
    await fiber.dispose()
  })
})
