// packages/memory/memory-core/tests/browse.spec.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'
import * as memory from '../src/index.ts'
import { browseSessions, parseSessionJsonl } from '../src/browse.ts'

const sig = new AbortController().signal
let dir = ''
let counter = 400
const savedHome = process.env.DSH_HOME
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
})

/** Write one plaintext session archive under <root>/<project>/<sid>/session.jsonl. */
function writeSession(root: string, project: string, sid: string, lines: unknown[]): void {
  const sessionDir = join(root, project, sid)
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, 'session.jsonl'), lines.map(l => JSON.stringify(l)).join('\n'))
}

function header(id: string, createdAt: string, cwd?: string): Record<string, unknown> {
  return { type: 'session', version: 1, id, createdAt, ...(cwd !== undefined ? { cwd } : {}) }
}

describe('parseSessionJsonl', () => {
  it('parseSessionJsonl extracts header and text messages in order', () => {
    const text = [
      JSON.stringify({ type: 'session', version: 1, id: 's1', createdAt: '2026-08-01T00:00:00Z', cwd: 'f:/p' }),
      JSON.stringify({ type: 'user/message', data: { content: '你好' } }),
      JSON.stringify({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '你' } } }),
      JSON.stringify({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '好' } } }),
    ].join('\n')
    const s = parseSessionJsonl(text)!
    expect(s.id).toBe('s1')
    expect(s.messages).toEqual([{ role: 'user', text: '你好' }, { role: 'assistant', text: '你好' }])
  })

  it('returns null on garbage and tolerates bad lines', () => {
    expect(parseSessionJsonl('not json at all')).toBeNull()
    expect(parseSessionJsonl('')).toBeNull()
    expect(parseSessionJsonl(JSON.stringify({ type: 'other', id: 'x' }))).toBeNull()
    const text = [
      JSON.stringify(header('s2', '2026-08-02T00:00:00Z')),
      '{broken line',
      JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '甲' }, { type: 'image' }, { type: 'text', text: '乙' }] } }),
      JSON.stringify({ type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', text: 'ignored' } } }),
      JSON.stringify({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '答' } } }),
      'null',
    ].join('\n')
    const s = parseSessionJsonl(text)!
    expect(s.id).toBe('s2')
    expect(s.cwd).toBeNull()
    expect(s.messages).toEqual([{ role: 'user', text: '甲乙' }, { role: 'assistant', text: '答' }])
  })
})

describe('browseSessions', () => {
  it('filters by since/until on createdAt and sorts newest first', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hmem-browse-'))
    const root = join(dir, 'sessions')
    writeSession(root, '--proj--', 'old-sid', [
      header('old', '2026-07-01T00:00:00Z', 'f:/p'),
      { type: 'user/message', data: { content: '旧事' } },
    ])
    writeSession(root, '--proj--', 'new-sid', [
      header('new', '2026-08-10T00:00:00Z', 'f:/p'),
      { type: 'user/message', data: { content: '新事' } },
    ])
    const all = await browseSessions(root, {})
    expect(all.sessions.map(s => s.id)).toEqual(['new', 'old'])
    const ranged = await browseSessions(root, { since: '2026-08-01', until: '2026-08-31' })
    expect(ranged.sessions.map(s => s.id)).toEqual(['new'])
    const limited = await browseSessions(root, { limit: 1 })
    expect(limited.sessions.map(s => s.id)).toEqual(['new'])
    const byId = await browseSessions(root, { sessionId: 'old' })
    expect(byId.sessions).toHaveLength(1)
    expect(byId.sessions[0]!.messages).toEqual([{ role: 'user', text: '旧事' }])
    const missing = await browseSessions(root, { sessionId: 'nope' })
    expect(missing.sessions).toHaveLength(0)
  })

  it('skips .zstd sessions with a note', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hmem-browse-'))
    const root = join(dir, 'sessions')
    const zstdDir = join(root, '--proj--', 'zsid')
    mkdirSync(zstdDir, { recursive: true })
    writeFileSync(join(zstdDir, 'session.jsonl.zstd'), 'pretend-compressed')
    const result = await browseSessions(root, {})
    expect(result.sessions).toHaveLength(0)
    expect(result.skippedZstd).toBe(1)
  })

  it('degrades gracefully on a missing root directory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'hmem-browse-'))
    const result = await browseSessions(join(dir, 'no-such-dir'), {})
    expect(result).toEqual({ sessions: [], skippedZstd: 0 })
  })
})

