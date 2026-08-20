/**
 * M4 deep-time recall (FR-2.7/FR-10.3): parse and browse raw session
 * transcripts archived under `$DSH_HOME/sessions/<project>/<sid>/session.jsonl`.
 * Compressed `.zstd` artifacts are skipped (counted in `skippedZstd`) until a
 * decoder is wired in. All filesystem failures degrade to warnings — browsing
 * the archive never throws.
 * @module
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** One conversation message extracted from a session transcript. */
export interface SessionMessage { role: 'user' | 'assistant'; text: string }

/** A parsed session archive: header metadata plus the plain-text message flow. */
export interface ParsedSession {
  id: string
  /** ISO timestamp; numeric epoch-ms headers are converted, strings kept unchanged. */
  createdAt: string
  cwd: string | null
  messages: SessionMessage[]
}

/** Options for {@link browseSessions}. */
export interface BrowseSessionsOptions {
  /** Return only the session with this id (at most one element). */
  sessionId?: string
  /** ISO lower bound on header createdAt (inclusive). */
  since?: string
  /** ISO upper bound on header createdAt (inclusive). */
  until?: string
  /** Max sessions returned by a listing; default {@link DEFAULT_BROWSE_LIMIT}. */
  limit?: number
  /** Warning sink for degraded filesystem reads; silent when omitted. */
  logger?: { warn(message: string): void }
}

/** Result of {@link browseSessions}: matched sessions plus the compressed-archive skip count. */
export interface BrowseSessionsResult {
  sessions: ParsedSession[]
  skippedZstd: number
}

/** Default listing cap for {@link browseSessions}. */
export const DEFAULT_BROWSE_LIMIT = 20

/** Extract the text of a `user/message` content payload (string or ContentBlock[]). */
function extractUserText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (
      typeof block === 'object' && block !== null
      && (block as { type?: unknown }).type === 'text'
      && typeof (block as { text?: unknown }).text === 'string'
    ) {
      out += (block as { text: string }).text
    }
  }
  return out
}

/**
 * Parse one plaintext session JSONL transcript into header metadata and the
 * user/assistant text flow. The first line must be a `session` header record
 * (anything else → `null`); later corrupt lines are skipped. Sequential
 * `assistant/chunk` text-deltas (and packed `text-chunks` rows) merge into one
 * assistant message; other record types are ignored.
 * @param text - full contents of a `session.jsonl` file.
 * @returns the parsed session, or `null` when the header line is not a session record.
 */
export function parseSessionJsonl(text: string): ParsedSession | null {
  const lines = text.split('\n')
  let header: unknown
  try {
    header = JSON.parse((lines[0] ?? '').trim())
  } catch {
    return null
  }
  if (typeof header !== 'object' || header === null || (header as { type?: unknown }).type !== 'session') {
    return null
  }
  const h = header as { id?: unknown; createdAt?: unknown; cwd?: unknown }
  const createdAt = typeof h.createdAt === 'number' && Number.isFinite(h.createdAt)
    ? new Date(h.createdAt).toISOString()
    : typeof h.createdAt === 'string' ? h.createdAt : ''
  const messages: SessionMessage[] = []
  let pendingAssistant = ''
  const flushAssistant = (): void => {
    if (pendingAssistant.length > 0) {
      messages.push({ role: 'assistant', text: pendingAssistant })
      pendingAssistant = ''
    }
  }
  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    if (line.length === 0) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (typeof record !== 'object' || record === null) continue
    const { type, data } = record as { type?: unknown; data?: unknown }
    if (type === 'user/message') {
      flushAssistant()
      const text_ = extractUserText((data as { content?: unknown } | undefined)?.content)
      if (text_.length > 0) messages.push({ role: 'user', text: text_ })
    } else if (type === 'assistant/chunk') {
      const chunk = (data as { chunk?: unknown } | undefined)?.chunk
      if (
        typeof chunk === 'object' && chunk !== null
        && (chunk as { type?: unknown }).type === 'text-delta'
        && typeof (chunk as { text?: unknown }).text === 'string'
      ) {
        pendingAssistant += (chunk as { text: string }).text
      }
    } else if (type === 'text-chunks') {
      // Packed delta runs written by the jsonl backend (packChunkRuns).
      const texts = (data as { texts?: unknown } | undefined)?.texts
      if (Array.isArray(texts)) {
        for (const t of texts) if (typeof t === 'string') pendingAssistant += t
      }
    } else {
      // Any other record (tool calls, step/turn markers, non-text chunks)
      // breaks the assistant run: deltas separated by intervening events must
      // NOT merge into one message.
      flushAssistant()
    }
  }
  flushAssistant()
  return {
    id: typeof h.id === 'string' ? h.id : '',
    createdAt,
    cwd: typeof h.cwd === 'string' ? h.cwd : null,
    messages,
  }
}

