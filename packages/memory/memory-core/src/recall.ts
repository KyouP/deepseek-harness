/**
 * Multi-channel scored recall (FR-4.2/4.3/4.6): merges the FTS5 and trigram
 * card channels plus the fact LIKE channel into one ranked, floor-filtered
 * hit list. Every later recall surface (auto-injection, vector recall,
 * workspace scoping) builds on {@link rankedRecall}.
 *
 * Scoring: `score = α·bm25norm + γ·(strength/5) + δ·linkBoost + ε·recency
 * + pinBoost + salienceBoost`, with α=0.5, γ=0.2, δ=0.1, ε=0.1,
 * pinBoost=+0.15, salienceBoost=+0.1·salience, recency=exp(-days/30).
 * @module
 */

import type { Card, MemoryStore } from '@deepseek-ai/dsh-memory-store'

/** One ranked recall hit: either a card or a fact triple. */
export interface RankedHit {
  id: string
  kind: 'card' | 'fact'
  summary: string
  score: number
  /** Low-confidence fact, or the lone survivor kept under an all-below-floor batch. */
  uncertain: boolean
}

/** Options for {@link rankedRecall}. */
export interface RankedRecallOptions {
  /** Max returned hits (default 10). */
  limit?: number
  /** Minimum score; below-floor batches keep one uncertain survivor (default 0.05). */
  floor?: number
  /** Include archived cards; archived hits are revived after ranking. */
  deep?: boolean
  /** Current workspace id; only scored when `workspaceScope` is on. */
  workspace?: string | null
  /** Give same-workspace cards a small boost (full scoping lands in Task 20). */
  workspaceScope?: boolean
}

const ALPHA = 0.5
const GAMMA = 0.2
const DELTA = 0.1
const EPSILON = 0.1
const PIN_BOOST = 0.15
const SALIENCE_BOOST = 0.1
const WORKSPACE_BOOST = 0.1
const DEFAULT_LIMIT = 10
const DEFAULT_FLOOR = 0.05
/** Facts arrive through a LIKE channel with no rank signal: a fixed baseline. */
const FACT_BASELINE = 0.3
/** Confidence nudges a fact above its baseline; never below it. */
const FACT_CONFIDENCE_WEIGHT = 0.1
/** FR-3.4: facts less confident than this are marked uncertain. */
const FACT_UNCERTAIN_BELOW = 0.7
/** Recency decay horizon: score contribution halves roughly every 21 days. */
const RECENCY_DAYS = 30
/** FR-7.1 reinforcement half: how much an accessed card's strength grows. */
const ACCESS_BOOST = 0.1

interface Candidate {
  id: string
  summary: string
  /** Best (smallest) bm25 rank across channels; +Infinity for LIKE-fallback-only. */
  rank: number
  /** 1 when a top-5 hit links to this candidate. */
  linkBoost: number
}

/**
 * Rank every channel's hits for `query`.
 *
 * Fallback semantics: candidates whose ONLY evidence is the LIKE substring
 * fallback (rank +Infinity from both channels, no link boost) carry no ranking
 * signal at all and score exactly 0, so the relevance floor keeps them below
 * any real hit. When the WHOLE batch is below the floor (a weak-evidence-only
 * query, e.g. a mid-sentence CJK term), every hit is returned — up to `limit`,
 * each marked `uncertain: true` (FR-3.4 低置信标注) — instead of answering
 * nothing or collapsing v1.1's CJK multi-hit fallback to a single row.
 *
 * Side effects (documented, intentional): the final card hits are passed to
 * `touchCards(ids, 0.1)` — the reinforcement half of access-based strengthening
 * (FR-7.1) and the one deliberate read-path write — and, under `deep`, archived
 * hits are revived via `reviveCard`.
 */
