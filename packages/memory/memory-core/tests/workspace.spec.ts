// packages/memory/memory-core/tests/workspace.spec.ts
//
// FR-2.9 多工作区作用域：写入侧给 cards 打 workspace 标签（session.header.cwd，
// 即 DSH 会话 API 真正暴露 cwd 的位置；requestHeader 只作兼容回退），召回侧在
// workspaceScope=true 且当前 cwd 已知时给同 workspace 卡 +0.1。保守退化：
// workspace 为 NULL 的卡（全局/旧数据）不罚不奖，cwd 未知时行为与开关关闭一致。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MemoryStore, openMemoryStore } from '@deepseek-ai/dsh-memory-store'
import * as memory from '../src/index.ts'
import { rankedRecall, type RankedHit } from '../src/recall.ts'
import { AutoRecall } from '../src/auto-recall.ts'
import { Sedimenter, type AgentLike } from '../src/sediment.ts'
import type { LlmBackend } from '../src/llm.ts'

const sig = new AbortController().signal
let dir = ''
let counter = 500
const stores: MemoryStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function memStore(): MemoryStore {
  const store = openMemoryStore(':memory:')
  stores.push(store)
  return store
}

/**
 * Two textually identical cards whose ONLY baseline difference is strength:
 * the other-workspace card (strength 2) outranks the same-workspace card
 * (strength 1) by 0.04 — less than the 0.1 workspace boost, so scoping flips
 * the order deterministically regardless of random card ids.
 */
function seedPair(store: MemoryStore) {
  const other = store.insertCard({
    summary: '烘焙温度记录', content: '烘焙温度记录 全文', strength: 2, workspace: '/ws/b',
  })
  const mine = store.insertCard({
    summary: '烘焙温度记录', content: '烘焙温度记录 全文', strength: 1, workspace: '/ws/a',
  })
  return { other, mine }
}

function scoreOf(hits: RankedHit[], id: string): number {
  return hits.find(h => h.id === id)?.score ?? Number.NaN
}

describe('rankedRecall workspace scoping (FR-2.9)', () => {
  it('scope on + known cwd: the same-workspace card ranks first', () => {
    const store = memStore()
    const { other, mine } = seedPair(store)
    const hits = rankedRecall(store, '烘焙温度', { workspaceScope: true, workspace: '/ws/a' })
    expect(hits.map(h => h.id)).toContain(mine.id)
    expect(hits[0]!.id).toBe(mine.id)
    expect(scoreOf(hits, mine.id)).toBeGreaterThan(scoreOf(hits, other.id))
  })

  it('scope off: workspace fields make no difference', () => {
    const store = memStore()
    const { other, mine } = seedPair(store)
    const baseline = rankedRecall(store, '烘焙温度')
    const scopedOff = rankedRecall(store, '烘焙温度', { workspace: '/ws/a' })
    // Identical relative order in both arms: the strength-2 card stays first.
    expect(baseline[0]!.id).toBe(other.id)
    expect(scopedOff[0]!.id).toBe(other.id)
    // Touching is symmetric, so the A-B differential is touch-proof: -0.04 both times.
    const baseDiff = scoreOf(baseline, mine.id) - scoreOf(baseline, other.id)
    const offDiff = scoreOf(scopedOff, mine.id) - scoreOf(scopedOff, other.id)
    expect(offDiff).toBeCloseTo(baseDiff, 10)
  })

  it('cwd unknown (null): behavior identical to scope off', () => {
    const store = memStore()
    const { other, mine } = seedPair(store)
    const off = rankedRecall(store, '烘焙温度', { workspaceScope: false })
    const nullCwd = rankedRecall(store, '烘焙温度', { workspaceScope: true, workspace: null })
    expect(nullCwd.map(h => h.id)).toEqual(off.map(h => h.id))
    expect(nullCwd[0]!.id).toBe(other.id)
    const offDiff = scoreOf(off, mine.id) - scoreOf(off, other.id)
    const nullDiff = scoreOf(nullCwd, mine.id) - scoreOf(nullCwd, other.id)
    expect(nullDiff).toBeCloseTo(offDiff, 10)
  })

  it('the boost is exactly +0.1 and NULL-workspace cards are never penalized', () => {
    const store = memStore()
    const { other, mine } = seedPair(store)
    // A global (NULL-workspace) card at the same strength as the other-ws card.
    const global = store.insertCard({
      summary: '烘焙温度记录', content: '烘焙温度记录 全文', strength: 2,
    })
    expect(global.workspace).toBeNull()
    const off = rankedRecall(store, '烘焙温度')
    const on = rankedRecall(store, '烘焙温度', { workspaceScope: true, workspace: '/ws/a' })
    // Differential of differentials isolates the boost: touching is symmetric.
    const offDiff = scoreOf(off, mine.id) - scoreOf(off, other.id)
    const onDiff = scoreOf(on, mine.id) - scoreOf(on, other.id)
    expect(onDiff - offDiff).toBeCloseTo(0.1, 10)
    // NULL workspace scores exactly like a different workspace: no bonus, no penalty.
    expect(scoreOf(on, global.id)).toBeCloseTo(scoreOf(on, other.id), 10)
    // A scope with no matching workspace is a no-op.
    const unknown = rankedRecall(store, '烘焙温度', { workspaceScope: true, workspace: '/ws/unknown' })
    expect(scoreOf(unknown, mine.id) - scoreOf(unknown, other.id)).toBeCloseTo(offDiff, 10)
  })
})

