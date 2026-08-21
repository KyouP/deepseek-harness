// packages/memory/memory-core/tests/consolidate.spec.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openMemoryStore, type MemoryStore } from '@deepseek-ai/dsh-memory-store'
import type { LlmBackend } from '../src/llm.ts'
import { Consolidator, type ConsolidateConfig, type SedimentRetrier } from '../src/consolidate.ts'

let dir = ''
let store: MemoryStore | undefined
afterEach(() => {
  store?.close()
  store = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

const CONFIG: ConsolidateConfig = { consolidateIdleMinutes: 30 }

const logger = { warn: vi.fn() }

const DAY_MS = 24 * 3600_000

function setup(
  llm: LlmBackend,
  config: ConsolidateConfig = CONFIG,
  sedimenter?: SedimentRetrier,
): Consolidator {
  dir = mkdtempSync(join(tmpdir(), 'hmem-consolidate-'))
  store = openMemoryStore(join(dir, 't.db'))
  return new Consolidator({ store, llm, config, logger, sedimenter })
}

function fakeLlm(outputs: (string | null)[]): LlmBackend & { calls: number } {
  let i = 0
  const backend = {
    name: 'fake',
    calls: 0,
    async complete(): Promise<string | null> {
      backend.calls++
      const out = outputs[Math.min(i, outputs.length - 1)] ?? null
      i++
      return out
    },
  }
  return backend
}

const NULL_LLM: LlmBackend = {
  name: 'null',
  async complete(): Promise<string | null> {
    return null
  },
}

/** Notes are stamped with `new Date()` on insert; backdate via the test-only db handle. */
function addNoteBackdated(text: string, ageMs: number): void {
  store!.addNote(null, text)
  const iso = new Date(Date.now() - ageMs).toISOString()
  store!.db.prepare('UPDATE scratchpad SET created_at = ? WHERE text = ?').run(iso, text)
}

function weekAgoIso(): string {
  return new Date(Date.now() - 7 * DAY_MS).toISOString()
}

function dayAgoIso(): string {
  return new Date(Date.now() - DAY_MS).toISOString()
}

describe('Consolidator', () => {
  it('distills old notes into cards then deletes them', async () => {
    const llm = fakeLlm(['[CARD] 主人怕吵'])
    const retryPending = vi.fn(async () => {})
    const consolidator = setup(llm, CONFIG, { retryPending })
    addNoteBackdated('便签一：楼下装修很吵', 2 * DAY_MS)
    addNoteBackdated('便签二：主人抱怨噪音', 2 * DAY_MS)
    addNoteBackdated('便签三：想买耳塞', 2 * DAY_MS)
    store!.addNote(null, '今天的便签')

    const report = await consolidator.run()

    expect(retryPending).toHaveBeenCalledTimes(1)
    expect(report.distilled).toBe(1)
    expect(store!.recentCards(5).map(card => card.summary)).toContain('主人怕吵')
    // 24h 前的旧便签清空，24h 内的便签保留
    expect(store!.notesBetween(weekAgoIso(), dayAgoIso())).toHaveLength(0)
    expect(store!.recentNotes(dayAgoIso(), 10).map(note => note.text)).toContain('今天的便签')
  })

  it('supersedes duplicate facts keeping the newest', async () => {
    const consolidator = setup(fakeLlm([]))
    const oldFact = store!.insertFact({ subject: '主人', predicate: '职业', object: '设计师' })
    const oldIso = new Date(Date.now() - 2 * DAY_MS).toISOString()
    store!.db.prepare('UPDATE facts SET recorded_at = ? WHERE id = ?').run(oldIso, oldFact.id)
    store!.insertFact({ subject: '主人', predicate: '职业', object: '工程师' })
    // 无关事实不受影响
    store!.insertFact({ subject: '主人', predicate: '城市', object: '上海' })

    const report = await consolidator.run()

    expect(report.superseded).toBe(1)
    // 只有新值留在 active 集里
    const active = store!.activeFacts('主人').filter(fact => fact.predicate === '职业')
    expect(active.length).toBeGreaterThan(0)
    expect(new Set(active.map(fact => fact.object))).toEqual(new Set(['工程师']))
    // 旧行 superseded_by 链到一条 active 的、取值最新的行
    const all = store!.dump().facts
    const retired = all.find(fact => fact.id === oldFact.id)
    expect(retired?.supersededBy).toBeTruthy()
    const target = all.find(fact => fact.id === retired?.supersededBy)
    expect(target?.object).toBe('工程师')
    expect(target?.supersededBy).toBeNull()
    expect(store!.activeFacts('主人').some(fact => fact.predicate === '城市' && fact.object === '上海')).toBe(true)
  })

  it('recompiles human block from approved user suggestions', async () => {
    const llm = fakeLlm(['初始画像\n主人喜欢简洁'])
    const consolidator = setup(llm)
    store!.setCoreBlock('human', '初始画像')
    const { suggestion } = store!.addSuggestion({ kind: 'user', content: '喜欢简洁' })
    store!.resolveSuggestion(suggestion.id, 'approved')
    // pending 建议不参与重编译
    store!.addSuggestion({ kind: 'user', content: '未批准的建议' })

    const report = await consolidator.run()

    expect(report.recompiled).toBe(true)
    expect(llm.calls).toBe(1)
    expect(store!.getCoreBlock('human')?.text).toBe('初始画像\n主人喜欢简洁')
    // 已消费的建议置 rejected；pending 原样保留
    expect(store!.listSuggestions('approved')).toHaveLength(0)
    expect(store!.listSuggestions('rejected').map(row => row.id)).toContain(suggestion.id)
    expect(store!.listSuggestions('pending')).toHaveLength(1)
  })

  it('skips gracefully when llm is null (nothing lost)', async () => {
    const consolidator = setup(NULL_LLM)
    addNoteBackdated('旧便签', 2 * DAY_MS)
    const { suggestion } = store!.addSuggestion({ kind: 'user', content: '喜欢简洁' })
    store!.resolveSuggestion(suggestion.id, 'approved')

    const report = await consolidator.run()

    expect(report).toEqual({ distilled: 0, superseded: 0, recompiled: false })
    // 便签保留、建议保留（下轮再试）
    expect(store!.notesBetween(weekAgoIso(), dayAgoIso())).toHaveLength(1)
    expect(store!.listSuggestions('approved')).toHaveLength(1)
    expect(store!.getCoreBlock('human')).toBeNull()
  })

  it('tick respects idle watermark and is reentry-safe', async () => {
    const llm = fakeLlm(['[CARD] 旧闻'])
    const consolidator = setup(llm)
    addNoteBackdated('旧便签', 2 * DAY_MS)

    // 5 分钟前还有活动，idle 阈值 30 分钟 → 不执行
    store!.setMeta('activity:last', new Date(Date.now() - 5 * 60_000).toISOString())
    expect(await consolidator.tick()).toBe(false)
    expect(llm.calls).toBe(0)

    // 静默 40 分钟 → 执行；并发的第二个 tick 被防重入挡下
    store!.setMeta('activity:last', new Date(Date.now() - 40 * 60_000).toISOString())
    const first = consolidator.tick()
    const second = consolidator.tick()
    expect(await second).toBe(false)
    expect(await first).toBe(true)
    expect(llm.calls).toBe(1)
    expect(store!.notesBetween(weekAgoIso(), dayAgoIso())).toHaveLength(0)
  })
})
