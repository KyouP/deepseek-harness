// packages/memory/memory-core/src/sediment.ts
//
// 温路径自动沉淀（FR-3.5 + FR-6.5）：每轮对话结束（agent/turn-stopping）后，
// 从会话事件里抽出最后一轮的用户/助手文本，交给 LlmBackend 提炼成带标记的
// 记忆条目，再按类型分流写入 store（卡片 / 事实 / 承诺 / 画像建议队列）。
// 全程门控（启用开关 → 排除子代理 → 防重入 → 体量下限 → 日上限 → 冷却 →
// 本轮去重），成本按“尝试”计数：只要过了所有门控，无论提炼成败都递增当日
// 计数并刷新 sediment:last。
//
// 本文件只消费结构化的 `SedimentConfig` 子接口（字段名 / 类型与 Task 6 的
// 完整插件 Config 一致），不 import index.ts 的 Config。

import type { MemoryStore } from '@deepseek-ai/dsh-memory-store'
import type { LlmBackend } from './llm.ts'
import { sanitizeForWrite } from './sanitize.ts'

export interface SedimentConfig {
  sedimentEnabled?: boolean
  sedimentMinChars?: number
  sedimentDailyMax?: number
  sedimentCooldownMinutes?: number
}

/** 会话事件的结构化最小接口（真实 session 事件结构兼容即可）。 */
export interface SessionEventLike {
  type: string
  // oxlint-disable-next-line no-explicit-any -- session payloads are heterogeneous by design
  data: any
  seq: number
}

/** agent 的结构化最小接口：测试手构，真实 Agent 结构兼容。 */
export interface AgentLike {
  session: {
    id: unknown
    events: SessionEventLike[]
    requestHeader?(): { origin?: string; parentSession?: unknown; cwd?: string } | undefined
  }
}

export interface SedimentDeps {
  store: MemoryStore
  llm: LlmBackend
  config: SedimentConfig
  logger: { warn(msg: string): void }
}

export type SedimentResult = 'stored' | 'empty' | 'skipped' | 'failed'

export interface SedimentItem {
  kind: 'card' | 'fact' | 'commitment' | 'user'
  content: string
}

/** 重试队列条目：存提取后的文本快照而非 agent 引用（agent 可能已销毁）。 */
interface PendingEntry {
  user: string
  assistant: string
  turn: number
  sessionId: string | null
  workspace: string | null
}

const SYSTEM = '你是记忆提炼器。从一轮对话中提炼值得长期保存的信息，严格按标记逐行输出；没有值得记的就输出（无）。不要输出任何其他内容。'

const MAX_RETRIES = 5
const TAIL_BUDGET = 900
const MARKER_RE = /^\[(CARD|FACT|COMMITMENT|USER)\]\s*(.*)$/

/**
 * Parse the distiller's marked output into routable items. Lines without a
 * recognized marker (including the explicit （无） empty marker) are noise.
 */
export function parseSedimentOutput(text: string): SedimentItem[] {
  const items: SedimentItem[] = []
  for (const raw of text.split('\n')) {
    const match = MARKER_RE.exec(raw.trim())
    if (!match) continue
    const content = match[2]?.trim() ?? ''
    if (!content) continue
    items.push({ kind: (match[1] ?? '').toLowerCase() as SedimentItem['kind'], content })
  }
  return items
}

/** Routing dependencies for {@link routeSedimentItem}. */
export interface SedimentRouteDeps {
  store: MemoryStore
  logger: { warn(msg: string): void }
}

/** Where a sediment item came from; recorded on cards for scoped recall. */
export interface SedimentProvenance {
  sessionId?: string | null
  workspace?: string | null
}

/**
 * Route one parsed sediment item into the store (card / fact / commitment /
 * user-suggestion queue). Returns true when the item was persisted. Shared by
 * the warm-path Sedimenter and the cold-path Consolidator — profile edits
 * always land in the suggestion queue, never touch core blocks directly.
 */
export function routeSedimentItem(
  item: SedimentItem,
  deps: SedimentRouteDeps,
  provenance: SedimentProvenance = {},
): boolean {
  try {
    switch (item.kind) {
      case 'card':
        return routeCard(item.content, deps, provenance)
      case 'fact':
        return routeFact(item.content, deps)
      case 'commitment':
        return routeCommitment(item.content, deps)
      case 'user':
        // 画像修改必须经确认/审查：恒入建议队列，绝不直接改核心块。
        deps.store.addSuggestion({ kind: 'user', content: item.content })
        return true
    }
  } catch (error) {
    deps.logger.warn(`memory-core: failed to route sediment item: ${String(error)}`)
    return false
  }
}

