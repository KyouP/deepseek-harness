// packages/memory/memory-core/tests/salience.spec.ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openMemoryStore, type MemoryStore } from '@deepseek-ai/dsh-memory-store'
import type { LlmBackend } from '../src/llm.ts'
import { salienceScore, salienceTier } from '../src/salience.ts'
import { parseSedimentOutput, Sedimenter, type AgentLike, type SedimentConfig } from '../src/sediment.ts'

let dir = ''
let store: MemoryStore | undefined
afterEach(() => {
  store?.close()
  store = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

const CONFIG: SedimentConfig = {
  sedimentEnabled: true,
  sedimentMinChars: 240,
  sedimentDailyMax: 8,
  sedimentCooldownMinutes: 0,
}

const logger = { warn: vi.fn() }

function setup(llm: LlmBackend, config: SedimentConfig = CONFIG) {
  dir = mkdtempSync(join(tmpdir(), 'hmem-salience-'))
  store = openMemoryStore(join(dir, 't.db'))
  return new Sedimenter({ store, llm, config, logger })
}

function fakeLlm(outputs: (string | null)[]): LlmBackend {
  let i = 0
  return {
    name: 'fake',
    async complete(): Promise<string | null> {
      const out = outputs[Math.min(i, outputs.length - 1)] ?? null
      i++
      return out
    },
  }
}

/** A long-enough turn (>= 240 chars combined) so the size gate passes. */
function longEvents() {
  return [
    { type: 'user/message', data: { content: '长'.repeat(200) }, seq: 1 },
    { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: '答'.repeat(120) } }, seq: 2 },
  ]
}

function makeAgent(events: { type: string; data: unknown; seq: number }[]): AgentLike {
  return { session: { id: 's1', events } }
}

function recentNoteTexts(): string[] {
  const since = new Date(Date.now() - 3600_000).toISOString()
  return store!.recentNotes(since, 20).map(note => note.text)
}

describe('salienceScore', () => {
  it('weights 0.3·e + 0.3·n + 0.2·r + 0.2·x', () => {
    expect(salienceScore({ emotion: 1, novelty: 1, repeat: 1, explicit: 1 })).toBeCloseTo(1)
    expect(salienceScore({ emotion: 0, novelty: 0, repeat: 0, explicit: 0 })).toBe(0)
    expect(salienceScore({ emotion: 0.5, novelty: 1, repeat: 0, explicit: 0 })).toBeCloseTo(0.45)
    expect(salienceScore({ emotion: 1, novelty: 1, repeat: 1, explicit: 0 })).toBeCloseTo(0.8)
  })

  it('clamps out-of-range inputs into 0..1', () => {
    expect(salienceScore({ emotion: 2, novelty: -1, repeat: 0, explicit: 0 })).toBeCloseTo(0.3)
  })
})

describe('salienceTier', () => {
  it('drops below 0.3, scratchpads below 0.7, stores at 0.7+', () => {
    expect(salienceTier(0)).toBe('drop')
    expect(salienceTier(0.29)).toBe('drop')
    expect(salienceTier(0.3)).toBe('scratchpad')
    expect(salienceTier(0.69)).toBe('scratchpad')
    expect(salienceTier(0.7)).toBe('store')
    expect(salienceTier(1)).toBe('store')
  })
})

describe('parseSedimentOutput emo marker', () => {
  it('parses [CARD][emo:x] and defaults missing/invalid markers tolerantly', () => {
    const out = parseSedimentOutput('[CARD][emo:0.9] 主人考试通过了，特别开心\n[CARD] 无标记的旧格式\n[FACT] 主人 | 职业 | 工程师')
    expect(out).toEqual([
      { kind: 'card', content: '主人考试通过了，特别开心', emotion: 0.9 },
      { kind: 'card', content: '无标记的旧格式' },
      { kind: 'fact', content: '主人 | 职业 | 工程师' },
    ])
  })

  it('keeps content intact when the emo value is not numeric', () => {
    const out = parseSedimentOutput('[CARD][emo:abc] 原始内容')
    expect(out).toEqual([{ kind: 'card', content: '[emo:abc] 原始内容' }])
  })
})

describe('sediment salience gate', () => {
  it('stores a high-emo novel repeated card with computed salience and strength', async () => {
    const content = '主人考试通过了，特别开心'
    const llm = fakeLlm([`[CARD][emo:1.0] ${content}`])
    const sed = setup(llm)
    // repeat 信号：同内容 suggestion hits=3 → min(1, 3/3)=1
    store!.addSuggestion({ kind: 'card', content })
    store!.addSuggestion({ kind: 'card', content })
    store!.addSuggestion({ kind: 'card', content })

    expect(await sed.runOnce(makeAgent(longEvents()), 1)).toBe('stored')

    const cards = store!.recentCards(5)
    expect(cards).toHaveLength(1)
    // s = 0.3·1 + 0.3·1 + 0.2·1 + 0.2·0 = 0.8
    expect(cards[0]!.salience).toBeCloseTo(0.8)
    expect(cards[0]!.strength).toBeCloseTo(1 + 0.5 * 0.8)
    expect(recentNoteTexts()).not.toContain(content)
  })

  it('sends a mid-score card to the scratchpad instead of the card table', async () => {
    const content = '主人随口提到楼下新开的面馆'
    // 无 emo 标记 → 0.5；全新 → novelty 1；无 suggestion → repeat 0；s = 0.45
    const llm = fakeLlm([`[CARD] ${content}`])
    const sed = setup(llm)

    expect(await sed.runOnce(makeAgent(longEvents()), 1)).toBe('stored')

    expect(store!.recentCards(5)).toEqual([])
    expect(recentNoteTexts()).toContain(content)
  })

  it('drops a low-emo already-known card entirely', async () => {
    const content = '相同前缀的事件记录甲乙丙'
    const sed = setup(fakeLlm([`[CARD][emo:0.0] ${content}`]))
    // 三张同前缀旧卡 → novelty = 1/(1+3) = 0.25；emo 0 → s = 0.075 < 0.3
    for (let i = 0; i < 3; i++) {
      store!.insertCard({ summary: content, content: `${content} 已存${i}` })
    }

    expect(await sed.runOnce(makeAgent(longEvents()), 1)).toBe('stored')

    expect(store!.recentCards(10)).toHaveLength(3)
    expect(recentNoteTexts()).toEqual([])
  })
})