describe('AutoRecall workspace scoping', () => {
  const config = { recallAutoInject: true, recallBudgetChars: 1800, recallRelevanceFloor: 0.05 }
  const QUERY = '烘焙温度记录 今晚'

  function blockOrder(block: string, a: string, b: string): [number, number] {
    return [block.indexOf(a), block.indexOf(b)]
  }

  it('scope on + known cwd puts the same-workspace card first in the block', () => {
    const store = memStore()
    const { other, mine } = seedPair(store)
    const autoRecall = new AutoRecall(store, { ...config, workspaceScope: true })
    autoRecall.onPreStep([{ content: QUERY }], '/ws/a')
    const [minePos, otherPos] = blockOrder(autoRecall.render(), mine.id, other.id)
    expect(minePos).toBeGreaterThanOrEqual(0)
    expect(minePos).toBeLessThan(otherPos)
  })

  it('scope off or cwd null keeps the baseline order', () => {
    const store = memStore()
    const { other, mine } = seedPair(store)
    const scopedOff = new AutoRecall(store, { ...config, workspaceScope: false })
    scopedOff.onPreStep([{ content: QUERY }], '/ws/a')
    const nullCwd = new AutoRecall(store, { ...config, workspaceScope: true })
    nullCwd.onPreStep([{ content: QUERY }], null)
    const offOrder = blockOrder(scopedOff.render(), mine.id, other.id)
    const nullOrder = blockOrder(nullCwd.render(), mine.id, other.id)
    for (const [minePos, otherPos] of [offOrder, nullOrder]) {
      expect(minePos).toBeGreaterThanOrEqual(0)
      expect(otherPos).toBeGreaterThanOrEqual(0)
      expect(otherPos).toBeLessThan(minePos)
    }
  })
})

describe('sediment workspace tagging', () => {
  const logger = { warn: vi.fn() }

  function fakeLlm(output: string): LlmBackend {
    return { name: 'fake', complete: () => Promise.resolve(output) }
  }

  /** A long-enough turn (>= 240 chars combined) so the size gate passes. */
  function longEvents() {
    return [
      { type: 'user/message', data: { content: '长'.repeat(200) }, seq: 1 },
      { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '答'.repeat(120) } }, seq: 2 },
    ]
  }

  it('tags store-tier cards with session.header.cwd (the real DSH session API)', async () => {
    const store = memStore()
    const sedimenter = new Sedimenter({
      store,
      llm: fakeLlm('[CARD][emo:1.0] 主人最近在学钢琴'),
      config: { sedimentEnabled: true, sedimentMinChars: 240, sedimentDailyMax: 8, sedimentCooldownMinutes: 0 },
      logger,
    })
    // Two identical suggestions push the repeat term so salience reaches store tier.
    store.addSuggestion({ kind: 'card', content: '主人最近在学钢琴' })
    store.addSuggestion({ kind: 'card', content: '主人最近在学钢琴' })
    // Production shape: cwd lives on session.header; requestHeader (the folded
    // EpochHeader: config/system/tools) carries no cwd.
    const agent: AgentLike = {
      session: {
        id: 's1',
        events: longEvents(),
        header: { cwd: 'F:/proj' },
        requestHeader: () => undefined,
      },
    }
    expect(await sedimenter.runOnce(agent, 1)).toBe('stored')
    const cards = store.recentCards(5)
    expect(cards).toHaveLength(1)
    expect(cards[0]!.workspace).toBe('F:/proj')
  })

  it('leaves workspace NULL when the session exposes no cwd', async () => {
    const store = memStore()
    const sedimenter = new Sedimenter({
      store,
      llm: fakeLlm('[CARD][emo:1.0] 主人最近在学钢琴'),
      config: { sedimentEnabled: true, sedimentMinChars: 240, sedimentDailyMax: 8, sedimentCooldownMinutes: 0 },
      logger,
    })
    store.addSuggestion({ kind: 'card', content: '主人最近在学钢琴' })
    store.addSuggestion({ kind: 'card', content: '主人最近在学钢琴' })
    const agent: AgentLike = {
      session: { id: 's1', events: longEvents(), requestHeader: () => undefined },
    }
    expect(await sedimenter.runOnce(agent, 1)).toBe('stored')
    expect(store.recentCards(5)[0]!.workspace).toBeNull()
  })
})