function routeCard(content: string, deps: SedimentRouteDeps, provenance: SedimentProvenance): boolean {
  const verdict = sanitizeForWrite(content)
  if (!verdict.ok) {
    deps.logger.warn(`memory-core: rejected sediment card (${verdict.reason})`)
    return false
  }
  const firstLine = verdict.text.split('\n', 1)[0] ?? ''
  deps.store.insertCard({
    summary: firstLine.slice(0, 60),
    content: verdict.text,
    salience: 0.5,
    pinned: false,
    sessionId: provenance.sessionId ?? null,
    workspace: provenance.workspace ?? null,
  })
  return true
}

function routeFact(content: string, deps: SedimentRouteDeps): boolean {
  const parts = content.split(' | ').map(part => part.trim())
  if (parts.length !== 3 || parts.some(part => !part)) {
    deps.logger.warn(`memory-core: malformed sediment fact: ${content}`)
    return false
  }
  const [subject, predicate, object] = parts as [string, string, string]
  const existing = deps.store.activeFacts(subject).find(fact => fact.predicate === predicate)
  if (existing && existing.object === object) return false
  if (existing) {
    deps.store.supersedeFact(existing.id, { subject, predicate, object })
  } else {
    deps.store.insertFact({ subject, predicate, object })
  }
  return true
}

function routeCommitment(content: string, deps: SedimentRouteDeps): boolean {
  const segments = content.split(' | ')
  let text = content.trim()
  let dueAt: string | null = null
  if (segments.length > 1) {
    const maybe = segments.at(-1)?.trim() ?? ''
    const parsed = Date.parse(maybe)
    if (maybe && !Number.isNaN(parsed)) {
      dueAt = new Date(parsed).toISOString()
      text = segments.slice(0, -1).join(' | ').trim()
    }
  }
  if (!text) return false
  deps.store.addCommitment({ content: text, dueAt })
  return true
}

/**
 * Extract the last turn: the final `user/message` event's text plus every
 * assistant `text-delta` chunk after it, concatenated. Returns null when the
 * session has no user message.
 */
export function extractLastTurn(events: SessionEventLike[]): { user: string; assistant: string } | null {
  let lastUser = -1
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'user/message') { lastUser = i; break }
  }
  if (lastUser < 0) return null
  const userData = events[lastUser]?.data as { content?: unknown } | undefined
  const content = userData?.content
  let user = ''
  if (typeof content === 'string') {
    user = content
  } else if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content as ({ type?: unknown; text?: unknown } | null)[]) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    user = parts.join('')
  }
  let assistant = ''
  for (let i = lastUser + 1; i < events.length; i++) {
    const event = events[i]
    if (event?.type !== 'assistant/chunk') continue
    const data = event.data as { chunk?: { type?: unknown; text?: unknown } } | undefined
    const chunk = data?.chunk
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') assistant += chunk.text
  }
  return { user, assistant }
}

