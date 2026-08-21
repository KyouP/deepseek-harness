// packages/memory/memory-core/src/consolidate.ts
//
// 冷路径睡眠巩固（FR-8.1 + FR-8.2 ①②④）：会话静默超过
// consolidateIdleMinutes 后，由宿主挂载的 5 分钟自管定时器（DSH 没有插件
// cron API）触发 tick；tick 读 activity:last 水位（Sedimenter.onTurnStopping
// 每轮打点），够闲才执行一次完整流水线：
//   ⓪ 先 drain 沉淀重试队列（sedimenter.retryPending），再进主线；
//   ① 蒸馏——notesBetween(7天前, 24h前) 非空 → LLM 提炼（复用 sediment 的
//      标记格式与 routeSedimentItem 分流）→ 入库 → deleteNotesBefore(24h前)；
//      LLM 不可用（null/throw）则整条跳过，便签原样保留，下轮再试；
//   ② 冲突消解——程序化扫描 activeFacts：同 subject+predicate 且取值冲突的
//      多行保留 recorded_at 最新者，其余 supersedeFact 链到最新内容；
//   ④ human block 重编译——存在 approved 的 kind=user 建议 → LLM 合并进当前
//      human block → sanitizeForWrite 过闸 → setCoreBlock('human', …) →
//      建议置 rejected（已消费）；LLM 不可用则跳过不丢。
// tick/run 全程防重入、永不 throw。
//
// 本文件只消费结构化的 `ConsolidateConfig` 子接口（字段名 / 类型与 Task 6 的
// 完整插件 Config 一致），不 import index.ts 的 Config。

import type { Fact, MemoryStore, NewFact, Note, Suggestion } from '@deepseek-ai/dsh-memory-store'
import type { LlmBackend } from './llm.ts'
import { parseSedimentOutput, routeSedimentItem } from './sediment.ts'
import { sanitizeForWrite } from './sanitize.ts'

export interface ConsolidateConfig {
  /** Idle time (minutes) before consolidation runs. */
  consolidateIdleMinutes?: number
}

export interface ConsolidateLogger {
  warn(msg: string): void
}

/** 沉淀重试队列的结构化最小接口：真实 Sedimenter 兼容，测试手可构。 */
export interface SedimentRetrier {
  retryPending(): Promise<void>
}

export interface ConsolidateDeps {
  store: MemoryStore
  llm: LlmBackend
  config: ConsolidateConfig
  logger: ConsolidateLogger
  sedimenter?: SedimentRetrier | undefined
}

export interface ConsolidateReport {
  distilled: number
  superseded: number
  recompiled: boolean
}

const DAY_MS = 24 * 3600_000
const DISTILL_WINDOW_DAYS = 7
const DEFAULT_IDLE_MINUTES = 30

const DISTILL_SYSTEM = '你是记忆蒸馏器。把一批过期便签提炼成少量值得长期保存的记忆条目，严格按标记逐行输出；没有值得记的就输出（无）。不要输出任何其他内容。'
const RECOMPILE_SYSTEM = '你是画像合并编辑器。把已批准的用户画像建议合并进现有画像文本，保持简洁、自包含，不丢失既有信息。只输出合并后的完整画像文本，不要输出任何其他内容。'

export class Consolidator {
  private running = false

  constructor(private readonly deps: ConsolidateDeps) {}