describe('memory tool workspace wiring', () => {
  async function setup(config: Record<string, unknown> = {}) {
    dir = mkdtempSync(join(tmpdir(), 'hmem-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    // Disposing the fiber closes the store (Windows file lock) for cleanup.
    const fiber = await ctx.plugin(memory, { dbPath: join(dir, 'hmem.db'), ...config })
    return { ctx, fiber }
  }

  /** A parent Agent backed by a real Session whose header carries the cwd. */
  function agentWithCwd(cwd: string, id = 'ws-agent'): Agent {
    const session = Session.create(SessionId(id), [], {
      version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: Date.now(), cwd,
    })
    return { id: SessionId(id), session } as unknown as Agent
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

  it('memory_store tags the card with the caller session cwd', async () => {
    const { ctx, fiber } = await setup()
    const result = await call(ctx, 'memory_store', { content: '用户对花生过敏' }, agentWithCwd('/ws/tool'))
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unexpected')
    const card = ctx.memoryStore.store.getCard((result.value as { id: string }).id)!
    expect(card.workspace).toBe('/ws/tool')
    await fiber.dispose()
  })

  it('memory_store without an agent leaves workspace NULL', async () => {
    const { ctx, fiber } = await setup()
    const result = await call(ctx, 'memory_store', { content: '没有会话上下文的记忆' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('unexpected')
    const card = ctx.memoryStore.store.getCard((result.value as { id: string }).id)!
    expect(card.workspace).toBeNull()
    await fiber.dispose()
  })

  it('memory_recall applies the workspace boost when workspaceScope is configured', async () => {
    const { ctx, fiber } = await setup({ workspaceScope: true })
    const { other, mine } = seedPair(ctx.memoryStore.store)
    const result = await call(ctx, 'memory_recall', { query: '烘焙温度' }, agentWithCwd('/ws/a'))
    expect(result.isError).toBe(false)
    const value = (result as { value: { results: { id: string }[] } }).value
    expect(value.results.map(r => r.id)).toContain(mine.id)
    expect(value.results[0]!.id).toBe(mine.id)
    expect(value.results.map(r => r.id)).toContain(other.id)
    await fiber.dispose()
  })

  it('memory_recall ignores workspaces when workspaceScope is off (default)', async () => {
    const { ctx, fiber } = await setup()
    const { other, mine } = seedPair(ctx.memoryStore.store)
    const result = await call(ctx, 'memory_recall', { query: '烘焙温度' }, agentWithCwd('/ws/a'))
    expect(result.isError).toBe(false)
    const value = (result as { value: { results: { id: string }[] } }).value
    expect(value.results[0]!.id).toBe(other.id)
    expect(value.results.map(r => r.id)).toContain(mine.id)
    await fiber.dispose()
  })

  it('memory_suggestions approve lands the card with the caller session cwd', async () => {
    const { ctx, fiber } = await setup()
    const store = ctx.memoryStore.store
    store.addSuggestion({ kind: 'card', content: '批准一张带工作区标签的卡' })
    const [pending] = store.listSuggestions('pending')
    const result = await call(ctx, 'memory_suggestions',
      { action: 'approve', id: pending!.id }, agentWithCwd('/ws/approve'))
    expect(result.isError).toBe(false)
    const value = (result as { value: { ok: boolean; landedId?: string } }).value
    expect(value.ok).toBe(true)
    expect(store.getCard(value.landedId!)!.workspace).toBe('/ws/approve')
    await fiber.dispose()
  })
})