export function rankedRecall(store: MemoryStore, query: string, opts: RankedRecallOptions = {}): RankedHit[] {
  const limit = opts.limit ?? DEFAULT_LIMIT
  const floor = opts.floor ?? DEFAULT_FLOOR
  if (!query.trim() || limit <= 0) return []
  const fetchLimit = Math.max(20, limit * 3)
  const searchOpts = { includeArchived: opts.deep ?? false }

  // Merge the FTS and trigram channels BEFORE normalization (same bm25 scale),
  // deduping by id and keeping the best (smallest) rank.
  const candidates = new Map<string, Candidate>()
  for (const hit of [
    ...store.searchCardsFts(query, fetchLimit, searchOpts),
    ...store.searchCardsTri(query, fetchLimit, searchOpts),
  ]) {
    const prev = candidates.get(hit.id)
    if (!prev || hit.rank < prev.rank) {
      candidates.set(hit.id, { id: hit.id, summary: hit.summary, rank: hit.rank, linkBoost: 0 })
    }
  }

  // bm25 ranks are negative, smaller (more negative) = better. The best rank
  // among the batch maps to norm 1 via rank/best (ratio in (0,1]); the LIKE
  // fallback's +Infinity maps to 0.
  let best = Number.POSITIVE_INFINITY
  for (const c of candidates.values()) if (c.rank < best) best = c.rank
  const bm25norm = (rank: number): number => {
    if (!Number.isFinite(rank) || !Number.isFinite(best)) return 0
    /* v8 ignore next -- bm25 ranks are strictly negative in practice; the 0 guard is spec-mandated defensiveness */
    return best === 0 ? 1 : rank / best
  }

  // Link boost: one-hop neighbors of the top-5 card candidates by bm25norm.
  // A neighbor that is not itself a search hit still enters as a candidate —
  // the link IS its channel evidence — with bm25norm 0 plus the δ boost.
  const top5 = [...candidates.values()]
    .sort((a, b) => bm25norm(b.rank) - bm25norm(a.rank) || a.id.localeCompare(b.id))
    .slice(0, 5)
  for (const top of top5) {
    for (const neighbor of store.linkedNeighbors(top.id, 5)) {
      const existing = candidates.get(neighbor.id)
      if (existing) existing.linkBoost = 1
      else candidates.set(neighbor.id, { id: neighbor.id, summary: neighbor.summary, rank: Number.POSITIVE_INFINITY, linkBoost: 1 })
    }
  }

  const now = Date.now()
  const cards = new Map<string, Card>()
  const scored: RankedHit[] = []
  for (const cand of candidates.values()) {
    const card = store.getCard(cand.id)
    /* v8 ignore next -- candidates come from card-table JOINs, so the row always exists */
    if (!card) continue
    cards.set(card.id, card)
    const fallbackOnly = !Number.isFinite(cand.rank) && cand.linkBoost === 0
    if (fallbackOnly) {
      scored.push({ id: card.id, kind: 'card', summary: card.summary, score: 0, uncertain: false })
      continue
    }
    const days = Math.max(0, (now - new Date(card.recordedAt).getTime()) / 864e5)
    let score = ALPHA * bm25norm(cand.rank)
      + GAMMA * (card.strength / 5)
      + DELTA * cand.linkBoost
      + EPSILON * Math.exp(-days / RECENCY_DAYS)
      + SALIENCE_BOOST * card.salience
    if (card.pinned) score += PIN_BOOST
    if (opts.workspaceScope && opts.workspace && card.workspace === opts.workspace) score += WORKSPACE_BOOST
    scored.push({ id: card.id, kind: 'card', summary: card.summary, score, uncertain: false })
  }

  // Facts join as hits with a LIKE-channel baseline score plus confidence
  // weighting — deliberately simple: the LIKE match already implies topical
  // relevance, confidence only orders facts among themselves.
  for (const fact of store.searchFacts(query, fetchLimit)) {
    scored.push({
      id: fact.id,
      kind: 'fact',
      summary: `${fact.subject} ${fact.predicate} → ${fact.object}`,
      score: FACT_BASELINE + FACT_CONFIDENCE_WEIGHT * fact.confidence,
      uncertain: fact.confidence < FACT_UNCERTAIN_BELOW,
    })
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))

  // Relevance floor: below-floor hits are dropped whenever at least one hit
  // clears the floor. When the whole batch is below it (weak-evidence-only
  // query), return ALL of them — up to limit — each marked uncertain, rather
  // than answering nothing or collapsing to a single row (v1.1 CJK fallback
  // must keep its multi-hit behavior; the uncertainty is surfaced via FR-3.4).
  let final = scored.filter(h => h.score >= floor)
  if (final.length === 0 && scored.length > 0) {
    final = scored.map(h => ({ ...h, uncertain: true }))
  }
  final = final.slice(0, limit)

  const finalCardIds = final.filter(h => h.kind === 'card').map(h => h.id)
  if (opts.deep) {
    for (const id of finalCardIds) {
      if (cards.get(id)!.archived) store.reviveCard(id)
    }
  }
  // The one intentional read-path write: access reinforcement (FR-7.1 强化半边).
  // Facts are derived rows, not strengthened entities — they are not touched.
  if (finalCardIds.length > 0) store.touchCards(finalCardIds, ACCESS_BOOST)
  return final
}
