// packages/memory/memory-core/tests/tools-export.spec.ts
// Export/backup/import tools against REAL stores on tmp dirs; only the cordis
// ctx is faked (tools.register captures the definitions), so execute runs
// through the genuine SQL + fs paths. Export and import run against two
// separate stores to prove the round trip.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { MemoryStore, openMemoryStore } from '@deepseek-ai/dsh-memory-store'
import type { MemoryStoreService } from '../src/service.ts'
import { registerExportTools } from '../src/tools-export.ts'

let tmp: string
let source: MemoryStore
let target: MemoryStore
let sourceTools: Map<string, ToolDefinition>
let targetTools: Map<string, ToolDefinition>

function fakeCtx(tools: Map<string, ToolDefinition>): Context {
  return { tools: { register: (def: ToolDefinition) => { tools.set(def.name, def) } } } as unknown as Context
}

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'hmem-export-'))
  source = openMemoryStore(join(tmp, 'source.db'))
  target = openMemoryStore(join(tmp, 'target.db'))
  sourceTools = new Map()
  targetTools = new Map()
  registerExportTools(fakeCtx(sourceTools), { store: source } as unknown as MemoryStoreService)
  registerExportTools(fakeCtx(targetTools), { store: target } as unknown as MemoryStoreService)
})

afterEach(async () => {
  source.close()
  target.close()
  await rm(tmp, { recursive: true, force: true })
})

const exec = {} as ToolRunContext

interface ExportOut {
  ok: boolean
  error?: string
  path?: string
  counts?: Record<string, number>
}

interface ImportOut {
  ok: boolean
  error?: string
  imported?: number
  skipped?: number
  tables?: Record<string, { imported: number; skipped: number }>
}

const exportFrom = (args: Record<string, unknown>) =>
  sourceTools.get('memory_export')!.execute(args, exec) as Promise<ExportOut>
const importInto = (args: Record<string, unknown>) =>
  targetTools.get('memory_import')!.execute(args, exec) as Promise<ImportOut>

const renderOut = (tools: Map<string, ToolDefinition>, name: string, args: Record<string, unknown>, value: unknown) =>
  tools.get(name)!.output.render(args as never, value as never) as { type: string; text?: string }[]

function seedSource(): void {
  const a = source.insertCard({ summary: '主人喜欢深烘焙咖啡', content: '主人喜欢深烘焙咖啡，不加糖。', pinned: true, salience: 0.8 })
  const b = source.insertCard({ summary: '上周去了青岛', content: '主人上周去了青岛看海。' })
  source.insertFact({ subject: '主人', predicate: '职业', object: '程序员' })
  source.addCommitment({ content: '每周五发周报', dueAt: '2026-08-28T00:00:00.000Z' })
  source.setCoreBlock('persona', '你是小深。')
  source.addNote(null, '临时笔记一条')
  source.addLink(a.id, b.id, 2)
}

