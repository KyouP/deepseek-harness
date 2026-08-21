// packages/memory/memory-core/tests/review.spec.ts
// Periodic sticky review (FR-8.0) against a REAL in-memory store; only the
// cordis ctx is faked (tools.register captures the definitions), so the
// suggest/done tools run through the genuine SQL paths. Turn counting is
// driven by calling onTurn directly — no fake agent needed.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { MemoryStore, openMemoryStore } from '@deepseek-ai/dsh-memory-store'
import type { MemoryStoreService } from '../src/service.ts'
import { TurnReview, isSubagentAgent } from '../src/review.ts'
import { registerReviewTools } from '../src/tools-review.ts'

let store: MemoryStore

beforeEach(() => { store = openMemoryStore(':memory:') })
afterEach(() => { store.close() })

describe('TurnReview', () => {
  it('marks due after reviewIntervalTurns top-level turns', () => {
    const review = new TurnReview(store, { reviewIntervalTurns: 5 })
    for (let i = 0; i < 4; i++) review.onTurn('s1')
    expect(review.renderDue()).toBe('')
    review.onTurn('s1')
    expect(review.renderDue()).toContain('记忆审查已到期')
  })

  it('counts turns cross-session on the persistent meta counter', () => {
    const review = new TurnReview(store, { reviewIntervalTurns: 3 })
    review.onTurn('s1')
    review.onTurn('s2')
    expect(review.renderDue()).toBe('')
    review.onTurn('s3')
    expect(review.renderDue()).toContain('记忆审查已到期')
    expect(store.getMeta('review:turns')).toBe('0')
  })

  it('renderDue is sticky until memory_review_done', () => {
    const review = new TurnReview(store, { reviewIntervalTurns: 2 })
    review.onTurn('s1')
    review.onTurn('s1')
    expect(review.renderDue()).toContain('记忆审查已到期')
    expect(review.renderDue()).toContain('记忆审查已到期')
    review.complete()
    expect(review.renderDue()).toBe('')
    // complete resets the counter too: a fresh interval must elapse.
    review.onTurn('s1')
    expect(review.renderDue()).toBe('')
    review.onTurn('s1')
    expect(review.renderDue()).toContain('记忆审查已到期')
  })

  it('review can be disabled', () => {
    const review = new TurnReview(store, { reviewEnabled: false, reviewIntervalTurns: 1 })
    review.onTurn('s1')
    review.onTurn('s1')
    expect(review.renderDue()).toBe('')
    expect(store.getMeta('review:due')).toBeNull()
  })

  it('survives a closed store without throwing', () => {
    // Local store: the shared one must stay open for afterEach cleanup.
    const closed = openMemoryStore(':memory:')
    const review = new TurnReview(closed, { reviewIntervalTurns: 1 })
    closed.close()
    expect(() => { review.onTurn('s1') }).not.toThrow()
    expect(review.renderDue()).toBe('')
    expect(() => { review.complete() }).not.toThrow()
  })
})

describe('isSubagentAgent', () => {
  it('detects subagents from session.header (production SessionHeader shape)', () => {
    // Production: requestHeader() folds the EpochHeader (config/system/tools) —
    // it carries neither origin nor parentSession; both live on session.header.
    const epoch = { config: { provider: 'p', model: 'm' }, system: 'sys', tools: [] }
    const subByOrigin = { session: { id: 'a', events: [], header: { origin: 'subagent' }, requestHeader: () => epoch } }
    const subByParent = { session: { id: 'b', events: [], header: { parentSession: 'p' }, requestHeader: () => epoch } }
    const topLevel = { session: { id: 'c', events: [], header: { cwd: '/x' }, requestHeader: () => epoch } }
    const noHeader = { session: { id: 'd', events: [] } }
    expect(isSubagentAgent(subByOrigin)).toBe(true)
    expect(isSubagentAgent(subByParent)).toBe(true)
    expect(isSubagentAgent(topLevel)).toBe(false)
    expect(isSubagentAgent(noHeader)).toBe(false)
    expect(isSubagentAgent(undefined)).toBe(false)
  })

  it('still honors legacy doubles that carry origin on the folded requestHeader', () => {
    const subByOrigin = { session: { id: 'a', events: [], requestHeader: () => ({ origin: 'subagent' }) } }
    const subByParent = { session: { id: 'b', events: [], requestHeader: () => ({ parentSession: 'p' }) } }
    const topLevel = { session: { id: 'c', events: [], requestHeader: () => ({ origin: 'user' }) } }
    expect(isSubagentAgent(subByOrigin)).toBe(true)
    expect(isSubagentAgent(subByParent)).toBe(true)
    expect(isSubagentAgent(topLevel)).toBe(false)
  })
})

describe('review tools', () => {
  let tools: Map<string, ToolDefinition>
  let review: TurnReview
  const exec = {} as ToolRunContext

  beforeEach(() => {
    tools = new Map()
    review = new TurnReview(store, { reviewIntervalTurns: 1 })
    const ctx = {
      tools: { register: (def: ToolDefinition) => { tools.set(def.name, def) } },
    } as unknown as Context
    const service = { store } as unknown as MemoryStoreService
    registerReviewTools(ctx, service, review)
  })

  it('registers memory_suggest and memory_review_done', () => {
    expect([...tools.keys()].sort()).toEqual(['memory_review_done', 'memory_suggest'])
  })

  it('memory_suggest dedupes into hits', async () => {
    const first = await tools.get('memory_suggest')!
      .execute({ kind: 'user', content: '用户喜欢简洁回复' }, exec) as { suggestionId: string; hits: number; status: string }
    expect(first.hits).toBe(1)
    expect(first.status).toBe('pending')
    const second = await tools.get('memory_suggest')!
      .execute({ kind: 'user', content: '用户喜欢简洁回复' }, exec) as { suggestionId: string; hits: number; status: string }
    expect(second.hits).toBe(2)
    expect(second.suggestionId).toBe(first.suggestionId)
  })

  it('memory_review_done completes the review', async () => {
    review.onTurn('s1')
    expect(review.renderDue()).toContain('记忆审查已到期')
    const out = await tools.get('memory_review_done')!.execute({}, exec) as { done: boolean }
    expect(out.done).toBe(true)
    expect(review.renderDue()).toBe('')
  })
})
