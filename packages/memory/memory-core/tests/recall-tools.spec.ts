// packages/memory/memory-core/tests/recall-tools.spec.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderContextSnapshot, renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import * as memory from '../src/index.ts'
import { MEMORY_DISCIPLINE } from '../src/index.ts'

const sig = new AbortController().signal
let dir = ''
let counter = 200
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

async function setup() {
  dir = mkdtempSync(join(tmpdir(), 'hmem-'))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  // Cordis root Context has no dispose(); disposing the memory fiber closes the
  // store (also needed on Windows so the temp DB file is unlocked for cleanup).
  const fiber = await ctx.plugin(memory, { dbPath: join(dir, 'hmem.db') })
  return { ctx, fiber }
}

function call(ctx: Context, name_: string, args: unknown) {
  return ctx.tools.execute({ signal: sig, callId: CallId(`c-${++counter}`), name: name_, arguments: args })
}

describe('recall tools', () => {
  it('memory_recall returns one-line summaries of matching cards', async () => {
    const { ctx, fiber } = await setup()
    await call(ctx, 'memory_store', { content: '用户养了一只叫年糕的猫' })
    // FTS5 prefix matching: unicode61 never splits a CJK run, so the query must
    // be a prefix of the indexed run — a mid-run query like 猫 does not match.
    const result = await call(ctx, 'memory_recall', { query: '用户养' })
    expect(result.isError).toBe(false)
    const value = (result as { value: { results: { id: string; summary: string; uncertain: boolean }[] } }).value
    expect(value.results).toHaveLength(1)
    expect(value.results[0]!.summary).toContain('年糕')
    expect(value.results[0]!.uncertain).toBe(false)
    await fiber.dispose()
  })

  it('memory_recall honours the limit argument', async () => {
    const { ctx, fiber } = await setup()
    await call(ctx, 'memory_store', { content: '偏好深色模式' })
    await call(ctx, 'memory_store', { content: '偏好浅色图标' })
    const result = await call(ctx, 'memory_recall', { query: '偏好', limit: 1 })
    expect(result.isError).toBe(false)
    expect((result as { value: { results: unknown[] } }).value.results).toHaveLength(1)
    await fiber.dispose()
  })

  it('memory_recall renders the hit list, the uncertain marker and the empty arm', async () => {
    const { ctx, fiber } = await setup()
    const tool = ctx.tools.get('memory_recall')!
    const hit = tool.output.render({ query: '偏好' }, {
      results: [
        { id: 'a', summary: '确定记忆', uncertain: false },
        { id: 'b', summary: '含糊记忆', uncertain: true },
      ],
    })
    expect(hit).toEqual([{ type: 'text', text: '- [a] 确定记忆\n- [b] [不确定] 含糊记忆' }])
    // Empty render arm, exercised through a real no-hit recall.
    const empty = await call(ctx, 'memory_recall', { query: '词xyzzy' })
    expect((empty as { value: { results: unknown[] } }).value.results).toHaveLength(0)
    expect(tool.output.render({ query: '词xyzzy' }, { results: [] }))
      .toEqual([{ type: 'text', text: 'No memories found.' }])
    await fiber.dispose()
  })

  it('memory_expand returns the full card content', async () => {
    const { ctx, fiber } = await setup()
    const stored = await call(ctx, 'memory_store', { content: '完整内容：用户对花生严重过敏，随身携带肾上腺素笔' })
    const id = (stored as { value: { id: string } }).value.id
    const expanded = await call(ctx, 'memory_expand', { id })
    expect(expanded.isError).toBe(false)
    const value = (expanded as {
      value: { id: string; content: string; contextDesc: string | null; emotion: string | null; recordedAt: string }
    }).value
    expect(value.id).toBe(id)
    expect(value.content).toContain('肾上腺素笔')
    expect(value.contextDesc).toBeNull()
    expect(value.emotion).toBeNull()
    expect(value.recordedAt).toBeTruthy()
    await fiber.dispose()
  })

  it('memory_expand on an unknown id is an error, not a crash', async () => {
    const { ctx, fiber } = await setup()
    const result = await call(ctx, 'memory_expand', { id: 'nope' })
    expect(result.isError).toBe(true)
    await fiber.dispose()
  })

  it('memory_forget removes the card from later recall', async () => {
    const { ctx, fiber } = await setup()
    const stored = await call(ctx, 'memory_store', { content: '需要被遗忘的秘密 secret-forget-1' })
    const id = (stored as { value: { id: string } }).value.id
    const forgot = await call(ctx, 'memory_forget', { id })
    expect(forgot.isError).toBe(false)
    expect((forgot as { value: { cards: number } }).value.cards).toBe(1)
    const after = await call(ctx, 'memory_recall', { query: 'secret-forget-1' })
    expect((after as { value: { results: unknown[] } }).value.results).toHaveLength(0)
    await fiber.dispose()
  })

  it('memory_forget on an unknown id is an error, not a crash', async () => {
    const { ctx, fiber } = await setup()
    const result = await call(ctx, 'memory_forget', { id: 'nope' })
    expect(result.isError).toBe(true)
    await fiber.dispose()
  })

  it('presents call cards for all three tools', async () => {
    const { ctx, fiber } = await setup()
    expect(ctx.tools.get('memory_recall')!.presentCall!({ query: 'x' }))
      .toMatchObject({ title: 'Recall memory', kind: 'read' })
    expect(ctx.tools.get('memory_expand')!.presentCall!({ id: 'x' }))
      .toMatchObject({ title: 'Expand memory', kind: 'read' })
    expect(ctx.tools.get('memory_forget')!.presentCall!({ id: 'x' }))
      .toMatchObject({ title: 'Forget memory', kind: 'other' })
    await fiber.dispose()
  })

  it('injects the static discipline section into the assembled prompt', async () => {
    const { ctx, fiber } = await setup()
    // The discipline section is a static SECTION (not a context), so it shows
    // up in the rendered prompt sections, not in the context snapshot.
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('memory_recall')
    expect(prompt).toContain(MEMORY_DISCIPLINE)
    const snapshot = renderContextSnapshot(await ctx.systemPrompt.assemble())
    expect(snapshot).not.toContain('长期记忆：需要回忆')
    await fiber.dispose()
  })
})