/** Local-date daily counter key (local midnight boundaries, not UTC). */
function dayKey(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** Night hours (22:00-08:00 local) double the cooldown. */
function isNight(now: Date): boolean {
  const hour = now.getHours()
  return hour >= 22 || hour < 8
}

export class Sedimenter {
  private running = false
  private readonly seenTurns = new Set<string>()
  private readonly pending: PendingEntry[] = []

  constructor(private readonly deps: SedimentDeps) {}

  /**
   * turn-stopping 入口：门控 + 异步执行，永不 throw、永不阻塞。
   * 每次调用都刷新 activity:last（Task 13 巩固任务的空闲水位线）。
   */
  onTurnStopping(agent: AgentLike, turn: number): void {
    try {
      this.deps.store.setMeta('activity:last', new Date().toISOString())
    } catch {
      // store may already be closed during shutdown; the stamp is best-effort
    }
    queueMicrotask(() => {
      void this.runOnce(agent, turn).catch(() => {})
    })
  }

  /** 测试与重试用：执行一次完整沉淀，返回结果码。 */
  async runOnce(agent: AgentLike, turn: number): Promise<SedimentResult> {
    const { config, store } = this.deps
    if (!(config.sedimentEnabled ?? true)) return 'skipped'
    // The real dispatch may hand us a bare { turn, signal } payload without an
    // agent; every access below stays defensive against a malformed shape.
    const session = (agent as Partial<AgentLike> | null | undefined)?.session
    const header = this.headerOf(session)
    if (header && (header.origin === 'subagent' || header.parentSession != null)) return 'skipped'
    if (this.running) return 'skipped'
    const events = session?.events
    const extracted = Array.isArray(events) ? extractLastTurn(events) : null
    if (!extracted) return 'skipped'
    const minChars = config.sedimentMinChars ?? 240
    if (extracted.user.length + extracted.assistant.length < minChars) return 'skipped'

    const now = new Date()
    const countKey = `sediment:count:${dayKey(now)}`
    const count = Number.parseInt(store.getMeta(countKey) ?? '0', 10) || 0
    if (count >= (config.sedimentDailyMax ?? 8)) return 'skipped'

    const lastRaw = store.getMeta('sediment:last')
    if (lastRaw) {
      const last = Date.parse(lastRaw)
      if (!Number.isNaN(last)) {
        const cooldown = (config.sedimentCooldownMinutes ?? 30) * (isNight(now) ? 2 : 1)
        if (now.getTime() - last < cooldown * 60_000) return 'skipped'
      }
    }

    const rawId = session?.id
    let sessionId: string | null = null
    if (typeof rawId === 'string') sessionId = rawId
    else if (typeof rawId === 'number' || typeof rawId === 'bigint') sessionId = String(rawId)
    else if (rawId != null) sessionId = JSON.stringify(rawId) || null
    const turnKey = `${sessionId ?? 'unknown'}:${turn}`
    if (this.seenTurns.has(turnKey)) return 'skipped'
    this.seenTurns.add(turnKey)

    // Every attempt (success or failure) spends from the daily budget and
    // refreshes the cooldown watermark — cost control counts attempts.
    store.setMeta(countKey, String(count + 1))
    store.setMeta('sediment:last', now.toISOString())

    this.running = true
    try {
      return await this.distillAndRoute({
        user: extracted.user,
        assistant: extracted.assistant,
        turn,
        sessionId,
        workspace: header?.cwd ?? null,
      })
    } catch (error) {
      this.deps.logger.warn(`memory-core: sedimentation failed: ${String(error)}`)
      return 'failed'
    } finally {
      this.running = false
    }
  }

  /** 供巩固任务调：重试队列里积压的失败轮次。 */
  async retryPending(): Promise<void> {
    const entries = this.pending.splice(0, this.pending.length)
    for (const entry of entries) {
      try {
        // distillAndRoute re-enqueues llm failures itself; the catch here only
        // guards against unexpected throws (which would otherwise lose the entry).
        await this.distillAndRoute(entry)
      } catch {
        this.enqueue(entry)
      }
    }
  }

  /** Number of failed turns currently waiting for a retry. */
  get pendingCount(): number {
    return this.pending.length
  }

  private headerOf(session: AgentLike['session'] | undefined): { origin?: string; parentSession?: unknown; cwd?: string } | undefined {
    try {
      return session?.requestHeader?.()
    } catch {
      // A broken header accessor must not crash the turn-stop path; fail open.
      return undefined
    }
  }

  private enqueue(entry: PendingEntry): void {
    if (this.pending.length >= MAX_RETRIES) this.pending.shift()
    this.pending.push(entry)
  }

  /**
   * Distill one extracted turn through the LLM and route the parsed items.
   * A null/throwing backend lands the extracted texts in the retry queue.
   */
  private async distillAndRoute(entry: PendingEntry): Promise<SedimentResult> {
    let output: string | null
    try {
      output = await this.deps.llm.complete({
        system: SYSTEM,
        user: this.buildPrompt(entry.user, entry.assistant),
      })
    } catch (error) {
      this.deps.logger.warn(`memory-core: sedimentation llm call threw: ${String(error)}`)
      this.enqueue(entry)
      return 'failed'
    }
    if (output === null) {
      this.enqueue(entry)
      return 'failed'
    }
    const trimmed = output.trim()
    if (!trimmed || trimmed === '（无）') return 'empty'
    const items = parseSedimentOutput(trimmed)
    for (const item of items) {
      routeSedimentItem(item, this.deps, { sessionId: entry.sessionId, workspace: entry.workspace })
    }
    return items.length > 0 ? 'stored' : 'empty'
  }

  private buildPrompt(user: string, assistant: string): string {
    return [
      `【用户说】${user.slice(0, 3000)}`,
      `【你回答】${assistant.slice(0, 3000)}`,
      `【已有记忆尾部，避免重复】${this.memoryTail()}`,
      '输出格式（每行一条）：',
      '[CARD] 事件/偏好/状态，一句自包含的话',
      '[FACT] 主体 | 属性 | 值（稳定事实，如 主人 | 职业 | 工程师）',
      '[COMMITMENT] 你在本轮亲口许下的待办 | ISO期限（没提期限可省略竖线后段）',
      '[USER] 用户画像增量（性格/偏好/背景）',
      '（无）',
    ].join('\n')
  }

  /** recentCards(5) 的 summary + recentNotes 尾部，共 ≤900 字。 */
  private memoryTail(): string {
    const parts: string[] = []
    try {
      for (const card of this.deps.store.recentCards(5)) parts.push(card.summary)
      const since = new Date(Date.now() - 24 * 3600_000).toISOString()
      for (const note of this.deps.store.recentNotes(since, 10)) parts.push(note.text)
    } catch {
      // a closed/broken store degrades the prompt tail, never the turn
    }
    const joined = parts.filter(Boolean).join('\n')
    return joined.length > TAIL_BUDGET ? joined.slice(joined.length - TAIL_BUDGET) : joined
  }
}
