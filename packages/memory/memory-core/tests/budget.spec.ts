// packages/memory/memory-core/tests/budget.spec.ts
// Budget enforcement: truncateChars/budgetText units, budgeted M1 sections,
// budgeted scratchpad injection, injection-side sanitization, and the static
// discipline section (byte-stable, no dynamic data).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { PromptContext, PromptSection } from '@deepseek-ai/dsh-system-prompt'
import { openMemoryStore } from '@deepseek-ai/dsh-memory-store'
import type { MemoryStoreService } from '../src/service.ts'
import { budgetText, TRUNCATION_MARKER, truncateChars } from '../src/budget.ts'
import { mountCoreBlocks } from '../src/core-blocks.ts'
import { mountInjections } from '../src/injections.ts'
import * as memory from '../src/index.ts'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

const callText = (text: PromptSection['text']): string => (text as () => string)()

/** Fake ctx capturing prompt sections/contexts; the store underneath is real. */
function fakeCtx() {
  const sections = new Map<string, PromptSection>()
  const contexts = new Map<string, PromptContext>()
  const ctx = {
    systemPrompt: {
      section: (s: PromptSection) => { sections.set(s.name, s) },
      context: (c: PromptContext) => { contexts.set(c.name, c) },
    },
    tools: { register: () => {} },
    logger: { warn: () => {} },
  } as unknown as Context
  return { ctx, sections, contexts }
}

describe('truncateChars', () => {
  it('cuts at the last line boundary within budget and appends the marker', () => {
    const out = truncateChars('甲\n乙\n' + '丙'.repeat(100), 10)
    expect(out).toMatch(/^甲\n乙\n…（已截断/)
  })

  it('returns text unchanged when within budget', () => {
    expect(truncateChars('短文本', 100)).toBe('短文本')
  })

  it('hard-cuts at max when there is no newline', () => {
    const out = truncateChars('长'.repeat(50), 10)
    expect(out).toBe('长'.repeat(10) + TRUNCATION_MARKER)
  })

  it('returns empty string for max <= 0', () => {
    expect(truncateChars('abc', 0)).toBe('')
    expect(truncateChars('abc', -5)).toBe('')
  })
})

describe('budgetText', () => {
  it('truncates each part, drops empties and joins with blank lines', () => {
    const out = budgetText([
      { text: '第一段', max: 100 },
      { text: '', max: 100 },
      { text: '第二段', max: 100 },
    ])
    expect(out).toBe('第一段\n\n第二段')
  })

  it('returns empty string when every part is empty', () => {
    expect(budgetText([{ text: '', max: 10 }, { text: 'x', max: 0 }])).toBe('')
  })
})

describe('budgeted core blocks', () => {
  it('persona section truncates an overlong block to the configured budget', () => {
    const store = openMemoryStore(':memory:')
    store.setCoreBlock('persona', '人格'.repeat(2000))
    const { ctx, sections } = fakeCtx()
    mountCoreBlocks(ctx, { store } as unknown as MemoryStoreService, {}, { persona: 100, human: 2500 })
    const text = callText(sections.get('hmem:persona')!.text)
    expect(text.length).toBeLessThanOrEqual(100 + TRUNCATION_MARKER.length)
    expect(text).toContain('已截断')
    store.close()
  })

  it('strips sensitive sections from the injected human block', () => {
    const store = openMemoryStore(':memory:')
    store.setCoreBlock('human', '## 凭据\napi_key=x\n## 偏好\n深色')
    const { ctx, sections } = fakeCtx()
    mountCoreBlocks(ctx, { store } as unknown as MemoryStoreService, {}, { persona: 3000, human: 2500 })
    const text = callText(sections.get('hmem:human')!.text)
    expect(text).toContain('深色')
    expect(text).not.toContain('api_key')
    store.close()
  })
})

describe('budgeted scratchpad injection', () => {
  it('respects scratchpadBudgetChars across many long notes', () => {
    const store = openMemoryStore(':memory:')
    for (let i = 0; i < 30; i++) store.addNote(null, `便签${i}：${'内容'.repeat(20)}`)
    const { ctx, contexts } = fakeCtx()
    mountInjections(ctx, { store } as unknown as MemoryStoreService, { commitmentRowCap: 20, scratchpadBudgetChars: 200 })
    const text = (contexts.get('hmem:scratchpad')!.text as () => string)()
    expect(text.length).toBeLessThanOrEqual(200 + TRUNCATION_MARKER.length)
    expect(text).toContain('已截断')
    store.close()
  })
})

describe('static discipline section', () => {
  it('is byte-stable across renders and carries no dynamic data', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hmem-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(memory, { dbPath: join(dir, 'hmem.db') })
    const first = await ctx.systemPrompt.assemble()
    const second = await ctx.systemPrompt.assemble()
    const a = first.sections.find(s => s.name === 'hmem:discipline')
    const b = second.sections.find(s => s.name === 'hmem:discipline')
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a!.text).toBe(b!.text)
    expect(a!.text).toBe(memory.MEMORY_DISCIPLINE)
    // The old recall-hint context is gone.
    expect(first.contexts.some(c => c.name === 'hmem:recall-hint')).toBe(false)
    await fiber.dispose()
  })
})
