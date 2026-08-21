/**
 * Workspace provenance helper (FR-2.9): resolve the session's working
 * directory for card tagging and scoped recall.
 *
 * The real DSH session API exposes the cwd on the immutable storage metadata —
 * `session.header.cwd` (SessionHeader, validated absolute at creation).
 * `session.requestHeader()` returns the folded {@link EpochHeader}
 * (config/system/tools) and carries NO cwd; it is read only as a compatibility
 * fallback for AgentLike test doubles and older structural mocks. Any access
 * fault fails open to null: an unknown cwd degrades every consumer to the
 * scope-off behavior (never hide memories).
 * @module
 */

/** Structural minimum of a session for workspace resolution. */
export interface WorkspaceSessionLike {
  /** Storage metadata; the canonical cwd source (`Session.header`). */
  header?: { cwd?: unknown } | null
  /**
   * Legacy/mock fallback: some doubles carry cwd on the folded header. Typed
   * `unknown` because the real EpochHeader (config/system/tools) has no cwd —
   * the resolver narrows defensively.
   */
  requestHeader?(): unknown
}

/**
 * Resolve the session's workspace id (its creation cwd), or null when the
 * session is absent, exposes no cwd, or any accessor throws.
 */
export function sessionWorkspace(session: WorkspaceSessionLike | null | undefined): string | null {
  try {
    const fromHeader = session?.header?.cwd
    if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader
    const folded: unknown = session?.requestHeader?.()
    const fromRequest = folded !== null && typeof folded === 'object'
      ? (folded as { cwd?: unknown }).cwd
      : undefined
    if (typeof fromRequest === 'string' && fromRequest.length > 0) return fromRequest
  } catch {
    // A broken accessor must never break a write or recall path; fail open.
  }
  return null
}

/**
 * Structural minimum of a session for subagent detection. Same provenance
 * rule as {@link WorkspaceSessionLike}: the real DSH session API exposes
 * `origin`/`parentSession` on the immutable storage metadata
 * (`session.header`, SessionHeader); the folded `requestHeader()`
 * (EpochHeader: config/system/tools) carries neither and is read only as a
 * compatibility fallback for legacy AgentLike test doubles.
 */
export interface SubagentSessionLike {
  /** Storage metadata; the canonical origin source (`Session.header`). */
  header?: { origin?: unknown; parentSession?: unknown } | null
  /**
   * Legacy/mock fallback: some doubles carry origin/parentSession on the
   * folded header. Typed `unknown` because the real EpochHeader has neither —
   * the check narrows defensively.
   */
  requestHeader?(): unknown
}

/**
 * Subagent gate shared by the sediment task and the periodic review: a turn
 * is a subagent turn when its session header marks `origin: 'subagent'` or
 * carries a `parentSession`. A missing/broken accessor fails open (counts as
 * top-level), matching the original gate semantics.
 */
export function isSubagentSession(session: SubagentSessionLike | null | undefined): boolean {
  try {
    const header = session?.header
    if (header && (header.origin === 'subagent' || header.parentSession != null)) return true
    const folded: unknown = session?.requestHeader?.()
    if (folded !== null && typeof folded === 'object') {
      const legacy = folded as { origin?: unknown; parentSession?: unknown }
      if (legacy.origin === 'subagent' || legacy.parentSession != null) return true
    }
  } catch {
    // A broken accessor must never break the turn-stop path; fail open.
  }
  return false
}
