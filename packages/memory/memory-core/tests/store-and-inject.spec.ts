// packages/memory/memory-core/tests/store-and-inject.spec.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as memory from '../src/index.ts'
import { buildCommitmentsText, buildScratchpadText } from '../src/injections.ts'

const sig = new AbortController().signal
let dir = ''
let counter = 100
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

/** A parent Agent backed by a real Session — the tools read `agent.session.id`. */
function agentWithSession(id = 'parent-1'): Agent & { session: Session } {
  const session = Session.create(SessionId(id))
  return { id: SessionId(id), session } as unknown as Agent & { session: Session }
}

function call(ctx: Context, name_: string, args: unknown, agent?: Agent) {
  return ctx.tools.execute({
    signal: sig,
    callId: CallId(`c-${++counter}`),
    name: name_,
    arguments: args,
    ...agent ? { agent } : {},
  })
}

describe('memory_store / memory_note', () => {
  it('stores an explicit memory as a pinned card', async () => {
    const { ctx, fiber } = await setup()
    const result = await call(ctx, 'memory_store', { content: '用户对花生过敏' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unexpected')
    const card = ctx.memoryStore.store.getCard((result.value as { id: string }).id)!
    expect(card.pinned).toBe(true)
    expect(card.sessionId).toBeNull()
    await fiber.dispose()
  })

  it('honours an explicit pinned=false and threads the caller session id', async () => {
    const { ctx, fiber } = await setup()
    const result = await call(ctx, 'memory_store',
      { content: '临时偏好', pinned: false }, agentWithSession('session-7'))
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unexpected')
    const card = ctx.memoryStore.store.getCard((result.value as { id: string }).id)!
    expect(card.pinned).toBe(false)
    expect(card.sessionId).toBe('session-7')
    await fiber.dispose()
  })

  it('summarizes a long first line with an ellipsis and keeps multi-line content', async () => {
    const { ctx, fiber } = await setup()
    const longLine = '长'.repeat(61)
    const result = await call(ctx, 'memory_store', { content: `${longLine}\n第二行` })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unexpected')
    const card = ctx.memoryStore.store.getCard((result.value as { id: string }).id)!
    expect(card.summary).toBe(`${'长'.repeat(60)}…`)
    expect(card.content).toContain('第二行')
    await fiber.dispose()
  })

  it('stores a commitment when type=commitment with a due date', async () => {
    const { ctx, fiber } = await setup()
    const result = await call(ctx, 'memory_store', {
      content: '周五前发报告', type: 'commitment', due: '2026-08-21T00:00:00.000Z',
    })
    expect(result.isError).toBe(false)
    expect((result as { value: { kind: string } }).value.kind).toBe('commitment')
    expect(ctx.memoryStore.store.activeCommitments()).toHaveLength(1)
    await fiber.dispose()
  })

  it('stores a commitment without a due date', async () => {
    const { ctx, fiber } = await setup()
    const result = await call(ctx, 'memory_store', { content: '保持周报节奏', type: 'commitment' })
    expect(result.isError).toBe(false)
    const [commitment] = ctx.memoryStore.store.activeCommitments()
    expect(commitment!.dueAt).toBeNull()
    await fiber.dispose()
  })

  it('memory_note appends to the scratchpad', async () => {
    const { ctx, fiber } = await setup()
    await call(ctx, 'memory_note', { text: '临时推断：用户可能在赶 deadline' })
    const notes = ctx.memoryStore.store.recentNotes(new Date(0).toISOString())
    expect(notes.map(n => n.text)).toEqual(['临时推断：用户可能在赶 deadline'])
    await fiber.dispose()
  })

  it('memory_note threads the caller session when present', async () => {
    const { ctx, fiber } = await setup()
    const result = await call(ctx, 'memory_note', { text: '带会话的便签' }, agentWithSession('session-9'))
    expect(result.isError).toBe(false)
    expect((result as { value: { noted: boolean } }).value.noted).toBe(true)
    const row = ctx.memoryStore.store.db
      .prepare('SELECT session_id FROM scratchpad WHERE text = ?').get('带会话的便签') as { session_id: string }
    expect(row.session_id).toBe('session-9')
    await fiber.dispose()
  })

  it('presents call cards for both tools', async () => {
    const { ctx, fiber } = await setup()
    const store = ctx.tools.get('memory_store')!.presentCall!({ content: 'x' })
    expect(store).toMatchObject({ title: 'Store memory' })
    const note = ctx.tools.get('memory_note')!.presentCall!({ text: 'x' })
    expect(note).toMatchObject({ title: 'Add note' })
    await fiber.dispose()
  })
})

describe('buildCommitmentsText', () => {
  it('renders active and overdue commitments with the overdue surfaced first', async () => {
    const { ctx, fiber } = await setup()
    const store = ctx.memoryStore.store
    store.addCommitment({ content: '过期约定', dueAt: '2020-01-01T00:00:00.000Z' })
    store.addCommitment({ content: '普通约定' })
    const text = buildCommitmentsText(store)
    expect(text).toContain('过期约定')
    expect(text.indexOf('过期约定')).toBeLessThan(text.indexOf('普通约定'))
    expect(text).toContain('到期')
    await fiber.dispose()
  })

  it('renders a future-due commitment with its deadline and no overdue marker', async () => {
    const { ctx, fiber } = await setup()
    ctx.memoryStore.store.addCommitment({ content: '未来约定', dueAt: '2999-01-01T00:00:00.000Z' })
    const text = buildCommitmentsText(ctx.memoryStore.store)
    expect(text).toContain('未来约定')
    expect(text).toContain('（期限 2999-01-01T00:00:00.000Z）')
    expect(text).not.toContain('【到期，请主动提起】')
    await fiber.dispose()
  })

  it('renders empty string when nothing is active', async () => {
    const { ctx, fiber } = await setup()
    expect(buildCommitmentsText(ctx.memoryStore.store)).toBe('')
    await fiber.dispose()
  })
})

describe('buildScratchpadText', () => {
  it('renders empty string when there are no recent notes', async () => {
    const { ctx, fiber } = await setup()
    expect(buildScratchpadText(ctx.memoryStore.store)).toBe('')
    await fiber.dispose()
  })

  it('renders recent notes as a bullet list', async () => {
    const { ctx, fiber } = await setup()
    ctx.memoryStore.store.addNote(null, '便签甲')
    const text = buildScratchpadText(ctx.memoryStore.store)
    expect(text).toContain('会话便签')
    expect(text).toContain('- 便签甲')
    await fiber.dispose()
  })
})

describe('prompt injection', () => {
  it('feeds commitments and scratchpad into the assembled prompt', async () => {
    const { ctx, fiber } = await setup()
    const store = ctx.memoryStore.store
    store.addCommitment({ content: '提醒用户复诊' })
    store.addNote(null, '用户今天语速很快')
    const snapshot = renderContextSnapshot(await ctx.systemPrompt.assemble())
    expect(snapshot).toContain('提醒用户复诊')
    expect(snapshot).toContain('用户今天语速很快')
    await fiber.dispose()
  })
})
