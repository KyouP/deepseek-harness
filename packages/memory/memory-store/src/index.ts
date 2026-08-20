/**
 * H-MEM persistence layer: a single node:sqlite database holding M2 cards, M3
 * bi-temporal facts, links, commitments and M1 core blocks, with FTS5 over
 * cards. Raw card/fact rows are insert-only; only whitelisted derived columns
 * may update.
 * @module @deepseek-ai/dsh-memory-store
 */

import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SCHEMA_SQL } from './schema.ts'
import { migrate } from './migrations.ts'
import type {
  Card, CardSearchOptions, Commitment, CoreBlock, DerivedCardPatch, Fact, ForgetReport,
  MemoryDump, NewCard, NewCommitment, NewFact, NewSuggestion, Note, SearchHit,
  Suggestion,
} from './types.ts'

export type * from './types.ts'

/** Columns an UPDATE may touch on cards — everything else is immutable truth. */
const CARD_DERIVED_COLUMNS = new Set(['strength', 'archived', 'contextDesc'])

interface CardRow {
  id: string
  summary: string
  content: string
  context_desc: string | null
  keywords: string
  emotion: string | null
  salience: number
  strength: number
  pinned: number
  archived: number
  session_id: string | null
  workspace: string | null
  valid_from: string | null
  valid_to: string | null
  recorded_at: string
}

function toCard(row: CardRow): Card {
  return {
    id: row.id, summary: row.summary, content: row.content,
    contextDesc: row.context_desc, keywords: JSON.parse(row.keywords) as string[],
    emotion: row.emotion, salience: row.salience, strength: row.strength,
    pinned: row.pinned === 1, archived: row.archived === 1,
    sessionId: row.session_id, workspace: row.workspace ?? null,
    validFrom: row.valid_from, validTo: row.valid_to, recordedAt: row.recorded_at,
  }
}

interface FactRow {
  id: string
  subject: string
  predicate: string
  object: string
  confidence: number
  source_card: string | null
  superseded_by: string | null
  valid_from: string | null
  valid_to: string | null
  recorded_at: string
  pinned: number
}

function toFact(row: FactRow): Fact {
  return {
    id: row.id, subject: row.subject, predicate: row.predicate,
    object: row.object, confidence: row.confidence, sourceCard: row.source_card,
    supersededBy: row.superseded_by, validFrom: row.valid_from,
    validTo: row.valid_to, recordedAt: row.recorded_at,
    pinned: row.pinned === 1,
  }
}

interface CommitmentRow {
  id: string
  content: string
  promisee: string
  due_at: string | null
  status: Commitment['status']
  created_at: string
  closed_at: string | null
}

function toCommitment(row: CommitmentRow): Commitment {
  return {
    id: row.id, content: row.content, promisee: row.promisee, dueAt: row.due_at,
    status: row.status, createdAt: row.created_at, closedAt: row.closed_at,
  }
}

interface CoreBlockRow {
  name: 'persona' | 'human'
  text: string
  revision: number
}

interface NoteRow {
  id: string
  text: string
  created_at: string
}

function toNote(row: NoteRow): Note {
  return { id: row.id, text: row.text, createdAt: row.created_at }
}

interface SuggestionRow {
  id: string
  kind: Suggestion['kind']
  content: string
  hits: number
  status: Suggestion['status']
  first_seen: string
  last_seen: string
}

function toSuggestion(row: SuggestionRow): Suggestion {
  return {
    id: row.id, kind: row.kind, content: row.content, hits: row.hits,
    status: row.status, firstSeen: row.first_seen, lastSeen: row.last_seen,
  }
}

/** The H-MEM database handle. Methods are added by Tasks 2-4. */
export class MemoryStore {
  constructor(/** exposed for tests only */ readonly db: DatabaseSync) {}

  /** Table names in the main schema, for smoke tests. */
  listTables(): string[] {
    const rows = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','virtual table')")
      .all() as { name: string }[]
    return rows.map(r => r.name)
  }

