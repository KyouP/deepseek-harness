/**
 * Export / backup / import tools (FR-2.8): `memory_export` serializes
 * `store.dump()` (the shared MemoryDump contract) to pretty JSON on disk;
 * `memory_import` reads such a file back into the store, deduplicating per
 * table — cards/facts/commitments/notes skip ids that already exist, links
 * use INSERT OR IGNORE, and core blocks never overwrite a local row unless
 * the incoming revision is strictly higher. Card inserts fire the FTS
 * triggers, so both FTS indexes stay in sync without a rebuild. Registered
 * inside the memory-core inject scope so it unloads with the store service.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { MemoryDump } from '@deepseek-ai/dsh-memory-store'
import type { MemoryStoreService } from './service.ts'

/** Tables carried by a MemoryDump, in dump key order. */
const TABLES = ['cards', 'facts', 'commitments', 'coreBlocks', 'notes', 'links'] as const
type TableKey = (typeof TABLES)[number]

interface ExportResult {
  ok: boolean
  error?: string
  path?: string
  counts?: Record<TableKey, number>
}

interface ImportResult {
  ok: boolean
  error?: string
  path?: string
  imported?: number
  skipped?: number
  tables?: Record<TableKey, { imported: number; skipped: number }>
}

function dumpCounts(dump: MemoryDump): Record<TableKey, number> {
  return {
    cards: dump.cards.length,
    facts: dump.facts.length,
    commitments: dump.commitments.length,
    coreBlocks: dump.coreBlocks.length,
    notes: dump.notes.length,
    links: dump.links.length,
  }
}

/**
 * Structural validation of a parsed export file. Returns an error string when
 * the value cannot be a MemoryDump; the caller aborts before touching the db
 * (parse-then-insert: a corrupt file yields no partial import).
 */
function validateDump(value: unknown): value is MemoryDump {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const known = TABLES.filter(key => key in record)
  if (known.length === 0) return false
  return known.every(key => Array.isArray(record[key]))
}

/**
 * Best-effort per-row import. Every table dedupes on its natural key inside
 * one transaction; a row that fails to insert counts as skipped so one bad
 * row cannot abort the rest. FTS stays in sync via the cards insert triggers.
 */
