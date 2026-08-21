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
  // 固定在本地正午再回拨年份：anniversaryCards 用 strftime('%m-%d', recorded_at)
  // 按 UTC 月-日匹配、而 today 来自 localToday() 本地月-日——正午时刻两种历法的
  // 日期一致（本地 0-8 点 UTC+8 时 direct "now" 会错一天，造成夜间 TZ flake）。
  const recorded = new Date()
  recorded.setHours(12, 0, 0, 0)
  recorded.setFullYear(recorded.getFullYear() - yearsAgo)
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

describe('anniversaryCards local date', () => {
  // recorded_at is stored as a UTC ISO string and strftime matches its stored
  // calendar date verbatim — so the METHOD contract is "returns cards whose
  // stored MM-DD equals the given date, from earlier years", and it is the
  // caller's job (preheat.localToday) to pass the LOCAL today as YYYY-MM-DD.
  // For a UTC+8 user at local 02:00 on the 21st, UTC is still the 20th;
  // passing the UTC date would surface the wrong anniversaries.
  it('matches cards by the given date string, earlier years only', () => {
    const store = setup()
    const card = store.insertCard({ summary: '凌晨记下的约定', content: 'x' })
    store.db.prepare('UPDATE cards SET recorded_at = ? WHERE id = ?')
      .run('2025-08-20T18:00:00.000Z', card.id)

    expect(store.anniversaryCards('2026-08-20').map(c => c.id)).toContain(card.id)
    expect(store.anniversaryCards('2026-08-21').map(c => c.id)).not.toContain(card.id)
    expect(store.anniversaryCards('2026-08-19').map(c => c.id)).not.toContain(card.id)
    // Same-year recordings are never anniversaries, even on the matching day.
    const fresh = store.insertCard({ summary: '今年今天的卡', content: 'y' })
    store.db.prepare('UPDATE cards SET recorded_at = ? WHERE id = ?')
      .run('2026-08-20T01:00:00.000Z', fresh.id)
    expect(store.anniversaryCards('2026-08-20').map(c => c.id)).not.toContain(fresh.id)
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
