// packages/memory/memory-core/tests/preheat.spec.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { openMemoryStore, type MemoryStore } from '@deepseek-ai/dsh-memory-store'
import { Preheat, mountPreheat } from '../src/preheat.ts'
import { TRUNCATION_MARKER } from '../src/budget.ts'

let dir = ''
let store: MemoryStore | null = null

function setup(): MemoryStore {
  dir = mkdtempSync(join(tmpdir(), 'hmem-preheat-'))
  store = openMemoryStore(join(dir, 'hmem.db'))
  return store
}

afterEach(() => {
  store?.close()
  store = null
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

/** Insert a card whose recorded_at is today's month-day, `yearsAgo` years back. */
function seedAnniversaryCard(store: MemoryStore, summary: string, yearsAgo = 1): void {
  const card = store.insertCard({ summary, content: `${summary} 的全文` })
  const recorded = new Date()
  recorded.setUTCFullYear(recorded.getUTCFullYear() - yearsAgo)
  store.db.prepare('UPDATE cards SET recorded_at = ? WHERE id = ?').run(recorded.toISOString(), card.id)
}

describe('Preheat', () => {
  it('renders due commitments, recent topics and anniversaries once per session', () => {
    const store = setup()
    store.addCommitment({ content: '两天内交报告', dueAt: new Date(Date.now() + 24 * 3600e3).toISOString() })
    store.addCommitment({ content: '上周该回的邮件', dueAt: new Date(Date.now() - 3600e3).toISOString() })
    store.insertCard({ summary: '深色模式偏好', content: '用户偏好深色模式' })
    seedAnniversaryCard(store, '去年今天开始的日记')

    const preheat = new Preheat(store, {})
    // An unmarked session renders nothing.
    expect(preheat.render('s9')).toBe('')

    preheat.markSession('s1')
    const first = preheat.render()
    expect(first).toContain('两天内交报告')
    expect(first).toContain('上周该回的邮件')
    expect(first).toContain('深色模式偏好')
    expect(first).toContain('年前的今天')
    expect(first).toContain('去年今天开始的日记')
    // One-shot: the same session does not preheat twice.
    expect(preheat.render()).toBe('')
    // A new session id renders again.
    preheat.markSession('s2')
    const second = preheat.render()
    expect(second).toContain('两天内交报告')
    expect(preheat.render()).toBe('')
  })

  it('renders empty when nothing to preheat', () => {
    const store = setup()
    const preheat = new Preheat(store, {})
    preheat.markSession('s1')
    expect(preheat.render()).toBe('')
  })

  it('respects preheatBudgetChars', () => {
    const store = setup()
    for (let i = 0; i < 5; i++) {
      store.insertCard({ summary: `话题${i}${'长'.repeat(120)}`, content: '正文' })
    }
    const budget = 200
    const preheat = new Preheat(store, { preheatBudgetChars: budget })
    preheat.markSession('s1')
    const text = preheat.render()
    expect(text).not.toBe('')
    expect(text.length).toBeLessThanOrEqual(budget + TRUNCATION_MARKER.length)
    expect(text).toContain(TRUNCATION_MARKER)
  })
})

describe('mountPreheat', () => {
  it('marks sessions on agent/session-start and renders once through the provider', () => {
    const store = setup()
    store.addCommitment({ content: '预热里的承诺', dueAt: new Date(Date.now() + 3600e3).toISOString() })

    const registrations: { name: string; order: number; text: () => string }[] = []
    const listeners: Record<string, (payload: unknown) => void> = {}
    const fakeCtx = {
      systemPrompt: { context: (r: { name: string; order: number; text: () => string }) => { registrations.push(r) } },
      on: (event: string, listener: (payload: unknown) => void) => { listeners[event] = listener },
      logger: { warn: () => {} },
    }
    mountPreheat(fakeCtx as unknown as Context, store, {})

    const provider = registrations.find(r => r.name === 'hmem:preheat')
    expect(provider).toBeDefined()
    expect(provider!.order).toBe(12)
    expect(listeners['agent/session-start']).toBeDefined()

    // Before any session-start, the provider renders nothing.
    expect(provider!.text()).toBe('')
    listeners['agent/session-start']!({ agent: { session: { id: 's1' } } })
    expect(provider!.text()).toContain('预热里的承诺')
    expect(provider!.text()).toBe('')
  })
})