describe('memory_export / memory_import tools', () => {
  it('registers memory_export and memory_import', () => {
    expect([...sourceTools.keys()].sort()).toEqual(['memory_export', 'memory_import'])
  })

  it('export writes the dump to the given path and reports counts', async () => {
    seedSource()
    const path = join(tmp, 'nested', 'backup.json')
    const out = await exportFrom({ path })
    expect(out.ok).toBe(true)
    expect(out.path).toBe(path)
    expect(out.counts).toEqual({ cards: 2, facts: 1, commitments: 1, coreBlocks: 1, notes: 1, links: 1 })
    const rendered = renderOut(sourceTools, 'memory_export', { path }, out)
    expect(rendered[0]!.text).toContain(path)
  })

  it('export defaults to $DSH_HOME/storages/hmem-export.json', async () => {
    const home = join(tmp, 'dsh-home')
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      seedSource()
      const out = await exportFrom({})
      expect(out.ok).toBe(true)
      expect(out.path).toBe(join(home, 'storages', 'hmem-export.json'))
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
    }
  })

  it('export to an unwritable path reports an error, not a crash', async () => {
    const out = await exportFrom({ path: join(tmp, 'source.db', 'child.json') })
    expect(out.ok).toBe(false)
    expect(out.error).toBeTruthy()
    const rendered = renderOut(sourceTools, 'memory_export', {}, out)
    expect(rendered[0]!.text).toMatch(/error/i)
  })

  it('export → import into a fresh store reproduces every table (ids preserved)', async () => {
    seedSource()
    const path = join(tmp, 'backup.json')
    await exportFrom({ path })
    const out = await importInto({ path })
    expect(out.ok).toBe(true)
    expect(out.imported).toBe(7) // 2 cards + 1 fact + 1 commitment + 1 core block + 1 note + 1 link
    const before = source.dump()
    const after = target.dump()
    expect(after.cards.map(c => c.id).sort()).toEqual(before.cards.map(c => c.id).sort())
    expect(after.cards).toHaveLength(before.cards.length)
    expect(after.facts).toEqual(before.facts)
    expect(after.commitments).toEqual(before.commitments)
    expect(after.coreBlocks).toEqual(before.coreBlocks)
    expect(after.notes).toEqual(before.notes)
    expect(after.links).toEqual(before.links)
    // FTS channels see the imported cards (triggers fired on insert).
    expect(target.searchCardsFts('深烘焙').length).toBeGreaterThan(0)
  })

  it('re-import is idempotent: everything skipped, row counts unchanged', async () => {
    seedSource()
    const path = join(tmp, 'backup.json')
    await exportFrom({ path })
    await importInto({ path })
    const countsBefore = target.dump()
    const again = await importInto({ path })
    expect(again.ok).toBe(true)
    expect(again.imported).toBe(0)
    expect(again.skipped).toBeGreaterThan(0)
    const countsAfter = target.dump()
    expect(countsAfter.cards).toHaveLength(countsBefore.cards.length)
    expect(countsAfter.facts).toHaveLength(countsBefore.facts.length)
    expect(countsAfter.commitments).toHaveLength(countsBefore.commitments.length)
    expect(countsAfter.notes).toHaveLength(countsBefore.notes.length)
    expect(countsAfter.links).toHaveLength(countsBefore.links.length)
  })

  it('core_blocks: higher incoming revision wins, lower revision never overwrites', async () => {
    seedSource()
    const path = join(tmp, 'backup.json')
    await exportFrom({ path })
    // target already has a NEWER persona revision: import must not clobber it.
    target.setCoreBlock('persona', '本地更新的人格')
    target.setCoreBlock('persona', '本地更新的人格 v3')
    const out = await importInto({ path })
    expect(out.ok).toBe(true)
    expect(target.getCoreBlock('persona')!.text).toBe('本地更新的人格 v3')
    expect(target.getCoreBlock('persona')!.revision).toBe(2)
    expect(out.tables!.coreBlocks!.skipped).toBe(1)

    // A higher incoming revision DOES overwrite the local block.
    const { readFile } = await import('node:fs/promises')
    const dump = JSON.parse(await readFile(path, 'utf8')) as { coreBlocks: { name: string; text: string; revision: number }[] }
    dump.coreBlocks[0]!.text = '远端人格 v5'
    dump.coreBlocks[0]!.revision = 5
    await writeFile(path, JSON.stringify(dump), 'utf8')
    const upgraded = await importInto({ path })
    expect(upgraded.ok).toBe(true)
    expect(upgraded.tables!.coreBlocks!.imported).toBe(1)
    expect(target.getCoreBlock('persona')!.text).toBe('远端人格 v5')
    expect(target.getCoreBlock('persona')!.revision).toBe(5)
  })

  it('import of an unreadable or malformed file errors with no partial import', async () => {
    const missing = await importInto({ path: join(tmp, 'nope.json') })
    expect(missing.ok).toBe(false)
    expect(missing.error).toBeTruthy()

    const badJson = join(tmp, 'bad.json')
    await writeFile(badJson, '{ not json', 'utf8')
    const corrupt = await importInto({ path: badJson })
    expect(corrupt.ok).toBe(false)
    expect(corrupt.error).toMatch(/parse|json/i)

    const wrongShape = join(tmp, 'wrong.json')
    await writeFile(wrongShape, JSON.stringify({ cards: 'nope' }), 'utf8')
    const shape = await importInto({ path: wrongShape })
    expect(shape.ok).toBe(false)
    expect(shape.error).toMatch(/shape|format|invalid/i)

    expect(target.dump().cards).toHaveLength(0)
    expect(target.dump().facts).toHaveLength(0)
  })

  it('renders import summaries and presents call cards', async () => {
    seedSource()
    const path = join(tmp, 'backup.json')
    await exportFrom({ path })
    const out = await importInto({ path })
    const rendered = renderOut(targetTools, 'memory_import', { path }, out)
    expect(rendered[0]!.text).toMatch(/import/i)
    expect(rendered[0]!.text).toContain('skipped')
    const tool = targetTools.get('memory_import')!
    expect(tool.presentCall!({ path })).toMatchObject({ kind: 'other' })
    const exportTool = sourceTools.get('memory_export')!
    expect(exportTool.presentCall!({})).toMatchObject({ kind: 'other' })
  })
})