function importDump(service: MemoryStoreService, dump: MemoryDump): ImportResult {
  const db = service.store.db
  const tables = Object.fromEntries(
    TABLES.map(key => [key, { imported: 0, skipped: 0 }]),
  ) as Record<TableKey, { imported: number; skipped: number }>

  /** Run one insert, counting the outcome; unexpected row errors → skipped. */
  const apply = (table: TableKey, fn: () => number): void => {
    try {
      if (fn() > 0) tables[table].imported++
      else tables[table].skipped++
    } catch {
      tables[table].skipped++
    }
  }

  db.exec('BEGIN')
  try {
    const cardStmt = db.prepare(`
      INSERT OR IGNORE INTO cards (id, summary, content, context_desc, keywords, emotion,
        salience, strength, pinned, archived, session_id, workspace, valid_from, valid_to, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const card of dump.cards ?? []) {
      apply('cards', () => Number(cardStmt.run(
        card.id, card.summary, card.content, card.contextDesc ?? null,
        JSON.stringify(card.keywords ?? []), card.emotion ?? null,
        card.salience ?? 0, card.strength ?? 1, card.pinned ? 1 : 0, card.archived ? 1 : 0,
        card.sessionId ?? null, card.workspace ?? null, card.validFrom ?? null,
        card.validTo ?? null, card.recordedAt,
      ).changes))
    }

    const factStmt = db.prepare(`
      INSERT OR IGNORE INTO facts (id, subject, predicate, object, confidence, source_card,
        superseded_by, valid_from, valid_to, recorded_at, pinned)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const fact of dump.facts ?? []) {
      apply('facts', () => Number(factStmt.run(
        fact.id, fact.subject, fact.predicate, fact.object, fact.confidence ?? 1,
        fact.sourceCard ?? null, fact.supersededBy ?? null, fact.validFrom ?? null,
        fact.validTo ?? null, fact.recordedAt, fact.pinned ? 1 : 0,
      ).changes))
    }

    const commitmentStmt = db.prepare(`
      INSERT OR IGNORE INTO commitments (id, content, promisee, due_at, status, created_at, closed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const commitment of dump.commitments ?? []) {
      apply('commitments', () => Number(commitmentStmt.run(
        commitment.id, commitment.content, commitment.promisee ?? 'user',
        commitment.dueAt ?? null, commitment.status ?? 'active',
        commitment.createdAt, commitment.closedAt ?? null,
      ).changes))
    }

    const getBlock = db.prepare('SELECT revision FROM core_blocks WHERE name = ?')
    const insertBlock = db.prepare('INSERT INTO core_blocks (name, text, revision) VALUES (?, ?, ?)')
    const updateBlock = db.prepare('UPDATE core_blocks SET text = ?, revision = ? WHERE name = ?')
    for (const block of dump.coreBlocks ?? []) {
      apply('coreBlocks', () => {
        if (block.name !== 'persona' && block.name !== 'human') return 0
        const existing = getBlock.get(block.name) as { revision: number } | undefined
        if (!existing) return Number(insertBlock.run(block.name, block.text, block.revision ?? 1).changes)
        if ((block.revision ?? 0) > existing.revision) {
          return Number(updateBlock.run(block.text, block.revision, block.name).changes)
        }
        return 0
      })
    }

    const noteStmt = db.prepare('INSERT OR IGNORE INTO scratchpad (id, session_id, text, created_at) VALUES (?, NULL, ?, ?)')
    for (const note of dump.notes ?? []) {
      apply('notes', () => Number(noteStmt.run(note.id, note.text, note.createdAt).changes))
    }

    const linkStmt = db.prepare('INSERT OR IGNORE INTO links (src, dst, weight, created_at) VALUES (?, ?, ?, ?)')
    for (const link of dump.links ?? []) {
      apply('links', () => Number(linkStmt.run(link.src, link.dst, link.weight ?? 1, new Date().toISOString()).changes))
    }

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  const imported = TABLES.reduce((sum, key) => sum + tables[key].imported, 0)
  const skipped = TABLES.reduce((sum, key) => sum + tables[key].skipped, 0)
  return { ok: true, imported, skipped, tables }
}

const tableBreakdown = (tables: Record<TableKey, { imported: number; skipped: number }>) =>
  TABLES.map(key => `${key} +${tables[key].imported}/~${tables[key].skipped}`).join(', ')

/**
 * Register the backup tools: `memory_export` and `memory_import`.
 * @param ctx - inject scope carrying the tool registry.
 * @param service - the memory store service.
 */
export function registerExportTools(ctx: Context, service: MemoryStoreService): void {
  ctx.tools.register(defineTool({
    name: 'memory_export',
    description: 'Back up the entire memory store (cards, facts, commitments, core blocks, '
      + 'notes, links) to one JSON file. Defaults to $DSH_HOME/storages/hmem-export.json when '
      + 'no path is given; parent directories are created as needed. Returns the written path '
      + 'and per-table row counts.',
    parameters: {
      path: { type: 'string', description: 'Target JSON file path; defaults to the harness storages dir.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          path: { type: 'string' },
          counts: {
            type: 'object', additionalProperties: false,
            properties: Object.fromEntries(TABLES.map(key => [key, { type: 'number' as const }])),
          },
        },
      },
      render: (_args, value: ExportResult) => {
        if (!value.ok) return [{ type: 'text', text: `Error: ${value.error ?? 'unknown error'}` }]
        const counts = value.counts
        const detail = counts ? TABLES.map(key => `${counts[key]} ${key}`).join(', ') : ''
        return [{ type: 'text', text: `Exported ${detail} to ${value.path}.` }]
      },
    },
    async execute(args): Promise<ExportResult> {
      const target = (args.path as string | undefined) || join(dshHomePath('storages'), 'hmem-export.json')
      const dump = service.store.dump()
      try {
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, JSON.stringify(dump, null, 2), 'utf8')
      } catch (error) {
        return { ok: false, error: `export to ${target} failed: ${String(error)}` }
      }
      return { ok: true, path: target, counts: dumpCounts(dump) }
    },
    presentCall: args => ({ card: 'generic', title: 'Export memory backup', kind: 'other', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_import',
    description: 'Restore a memory backup written by memory_export. Rows that already exist are '
      + 'skipped (cards/facts/commitments/notes by id, links by pair); core blocks are only '
      + 'overwritten when the backup carries a higher revision. A corrupt or wrongly-shaped '
      + 'file errors without importing anything. Returns total and per-table imported/skipped counts.',
    parameters: {
      path: { type: 'string', required: true, description: 'The backup JSON file to restore from.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          error: { type: 'string' },
          path: { type: 'string' },
          imported: { type: 'number' },
          skipped: { type: 'number' },
          tables: {
            type: 'object', additionalProperties: false,
            properties: Object.fromEntries(TABLES.map(key => [key, {
              type: 'object' as const, additionalProperties: false,
              properties: {
                imported: { type: 'number' as const, required: true },
                skipped: { type: 'number' as const, required: true },
              },
            }])),
          },
        },
      },
      render: (_args, value: ImportResult) => {
        if (!value.ok) return [{ type: 'text', text: `Error: ${value.error ?? 'unknown error'}` }]
        return [{
          type: 'text',
          text: `Imported ${value.imported} rows (${value.skipped} skipped) from ${value.path}: ${tableBreakdown(value.tables!)}.`,
        }]
      },
    },
    async execute(args): Promise<ImportResult> {
      const path = args.path as string
      let raw: string
      try {
        raw = await readFile(path, 'utf8')
      } catch (error) {
        return { ok: false, error: `cannot read ${path}: ${String(error)}` }
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch (error) {
        return { ok: false, error: `cannot parse ${path} as JSON: ${String(error)}` }
      }
      if (!validateDump(parsed)) {
        return { ok: false, error: `${path} is not a memory export file (invalid shape)` }
      }
      try {
        return { ...importDump(service, parsed), path }
      } catch (error) {
        return { ok: false, error: `import from ${path} failed: ${String(error)}` }
      }
    },
    presentCall: args => ({ card: 'generic', title: 'Import memory backup', kind: 'other', rawInput: args }),
  }))
}