/** Compare two ISO createdAt strings for descending sort; unparseable values sink. */
function byCreatedAtDesc(a: ParsedSession, b: ParsedSession): number {
  const ta = Date.parse(a.createdAt)
  const tb = Date.parse(b.createdAt)
  return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta)
}

/**
 * Scan the two-level session archive (`root/<project>/<sid>/session.jsonl`),
 * parse every readable plaintext transcript, and filter/sort/limit the listing.
 * Missing directories and unreadable files degrade to warnings and are skipped;
 * `.zstd`-only sessions are counted in `skippedZstd`.
 * @param root - the sessions root (`$DSH_HOME/sessions`).
 * @param opts - id lookup or createdAt range filter plus listing cap.
 * @returns matched sessions (newest first for listings) and the zstd skip count.
 */
export async function browseSessions(root: string, opts: BrowseSessionsOptions = {}): Promise<BrowseSessionsResult> {
  const warn = (message: string): void => { opts.logger?.warn(message) }
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    warn(`memory_browse: cannot read sessions root ${root}: ${String(error)}`)
    return { sessions: [], skippedZstd: 0 }
  }
  const parsed: ParsedSession[] = []
  let skippedZstd = 0
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(root, project.name)
    let sessionDirs
    try {
      sessionDirs = await readdir(projectDir, { withFileTypes: true })
    } catch (error) {
      warn(`memory_browse: cannot read project dir ${projectDir}: ${String(error)}`)
      continue
    }
    for (const entry of sessionDirs) {
      if (!entry.isDirectory()) continue
      const sessionDir = join(projectDir, entry.name)
      let text: string
      try {
        text = await readFile(join(sessionDir, 'session.jsonl'), 'utf8')
      } catch (error) {
        if ((error as { code?: unknown }).code === 'ENOENT') {
          try {
            await stat(join(sessionDir, 'session.jsonl.zstd'))
            skippedZstd += 1
          } catch { /* neither artifact present — nothing to browse here */ }
        } else {
          warn(`memory_browse: cannot read ${join(sessionDir, 'session.jsonl')}: ${String(error)}`)
        }
        continue
      }
      const session = parseSessionJsonl(text)
      if (session === null) {
        warn(`memory_browse: ${join(sessionDir, 'session.jsonl')} has no session header; skipped`)
        continue
      }
      parsed.push(session)
    }
  }
  if (opts.sessionId !== undefined) {
    return { sessions: parsed.filter(s => s.id === opts.sessionId).slice(0, 1), skippedZstd }
  }
  const since = opts.since === undefined ? undefined : Date.parse(opts.since)
  const until = opts.until === undefined ? undefined : Date.parse(opts.until)
  const filtered = parsed.filter((s) => {
    if (since === undefined && until === undefined) return true
    const t = Date.parse(s.createdAt)
    if (Number.isNaN(t)) return false
    if (since !== undefined && !Number.isNaN(since) && t < since) return false
    if (until !== undefined && !Number.isNaN(until) && t > until) return false
    return true
  })
  filtered.sort(byCreatedAtDesc)
  return { sessions: filtered.slice(0, opts.limit ?? DEFAULT_BROWSE_LIMIT), skippedZstd }
}