  /** 定时器入口：静默超 consolidateIdleMinutes 才执行；防重入；返回是否执行。 */
  async tick(now: Date = new Date()): Promise<boolean> {
    if (this.running) return false
    let raw: string | null
    try {
      raw = this.deps.store.getMeta('activity:last')
    } catch {
      return false // store may already be closed during shutdown; skip silently
    }
    if (!raw) return false
    const last = Date.parse(raw)
    if (Number.isNaN(last)) return false
    const idleMs = (this.deps.config.consolidateIdleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000
    if (now.getTime() - last < idleMs) return false
    try {
      await this.run(now)
    } catch (error) {
      // run() is fully guarded; this is a last-resort net so tick never throws.
      this.deps.logger.warn(`memory-core: consolidation run failed: ${String(error)}`)
    }
    return true
  }

  /** 立即执行一次完整流水线（测试/手动）。重入时返回全零报告。 */
  async run(now: Date = new Date()): Promise<ConsolidateReport> {
    if (this.running) return { distilled: 0, superseded: 0, recompiled: false }
    this.running = true
    try {
      // ⓪ Drain the warm-path retry queue first: those turns were extracted
      // already, and a now-healthy backend can land them before distillation.
      if (this.deps.sedimenter) {
        try {
          await this.deps.sedimenter.retryPending()
        } catch (error) {
          this.deps.logger.warn(`memory-core: sediment retry drain failed: ${String(error)}`)
        }
      }
      const distilled = await this.distillNotes(now)
      const superseded = this.resolveFactConflicts()
      const recompiled = await this.recompileHumanBlock()
      return { distilled, superseded, recompiled }
    } finally {
      this.running = false
    }
  }

  /** ① 蒸馏过期便签；LLM 不可用返回 0 且绝不删便签。 */
  private async distillNotes(now: Date): Promise<number> {
    const until = new Date(now.getTime() - DAY_MS).toISOString()
    const since = new Date(now.getTime() - DISTILL_WINDOW_DAYS * DAY_MS).toISOString()
    let notes: Note[]
    try {
      notes = this.deps.store.notesBetween(since, until)
    } catch {
      return 0
    }
    if (notes.length === 0) return 0
    let output: string | null
    try {
      output = await this.deps.llm.complete({ system: DISTILL_SYSTEM, user: this.buildDistillPrompt(notes) })
    } catch (error) {
      this.deps.logger.warn(`memory-core: consolidation distill llm call threw: ${String(error)}`)
      return 0
    }
    if (output === null) return 0
    let stored = 0
    for (const item of parseSedimentOutput(output)) {
      if (routeSedimentItem(item, this.deps)) stored++
    }
    try {
      this.deps.store.deleteNotesBefore(until)
    } catch (error) {
      this.deps.logger.warn(`memory-core: failed to delete distilled notes: ${String(error)}`)
    }
    return stored
  }

  /**
   * ② 冲突消解：同 subject+predicate 的 active 多行且取值不一致时，保留
   * recorded_at 最新者（并列取 id 最小，确定性），其余 supersedeFact 链到
   * 最新内容。取值一致的多行是无害重复：supersedeFact 每调用一次都会插入
   * 一行新事实，对它们"消解"只是空转 churn，跳过。
   */
  private resolveFactConflicts(): number {
    let facts: Fact[]
    try {
      facts = this.deps.store.activeFacts()
    } catch {
      return 0
    }
    const groups = new Map<string, Fact[]>()
    for (const fact of facts) {
      const key = `${fact.subject} ${fact.predicate}`
      const group = groups.get(key)
      if (group) group.push(fact)
      else groups.set(key, [fact])
    }
    let superseded = 0
    for (const group of groups.values()) {
      if (group.length < 2) continue
      if (new Set(group.map(fact => fact.object)).size === 1) continue
      group.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.id.localeCompare(b.id))
      const [newest, ...stale] = group as [Fact, ...Fact[]]
      const replacement: NewFact = {
        subject: newest.subject,
        predicate: newest.predicate,
        object: newest.object,
        confidence: newest.confidence,
        sourceCard: newest.sourceCard,
        validFrom: newest.validFrom,
        validTo: newest.validTo,
        pinned: newest.pinned,
      }
      for (const old of stale) {
        try {
          this.deps.store.supersedeFact(old.id, replacement)
          superseded++
        } catch (error) {
          this.deps.logger.warn(`memory-core: failed to supersede fact ${old.id}: ${String(error)}`)
        }
      }
    }
    return superseded
  }

  /** ④ human block 重编译；LLM 不可用 / 过闸失败都跳过不丢（建议保留）。 */
  private async recompileHumanBlock(): Promise<boolean> {
    let approved: Suggestion[]
    let current: string
    try {
      approved = this.deps.store.listSuggestions('approved').filter(s => s.kind === 'user')
      if (approved.length === 0) return false
      current = this.deps.store.getCoreBlock('human')?.text ?? ''
    } catch {
      return false
    }
    let output: string | null
    try {
      output = await this.deps.llm.complete({
        system: RECOMPILE_SYSTEM,
        user: this.buildRecompilePrompt(current, approved),
      })
    } catch (error) {
      this.deps.logger.warn(`memory-core: human block recompile llm call threw: ${String(error)}`)
      return false
    }
    if (output === null) return false
    const verdict = sanitizeForWrite(output)
    if (!verdict.ok) {
      this.deps.logger.warn(`memory-core: rejected recompiled human block (${verdict.reason})`)
      return false
    }
    try {
      this.deps.store.setCoreBlock('human', verdict.text)
      for (const suggestion of approved) this.deps.store.resolveSuggestion(suggestion.id, 'rejected')
    } catch (error) {
      this.deps.logger.warn(`memory-core: failed to persist recompiled human block: ${String(error)}`)
      return false
    }
    return true
  }

  /** notes + recent card summaries (≤5) + 输出格式指令。 */
  private buildDistillPrompt(notes: Note[]): string {
    const lines = notes.map(note => `- (${note.createdAt}) ${note.text}`).join('\n')
    let summaries: string[] = []
    try {
      summaries = this.deps.store.recentCards(5).map(card => card.summary).filter(Boolean)
    } catch {
      summaries = [] // a closed/broken store degrades the prompt, never the run
    }
    return [
      `【待蒸馏便签】\n${lines}`,
      `【近期记忆摘要，避免重复】\n${summaries.join('\n') || '（空）'}`,
      '输出格式（每行一条）：',
      '[CARD] 事件/偏好/状态，一句自包含的话',
      '[FACT] 主体 | 属性 | 值（稳定事实，如 主人 | 职业 | 工程师）',
      '[USER] 用户画像增量（性格/偏好/背景）',
      '（无）',
    ].join('\n')
  }

  private buildRecompilePrompt(current: string, suggestions: Suggestion[]): string {
    const list = suggestions.map(suggestion => `- ${suggestion.content}`).join('\n')
    return [
      `【当前用户画像】\n${current || '（空）'}`,
      `【已批准的画像建议】\n${list}`,
      '把以上建议合并进当前画像，输出新的 human block 完整文本。',
    ].join('\n')
  }
}
