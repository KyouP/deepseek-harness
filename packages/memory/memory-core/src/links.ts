// packages/memory/memory-core/src/links.ts
//
// 关键词共现自动建链（FR-2.4）：卡片入库后，从新卡文本里抽取关键词，逐词
// searchCardsTri 查邻居并累计共现次数，共现 ≥2 的邻居 addLink（weight=共现
// 数）。纯本地 SQLite，无 LLM；写路径同步调用，全程失败容忍（逐词/逐链包裹，
// 返回已建链数），绝不打断入库。
//
// 关键词抽取：CJK 连续段取 2-4 字滑动窗口高频项 + 拉丁词（≥4 字母小写），
// 去掉停用字/停用词；频次降序、同频短词优先（中文实词以二字为主）、再按出现
// 次序，默认取前 8。

import type { MemoryStore } from '@deepseek-ai/dsh-memory-store'

/** CJK 停用字：含任一停用字的窗口不作为关键词（虚字/代词/助词无区分度）。 */
export const CJK_STOP_CHARS: ReadonlySet<string> = new Set([
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们',
  '吗', '呢', '吧', '啊', '呀', '嘛', '么', '哦', '嗯', '哪',
  '和', '与', '也', '都', '很', '太', '不', '没', '就', '还',
  '又', '要', '会', '能', '可', '这', '那', '有', '些', '个',
  '之', '其', '及', '或', '但', '而', '且', '因', '所', '以',
  '为', '于', '把', '被', '让', '对', '从', '到', '向', '着',
  '过', '来', '去', '说', '什', '怎', '多', '少', '好', '最',
])

/** 拉丁停用词（≥4 字母的最小集合；<4 字母的词本就不会成为候选）。 */
export const LATIN_STOP_WORDS: ReadonlySet<string> = new Set([
  'this', 'that', 'with', 'from', 'have', 'been', 'were', 'what',
  'when', 'where', 'which', 'will', 'would', 'could', 'should', 'about',
  'they', 'them', 'then', 'than', 'your', 'yours', 'their', 'there',
  'here', 'just', 'like', 'some', 'more', 'most', 'other', 'into',
])

const CJK_RUN_RE = /[㐀-鿿豈-﫿]+/g
const LATIN_WORD_RE = /[A-Za-z]{4,}/g

interface Candidate {
  count: number
  firstIndex: number
  length: number
}

function addCandidate(map: Map<string, Candidate>, term: string, index: number): void {
  const existing = map.get(term)
  if (existing) existing.count++
  else map.set(term, { count: 1, firstIndex: index, length: [...term].length })
}

function hasStopChar(term: string): boolean {
  for (const char of term) if (CJK_STOP_CHARS.has(char)) return true
  return false
}

/**
 * Extract up to `max` (default 8) keywords from free text. CJK runs yield
 * 2-4 character sliding-window terms counted by frequency (any window holding
 * a stop character is dropped); Latin words of ≥4 letters are lowercased and
 * stop-word filtered. Ranking: frequency desc, then shorter terms first
 * (two-character words are the backbone of Chinese vocabulary), then first
 * occurrence order — deterministic for identical input.
 */
export function extractKeywords(text: string, max = 8): string[] {
  if (max <= 0 || !text) return []
  const candidates = new Map<string, Candidate>()
  let index = 0
  for (const run of text.matchAll(CJK_RUN_RE)) {
    const chars = [...run[0]]
    for (const size of [2, 3, 4]) {
      if (chars.length < size) continue
      for (let i = 0; i + size <= chars.length; i++) {
        const term = chars.slice(i, i + size).join('')
        if (!hasStopChar(term)) addCandidate(candidates, term, index++)
      }
    }
  }
  for (const match of text.matchAll(LATIN_WORD_RE)) {
    const word = match[0].toLowerCase()
    if (!LATIN_STOP_WORDS.has(word)) addCandidate(candidates, word, index++)
  }
  return [...candidates.entries()]
    .sort((a, b) =>
      b[1].count - a[1].count
      || a[1].length - b[1].length
      || a[1].firstIndex - b[1].firstIndex)
    .slice(0, max)
    .map(([term]) => term)
}

/**
 * Link a freshly stored card to neighbors sharing ≥2 extracted keywords.
 * Each keyword searches the trigram index (top 5); a neighbor's co-occurrence
 * count is the number of keyword searches it appears in, and becomes the link
 * weight. Per-keyword/per-link failures are swallowed so the write path never
 * breaks; returns the number of links created so far.
 */
export function autoLink(store: MemoryStore, cardId: string, text: string): number {
  const cooccurrence = new Map<string, number>()
  for (const keyword of extractKeywords(text)) {
    let hits: { id: string }[]
    try {
      hits = store.searchCardsTri(keyword, 5)
    } catch {
      continue // closed/broken store or FTS error: skip this keyword, keep going
    }
    for (const hit of hits) {
      if (hit.id === cardId) continue
      cooccurrence.set(hit.id, (cooccurrence.get(hit.id) ?? 0) + 1)
    }
  }
  let linked = 0
  for (const [otherId, count] of cooccurrence) {
    if (count < 2) continue
    try {
      store.addLink(cardId, otherId, count)
      linked++
    } catch {
      // duplicate/conflict or store failure is benign; keep the rest
    }
  }
  return linked
}