  /** Close the underlying database. */
  close(): void {
    this.db.close()
  }

  /** Insert one immutable event card; FTS syncs via trigger. */
  insertCard(input: NewCard): Card {
    const id = randomUUID()
    const recordedAt = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO cards (id, summary, content, context_desc, keywords, emotion,
        salience, strength, pinned, session_id, workspace, valid_from, valid_to, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.summary, input.content, input.contextDesc ?? null,
      JSON.stringify(input.keywords ?? []), input.emotion ?? null,
      input.salience ?? 0, input.strength ?? 1, input.pinned ? 1 : 0,
      input.sessionId ?? null, input.workspace ?? null, input.validFrom ?? null,
      input.validTo ?? null, recordedAt,
    )
    return this.getCard(id) as Card
  }

  /** Fetch one card by id, or null. */
  getCard(id: string): Card | null {
    const row = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(id) as CardRow | undefined
    return row ? toCard(row) : null
  }

  /** Patch whitelisted derived columns only; anything else throws. */
  updateCardDerived(id: string, patch: DerivedCardPatch): void {
    for (const key of Object.keys(patch)) {
      if (!CARD_DERIVED_COLUMNS.has(key)) {
        throw new Error(`cards UPDATE whitelist violation: ${key}`)
      }
    }
    const sets: string[] = []
    const vals: (string | number | null)[] = []
    if (patch.strength !== undefined) { sets.push('strength = ?'); vals.push(patch.strength) }
    if (patch.archived !== undefined) { sets.push('archived = ?'); vals.push(patch.archived ? 1 : 0) }
    if (patch.contextDesc !== undefined) { sets.push('context_desc = ?'); vals.push(patch.contextDesc) }
    if (sets.length === 0) return
    vals.push(id)
    this.db.prepare(`UPDATE cards SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  }

  /**
   * Full-text search over live cards, bm25 ascending (most relevant first).
   * CJK queries get a substring fallback merged in: unicode61 treats a whole
   * CJK run as one token, so a word from the middle of a Chinese sentence
   * never prefix-matches the FTS index — LIKE has no such constraint.
   * `opts.includeArchived` widens every channel to archived cards (deep recall).
   */
  searchCardsFts(query: string, limit = 50, opts: CardSearchOptions = {}): SearchHit[] {
    // Prefix-match each token: unicode61 never splits CJK runs, so a query
    // like 深色模式 must match the longer indexed token 深色模式偏好.
    const live = opts.includeArchived ? '1 = 1' : 'c.archived = 0'
    const terms = query.split(/\s+/).filter(Boolean)
    const match = terms
      .map(t => `"${t.replace(/"/g, '')}"*`).join(' OR ')
    if (!match) return []
    const rows = this.db.prepare(`
      SELECT c.id AS id, c.summary AS summary, bm25(cards_fts) AS rank
      FROM cards_fts JOIN cards c ON c.rowid = cards_fts.rowid
      WHERE cards_fts MATCH ? AND ${live}
      ORDER BY rank LIMIT ?
    `).all(match, limit) as { id: string; summary: string; rank: number }[]
    if (!/[㐀-鿿豈-﫿]/.test(query) || rows.length >= limit) return rows
    const seen = new Set(rows.map(r => r.id))
    const like = terms.map(() => '(c.summary LIKE ? OR c.content LIKE ?)').join(' OR ')
    const params = terms.flatMap((t) => {
      const safe = `%${t.replace(/[%_]/g, '')}%`
      return [safe, safe]
    })
    const extra = this.db.prepare(`
      SELECT c.id AS id, c.summary AS summary FROM cards c
      WHERE ${live} AND (${like}) LIMIT ?
    `).all(...params, limit) as { id: string; summary: string }[]
    for (const row of extra.filter(r => !seen.has(r.id)).slice(0, limit - rows.length)) {
      rows.push({ id: row.id, summary: row.summary, rank: Number.POSITIVE_INFINITY })
    }
    return rows
  }

  /**
   * Substring search over live cards via the trigram FTS mirror. Unlike
   * searchCardsFts (unicode61 word matching + prefix), trigram matches any
   * infix of ≥3 characters, so mid-sentence CJK terms hit directly. Shorter
   * terms (common for two-character CJK words) cannot be trigram-indexed, so
   * they fall back to a LIKE substring scan, merged after FTS hits.
   * `opts.includeArchived` widens every channel to archived cards (deep recall).
   */
  searchCardsTri(query: string, limit = 50, opts: CardSearchOptions = {}): SearchHit[] {
    const live = opts.includeArchived ? '1 = 1' : 'c.archived = 0'
    const terms = query.split(/\s+/).filter(Boolean)
    const indexed = terms.filter(t => [...t].length >= 3)
    const short = terms.filter(t => [...t].length < 3)
    const rows: SearchHit[] = []
    if (indexed.length > 0) {
      const match = indexed.map(t => `"${t.replace(/"/g, '')}"`).join(' OR ')
      rows.push(...(this.db.prepare(`
        SELECT c.id AS id, c.summary AS summary, bm25(cards_fts_tri) AS rank
        FROM cards_fts_tri JOIN cards c ON c.rowid = cards_fts_tri.rowid
        WHERE cards_fts_tri MATCH ? AND ${live}
        ORDER BY rank LIMIT ?
      `).all(match, limit) as unknown as SearchHit[]))
    }
    if (short.length > 0 && rows.length < limit) {
      const seen = new Set(rows.map(r => r.id))
      const like = short
        .map(() => '(c.summary LIKE ? OR c.content LIKE ? OR c.keywords LIKE ?)').join(' OR ')
      const params = short.flatMap((t) => {
        const safe = `%${t.replace(/[%_]/g, '')}%`
        return [safe, safe, safe]
      })
      const extra = this.db.prepare(`
        SELECT c.id AS id, c.summary AS summary FROM cards c
        WHERE ${live} AND (${like}) LIMIT ?
      `).all(...params, limit) as { id: string; summary: string }[]
      for (const row of extra.filter(r => !seen.has(r.id)).slice(0, limit - rows.length)) {
        rows.push({ id: row.id, summary: row.summary, rank: Number.POSITIVE_INFINITY })
      }
    }
    return rows
  }

  /** Read one meta key, or null when unset. */
  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  /** Upsert one meta key. */
  setMeta(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value)
  }

  /** Link two cards; repeat links accumulate weight. */
  addLink(src: string, dst: string, weight = 1): void {
    this.db.prepare(`INSERT INTO links (src, dst, weight, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(src, dst) DO UPDATE SET weight = links.weight + excluded.weight`)
      .run(src, dst, weight, new Date().toISOString())
  }

  /** Live neighbors of a card across directed links, heaviest first. */
  linkedNeighbors(id: string, limit = 5): { id: string; summary: string; weight: number }[] {
    return this.db.prepare(`
      SELECT c.id AS id, c.summary AS summary, l.weight AS weight FROM links l
      JOIN cards c ON c.id = CASE WHEN l.src = ? THEN l.dst ELSE l.src END
      WHERE (l.src = ? OR l.dst = ?) AND c.archived = 0 ORDER BY l.weight DESC LIMIT ?
    `).all(id, id, id, limit) as { id: string; summary: string; weight: number }[]
  }

  /** Reinforce cards on access: strength += boost, capped at 5. */
  touchCards(ids: string[], boost = 0.1): void {
    const stmt = this.db.prepare('UPDATE cards SET strength = MIN(5, strength + ?) WHERE id = ?')
    for (const id of ids) stmt.run(boost, id)
  }

  /**
   * Settle exponential decay up to `referenceIso`. Incremental: Δt runs from
   * the later of the `decay:last` meta watermark and each card's recorded_at
   * (first run has no watermark and starts at recorded_at), so a second settle
   * at the same instant is a no-op and cards born after the watermark are not
   * over-decayed. Pinned and already-archived cards are spared; decay is
   * computed per-row in JS because node:sqlite does not guarantee math
   * functions like exp().
   */
  settleDecay(referenceIso: string, lambdaPerDay: number, archiveBelow: number): { decayed: number; archived: number } {
    const last = this.getMeta('decay:last') // 首次退化为逐卡 recorded_at
    const ref = new Date(referenceIso).getTime()
    const watermark = last ? new Date(last).getTime() : 0
    const rows = this.db.prepare(
      'SELECT id, strength, recorded_at FROM cards WHERE pinned = 0 AND archived = 0',
    ).all() as { id: string; strength: number; recorded_at: string }[]
    let decayed = 0, archived = 0
    for (const r of rows) {
      const from = Math.max(watermark, new Date(r.recorded_at).getTime())
      const days = Math.max(0, (ref - from) / 864e5)
      if (days === 0) continue
      const next = r.strength * Math.exp(-lambdaPerDay * days)
      decayed++
      if (next < archiveBelow) { this.updateCardDerived(r.id, { strength: next, archived: true }); archived++ }
      else this.updateCardDerived(r.id, { strength: next })
    }
    this.setMeta('decay:last', referenceIso)
    return { decayed, archived }
  }

  /** Un-archive a card, lifting its strength to at least 0.5. */
  reviveCard(id: string): void {
    const card = this.getCard(id)
    if (!card) return
    this.updateCardDerived(id, { archived: false, strength: Math.max(card.strength, 0.5) })
  }

  /** Live cards, newest first (rowid breaks recorded_at ties). */
  recentCards(limit = 20): Card[] {
    const rows = this.db.prepare(
      'SELECT * FROM cards WHERE archived = 0 ORDER BY recorded_at DESC, rowid DESC LIMIT ?',
    ).all(limit) as unknown as CardRow[]
    return rows.map(toCard)
  }

  /**
   * "On this day" cards for the session preheat: live cards whose recorded
   * month-day matches `todayIso`'s but that were recorded in an earlier year,
   * newest first. SQLite's strftime parses the stored ISO-8601 strings
   * directly, and the year comparison is a string compare of zero-padded
   * 4-digit years.
   */
  anniversaryCards(todayIso: string, limit = 5): Card[] {
    const rows = this.db.prepare(`
      SELECT * FROM cards
      WHERE archived = 0
        AND strftime('%m-%d', recorded_at) = strftime('%m-%d', ?)
        AND strftime('%Y', recorded_at) < strftime('%Y', ?)
      ORDER BY recorded_at DESC, rowid DESC LIMIT ?
    `).all(todayIso, todayIso, limit) as unknown as CardRow[]
    return rows.map(toCard)
  }

  /**
   * Pin or unpin one card. `pinned` is NOT in the CARD_DERIVED_COLUMNS
   * whitelist on purpose — pinning is a deliberate action (memory_pin tool)
   * and goes through this dedicated method instead of widening the whitelist,
   * the same rationale as setEmbedding.
   */
  setCardPinned(id: string, pinned: boolean): void {
    this.db.prepare('UPDATE cards SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
  }

  /**
   * Store one card's embedding as a raw float32 blob. `embedding` is NOT in
   * the CARD_DERIVED_COLUMNS whitelist on purpose — derived embeddings go
   * through this dedicated method instead of widening the whitelist.
   */
  setEmbedding(id: string, vector: number[]): void {
    this.db.prepare('UPDATE cards SET embedding = ? WHERE id = ?')
      .run(Buffer.from(new Float32Array(vector).buffer), id)
  }

  /** Live cards that have an embedding, decoded back to float32 vectors. */
  cardsWithEmbeddings(): { id: string; vector: number[] }[] {
    const rows = this.db.prepare(
      'SELECT id, embedding FROM cards WHERE embedding IS NOT NULL AND archived = 0',
    ).all() as unknown as { id: string; embedding: Uint8Array }[]
    return rows.map((r) => {
      // Copy to a fresh buffer: a pooled Uint8Array may be 4-byte-misaligned.
      const bytes = r.embedding.slice()
      return { id: r.id, vector: Array.from(new Float32Array(bytes.buffer)) }
    })
  }

  /** Live cards still missing an embedding, oldest first, as embeddable text. */
  cardsWithoutEmbeddings(limit = 20): { id: string; text: string }[] {
    return this.db.prepare(`
      SELECT id, summary || char(10) || content AS text FROM cards
      WHERE embedding IS NULL AND archived = 0
      ORDER BY recorded_at ASC, rowid ASC LIMIT ?
    `).all(limit) as { id: string; text: string }[]
  }

  /** Insert one immutable fact triple. */
  insertFact(input: NewFact): Fact {
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO facts (id, subject, predicate, object, confidence, source_card,
        valid_from, valid_to, recorded_at, pinned)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.subject, input.predicate, input.object, input.confidence ?? 1,
      input.sourceCard ?? null, input.validFrom ?? null, input.validTo ?? null,
      new Date().toISOString(), input.pinned ? 1 : 0,
    )
    return toFact(this.db.prepare('SELECT * FROM facts WHERE id = ?').get(id) as unknown as FactRow)
  }

  /** Replace a fact bi-temporally: the old row expires, never mutates in place. */
  supersedeFact(oldId: string, replacement: NewFact): Fact {
    this.db.exec('BEGIN')
    try {
      const next = this.insertFact(replacement)
      this.db.prepare('UPDATE facts SET valid_to = ?, superseded_by = ? WHERE id = ?')
        .run(new Date().toISOString(), next.id, oldId)
      this.db.exec('COMMIT')
      return next
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  /** Live (non-superseded) facts, optionally narrowed to one subject. */
  activeFacts(subject?: string): Fact[] {
    const rows = subject === undefined
      ? this.db.prepare('SELECT * FROM facts WHERE superseded_by IS NULL').all()
      : this.db.prepare('SELECT * FROM facts WHERE superseded_by IS NULL AND subject = ?').all(subject)
    return (rows as unknown as FactRow[]).map(toFact)
  }

  /** Substring search over active facts across subject/predicate/object. */
  searchFacts(query: string, limit = 50): Fact[] {
    const safe = `%${query.replace(/[%_]/g, '')}%`
    const rows = this.db.prepare(`
      SELECT * FROM facts WHERE superseded_by IS NULL
        AND (subject LIKE ? OR predicate LIKE ? OR object LIKE ?)
      ORDER BY recorded_at DESC, rowid DESC LIMIT ?
    `).all(safe, safe, safe, limit) as unknown as FactRow[]
    return rows.map(toFact)
  }

  /** Record one new active commitment. */
  /**
   * Add one open commitment. Idempotent for identical content: if an active
   * commitment with the same text already exists, it is returned instead of
   * inserting a duplicate (models re-store when a recall attempt fails).
   */
  addCommitment(input: NewCommitment): Commitment {
    const existing = this.db.prepare(
      "SELECT * FROM commitments WHERE status = 'active' AND content = ?",
    ).get(input.content) as unknown as CommitmentRow | undefined
    if (existing) return toCommitment(existing)
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO commitments (id, content, promisee, due_at, status, created_at)
      VALUES (?, ?, ?, ?, 'active', ?)
    `).run(id, input.content, input.promisee ?? 'user', input.dueAt ?? null, new Date().toISOString())
    return toCommitment(this.db.prepare('SELECT * FROM commitments WHERE id = ?').get(id) as unknown as CommitmentRow)
  }

  /**
   * Close one commitment with a terminal status. Only an active row may close:
   * the WHERE clause excludes anything already closed, so zero changes means
   * the id is unknown or already terminal and the call throws.
   */
  closeCommitment(id: string, status: 'done' | 'cancelled'): void {
    const changes = this.db.prepare(
      "UPDATE commitments SET status = ?, closed_at = ? WHERE id = ? AND status = 'active'",
    ).run(status, new Date().toISOString(), id).changes
    if (changes === 0) throw new Error(`no active commitment with id ${id}`)
  }

  /** Every commitment still open. */
  activeCommitments(): Commitment[] {
    const rows = this.db.prepare("SELECT * FROM commitments WHERE status = 'active'").all() as unknown as CommitmentRow[]
    return rows.map(toCommitment)
  }

  /** Active commitments whose deadline has passed by `now` (ISO string). */
  dueCommitments(now: string): Commitment[] {
    const rows = this.db
      .prepare("SELECT * FROM commitments WHERE status = 'active' AND due_at IS NOT NULL AND due_at <= ?")
      .all(now) as unknown as CommitmentRow[]
    return rows.map(toCommitment)
  }

  /**
   * Active commitments due after `nowIso` but within `withinHours`. Overdue
   * items are excluded on purpose — they are dueCommitments' job, and callers
   * union the two.
   */
  dueSoonCommitments(nowIso: string, withinHours: number): Commitment[] {
    const until = new Date(new Date(nowIso).getTime() + withinHours * 3600e3).toISOString()
    const rows = this.db.prepare(`
      SELECT * FROM commitments
      WHERE status = 'active' AND due_at IS NOT NULL AND due_at > ? AND due_at <= ?
      ORDER BY due_at ASC
    `).all(nowIso, until) as unknown as CommitmentRow[]
    return rows.map(toCommitment)
  }

  /** Read one M1 core block, or null when never written. */
  getCoreBlock(name: 'persona' | 'human'): CoreBlock | null {
    const row = this.db.prepare('SELECT * FROM core_blocks WHERE name = ?').get(name) as CoreBlockRow | undefined
    return row ?? null
  }

  /** Upsert one M1 core block, bumping its revision. */
  setCoreBlock(name: 'persona' | 'human', text: string): CoreBlock {
    this.db.prepare(`
      INSERT INTO core_blocks (name, text, revision) VALUES (?, ?, 1)
      ON CONFLICT(name) DO UPDATE SET text = excluded.text, revision = core_blocks.revision + 1
    `).run(name, text)
    return this.getCoreBlock(name) as CoreBlock
  }

  /** Append one scratchpad note for a session (or global when null). */
  addNote(sessionId: string | null, text: string): void {
    this.db.prepare('INSERT INTO scratchpad (id, session_id, text, created_at) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), sessionId, text, new Date().toISOString())
  }

  /** Notes created at or after `sinceIso`, oldest first, capped at `limit`. */
  recentNotes(sinceIso: string, limit = 20): Note[] {
    const rows = this.db.prepare(
      // rowid breaks created_at ties (millisecond resolution) deterministically.
      'SELECT id, text, created_at FROM scratchpad WHERE created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    ).all(sinceIso, limit) as unknown as NoteRow[]
    return rows.reverse().map(toNote)
  }

  /** Delete notes strictly older than `iso`; returns the deleted row count. */
  deleteNotesBefore(iso: string): number {
    return Number(this.db.prepare('DELETE FROM scratchpad WHERE created_at < ?').run(iso).changes)
  }

  /** Notes inside the [sinceIso, untilIso] window, oldest first, uncapped. */
  notesBetween(sinceIso: string, untilIso: string): Note[] {
    const rows = this.db.prepare(
      'SELECT id, text, created_at FROM scratchpad WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC, rowid ASC',
    ).all(sinceIso, untilIso) as unknown as NoteRow[]
    return rows.map(toNote)
  }

  /**
   * Queue one suggestion for review. The merge key is kind + content: a repeat
   * bumps hits and last_seen on the existing row and reports merged: true.
   */
  addSuggestion(input: NewSuggestion): { suggestion: Suggestion; merged: boolean } {
    const now = new Date().toISOString()
    const existing = this.db.prepare(
      'SELECT * FROM suggestions WHERE kind = ? AND content = ?',
    ).get(input.kind, input.content) as unknown as SuggestionRow | undefined
    if (existing) {
      this.db.prepare('UPDATE suggestions SET hits = hits + 1, last_seen = ? WHERE id = ?')
        .run(now, existing.id)
      const row = this.db.prepare('SELECT * FROM suggestions WHERE id = ?')
        .get(existing.id) as unknown as SuggestionRow
      return { suggestion: toSuggestion(row), merged: true }
    }
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO suggestions (id, kind, content, hits, status, first_seen, last_seen)
      VALUES (?, ?, ?, 1, 'pending', ?, ?)
    `).run(id, input.kind, input.content, now, now)
    const row = this.db.prepare('SELECT * FROM suggestions WHERE id = ?')
      .get(id) as unknown as SuggestionRow
    return { suggestion: toSuggestion(row), merged: false }
  }

  /** Suggestions, most-hit first; omit `status` to list every status. */
  listSuggestions(status?: Suggestion['status']): Suggestion[] {
    const rows = status === undefined
      ? this.db.prepare('SELECT * FROM suggestions ORDER BY hits DESC, last_seen DESC').all()
      : this.db.prepare(
        'SELECT * FROM suggestions WHERE status = ? ORDER BY hits DESC, last_seen DESC',
      ).all(status)
    return (rows as unknown as SuggestionRow[]).map(toSuggestion)
  }

  /** Mark one queued suggestion approved or rejected. */
  resolveSuggestion(id: string, status: 'approved' | 'rejected'): void {
    this.db.prepare('UPDATE suggestions SET status = ? WHERE id = ?').run(status, id)
  }

  /** Full snapshot of every store table, for export/backup. */
  dump(): MemoryDump {
    const cards = (this.db.prepare('SELECT * FROM cards ORDER BY rowid').all() as unknown as CardRow[])
      .map(toCard)
    const facts = (this.db.prepare('SELECT * FROM facts ORDER BY rowid').all() as unknown as FactRow[])
      .map(toFact)
    const commitments = (
      this.db.prepare('SELECT * FROM commitments ORDER BY rowid').all() as unknown as CommitmentRow[]
    ).map(toCommitment)
    const coreBlocks = this.db.prepare('SELECT * FROM core_blocks ORDER BY name').all() as unknown as CoreBlock[]
    const notes = (
      this.db.prepare('SELECT id, text, created_at FROM scratchpad ORDER BY rowid').all() as unknown as NoteRow[]
    ).map(toNote)
    const links = this.db.prepare('SELECT src, dst, weight FROM links ORDER BY src, dst').all() as
      { src: string; dst: string; weight: number }[]
    return { cards, facts, commitments, coreBlocks, notes, links }
  }

  /**
   * Precise forgetting: card + FTS (trigger) + derived facts + links, atomically.
   * Must not be called inside an outer transaction (uses BEGIN/COMMIT internally).
   */
  forgetCard(id: string): ForgetReport {
    this.db.exec('BEGIN')
    try {
      const facts = this.db.prepare('DELETE FROM facts WHERE source_card = ?').run(id).changes
      const links = this.db.prepare('DELETE FROM links WHERE src = ? OR dst = ?').run(id, id).changes
      const cards = this.db.prepare('DELETE FROM cards WHERE id = ?').run(id).changes
      this.db.exec('COMMIT')
      return { cards: Number(cards), facts: Number(facts), links: Number(links) }
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }
}

/**
 * Open (creating when absent) the H-MEM store at `path`, applying the schema.
 * @param path - database file path; parent directory is created when missing.
 * @returns the ready store.
 */
export function openMemoryStore(path: string): MemoryStore {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(SCHEMA_SQL)
  migrate(db)
  return new MemoryStore(db)
}