async function setup() {
  dir = mkdtempSync(join(tmpdir(), 'hmem-browse-tool-'))
  process.env.DSH_HOME = dir
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const fiber = await ctx.plugin(memory, { dbPath: join(dir, 'hmem.db') })
  return { ctx, fiber }
}

function call(ctx: Context, name_: string, args: unknown) {
  return ctx.tools.execute({ signal: sig, callId: CallId(`c-${++counter}`), name: name_, arguments: args })
}

describe('memory_browse tool', () => {
  it('lists sessions without messages when no sessionId is given', async () => {
    const { ctx, fiber } = await setup()
    writeSession(join(dir, 'sessions'), '--proj--', 'sid-a', [
      header('a', '2026-08-01T00:00:00Z', 'f:/p'),
      { type: 'user/message', data: { content: '问题' } },
      { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: '回答' } } },
    ])
    writeSession(join(dir, 'sessions'), '--proj--', 'sid-b', [header('b', '2026-08-05T00:00:00Z')])
    const result = await call(ctx, 'memory_browse', {})
    expect(result.isError).toBe(false)
    const value = (result as {
      value: { sessions: { id: string; createdAt: string; cwd: string | null; messageCount: number }[]; skippedZstd: number }
    }).value
    expect(value.sessions.map(s => s.id)).toEqual(['b', 'a'])
    expect(value.sessions[1]).toMatchObject({ createdAt: '2026-08-01T00:00:00Z', cwd: 'f:/p', messageCount: 2 })
    expect(value.sessions[0]!.cwd).toBeNull()
    expect(value.skippedZstd).toBe(0)
    expect(value.sessions[0]).not.toHaveProperty('messages')
    await fiber.dispose()
  })

  it('returns truncated messages for one sessionId', async () => {
    const { ctx, fiber } = await setup()
    const longText = '长'.repeat(1200)
    writeSession(join(dir, 'sessions'), '--proj--', 'sid-c', [
      header('c', '2026-08-03T00:00:00Z', 'f:/p'),
      { type: 'user/message', data: { content: '短问题' } },
      { type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: longText } } },
    ])
    const result = await call(ctx, 'memory_browse', { sessionId: 'c' })
    expect(result.isError).toBe(false)
    const value = (result as {
      value: { id: string; messages: { role: string; text: string }[]; truncated: boolean }
    }).value
    expect(value.id).toBe('c')
    expect(value.messages).toHaveLength(2)
    expect(value.messages[0]).toEqual({ role: 'user', text: '短问题' })
    expect(value.messages[1]!.role).toBe('assistant')
    expect(value.messages[1]!.text.length).toBeLessThanOrEqual(501)
    expect(value.truncated).toBe(true)
    // The render appends a truncation marker line.
    const rendered = ctx.tools.get('memory_browse')!.output.render({ sessionId: 'c' }, value)
    expect(rendered[0]!.type).toBe('text')
    expect((rendered[0] as { text: string }).text).toContain('truncated')
    await fiber.dispose()
  })

  it('caps the total at 8000 chars across many messages', async () => {
    const { ctx, fiber } = await setup()
    const lines: unknown[] = [header('big', '2026-08-04T00:00:00Z')]
    for (let i = 0; i < 30; i++) lines.push({ type: 'user/message', data: { content: '字'.repeat(400) } })
    writeSession(join(dir, 'sessions'), '--proj--', 'sid-big', lines)
    const result = await call(ctx, 'memory_browse', { sessionId: 'big' })
    const value = (result as { value: { messages: { text: string }[]; truncated: boolean } }).value
    const total = value.messages.reduce((sum, m) => sum + m.text.length, 0)
    expect(total).toBeLessThanOrEqual(8000)
    expect(value.messages.length).toBeLessThan(30)
    expect(value.truncated).toBe(true)
    await fiber.dispose()
  })

  it('is an error, not a crash, on an unknown sessionId', async () => {
    const { ctx, fiber } = await setup()
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    const result = await call(ctx, 'memory_browse', { sessionId: 'ghost' })
    expect(result.isError).toBe(true)
    await fiber.dispose()
  })

  it('lists nothing gracefully when the sessions root does not exist', async () => {
    const { ctx, fiber } = await setup()
    const result = await call(ctx, 'memory_browse', {})
    expect(result.isError).toBe(false)
    expect((result as { value: { sessions: unknown[] } }).value.sessions).toHaveLength(0)
    await fiber.dispose()
  })
})
