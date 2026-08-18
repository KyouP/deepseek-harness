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
import type {
  Card, Commitment, CoreBlock, DerivedCardPatch, Fact, ForgetReport,
  NewCard, NewCommitment, NewFact, SearchHit,
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
    sessionId: row.session_id, validFrom: row.valid_from,
    validTo: row.valid_to, recordedAt: row.recorded_at,
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

/** One scratchpad note. */
export interface Note {
  id: string
  text: string
  createdAt: string
}

interface NoteRow {
  id: string
  text: string
  created_at: string
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
        salience, strength, pinned, session_id, valid_from, valid_to, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.summary, input.content, input.contextDesc ?? null,
      JSON.stringify(input.keywords ?? []), input.emotion ?? null,
      input.salience ?? 0, input.strength ?? 1, input.pinned ? 1 : 0,
      input.sessionId ?? null, input.validFrom ?? null, input.validTo ?? null,
      recordedAt,
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

  /** Full-text search over live cards, bm25 ascending (most relevant first). */
  searchCardsFts(query: string, limit = 50): SearchHit[] {
    // Prefix-match each token: unicode61 never splits CJK runs, so a query
    // like 深色模式 must match the longer indexed token 深色模式偏好.
    const match = query.split(/\s+/).filter(Boolean)
      .map(t => `"${t.replace(/"/g, '')}"*`).join(' OR ')
    if (!match) return []
    const rows = this.db.prepare(`
      SELECT c.id AS id, c.summary AS summary, bm25(cards_fts) AS rank
      FROM cards_fts JOIN cards c ON c.rowid = cards_fts.rowid
      WHERE cards_fts MATCH ? AND c.archived = 0
      ORDER BY rank LIMIT ?
    `).all(match, limit) as { id: string; summary: string; rank: number }[]
    return rows
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

  /** Record one new active commitment. */
  addCommitment(input: NewCommitment): Commitment {
    const id = randomUUID()
    this.db.prepare(`
      INSERT INTO commitments (id, content, promisee, due_at, status, created_at)
      VALUES (?, ?, ?, ?, 'active', ?)
    `).run(id, input.content, input.promisee ?? 'user', input.dueAt ?? null, new Date().toISOString())
    return toCommitment(this.db.prepare('SELECT * FROM commitments WHERE id = ?').get(id) as unknown as CommitmentRow)
  }

  /** Close one commitment with a terminal status. */
  closeCommitment(id: string, status: 'done' | 'cancelled'): void {
    this.db.prepare('UPDATE commitments SET status = ?, closed_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id)
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
    return rows.reverse().map(r => ({ id: r.id, text: r.text, createdAt: r.created_at }))
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
  return new MemoryStore(db)
}
