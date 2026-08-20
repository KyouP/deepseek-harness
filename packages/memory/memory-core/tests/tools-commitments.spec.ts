// packages/memory/memory-core/tests/tools-commitments.spec.ts
// Commitment-closure and pin tools against a REAL in-memory store; only the
// cordis ctx is faked (tools.register captures the definitions), so execute
// runs through the genuine SQL paths.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { MemoryStore, openMemoryStore } from '@deepseek-ai/dsh-memory-store'
import type { MemoryStoreService } from '../src/service.ts'
import { registerCommitmentTools } from '../src/tools-commitments.ts'

let store: MemoryStore
let tools: Map<string, ToolDefinition>

beforeEach(() => {
  store = openMemoryStore(':memory:')
  tools = new Map()
  const ctx = {
    tools: { register: (def: ToolDefinition) => { tools.set(def.name, def) } },
  } as unknown as Context
  const service = { store } as unknown as MemoryStoreService
  registerCommitmentTools(ctx, service)
})
afterEach(() => { store.close() })

const exec = {} as ToolRunContext

describe('commitment + pin tools', () => {
  it('registers memory_close_commitment, memory_pin and memory_unpin', () => {
    expect([...tools.keys()].sort()).toEqual([
      'memory_close_commitment', 'memory_pin', 'memory_unpin',
    ])
  })

  it('memory_close_commitment marks done and stops it being active', async () => {
    const c = store.addCommitment({ content: '给主人发周报' })
    const out = await tools.get('memory_close_commitment')!
      .execute({ id: c.id, status: 'done' }, exec) as { closed: boolean; id: string; status: string }
    expect(out.closed).toBe(true)
    expect(out.id).toBe(c.id)
    expect(out.status).toBe('done')
    expect(store.activeCommitments()).toHaveLength(0)
  })

  it('memory_close_commitment defaults status to done', async () => {
    const c = store.addCommitment({ content: '默认状态约定' })
    const out = await tools.get('memory_close_commitment')!.execute({ id: c.id }, exec) as { status: string }
    expect(out.status).toBe('done')
  })

  it('memory_close_commitment supports the cancelled status', async () => {
    const c = store.addCommitment({ content: '要取消的约定' })
    const out = await tools.get('memory_close_commitment')!
      .execute({ id: c.id, status: 'cancelled' }, exec) as { status: string }
    expect(out.status).toBe('cancelled')
    expect(store.activeCommitments()).toHaveLength(0)
  })

  it('close rejects already-closed commitments', async () => {
    const c = store.addCommitment({ content: '二次关闭' })
    await tools.get('memory_close_commitment')!.execute({ id: c.id, status: 'done' }, exec)
    await expect(tools.get('memory_close_commitment')!.execute({ id: c.id, status: 'done' }, exec))
      .rejects.toThrow(`no active commitment with id ${c.id}`)
  })

  it('close rejects an unknown commitment id', async () => {
    await expect(tools.get('memory_close_commitment')!.execute({ id: 'nope', status: 'done' }, exec))
      .rejects.toThrow('no active commitment with id nope')
  })

  it('memory_pin / memory_unpin flip pinned on a card', async () => {
    const card = store.insertCard({ summary: 's', content: 'c' })
    expect(store.getCard(card.id)?.pinned).toBe(false)
    const pinned = await tools.get('memory_pin')!.execute({ id: card.id }, exec) as { id: string; pinned: boolean }
    expect(pinned).toEqual({ id: card.id, pinned: true })
    expect(store.getCard(card.id)?.pinned).toBe(true)
    const unpinned = await tools.get('memory_unpin')!.execute({ id: card.id }, exec) as { id: string; pinned: boolean }
    expect(unpinned).toEqual({ id: card.id, pinned: false })
    expect(store.getCard(card.id)?.pinned).toBe(false)
  })

  it('memory_pin / memory_unpin reject an unknown card id', async () => {
    await expect(tools.get('memory_pin')!.execute({ id: 'nope' }, exec))
      .rejects.toThrow('no memory with id nope')
    await expect(tools.get('memory_unpin')!.execute({ id: 'nope' }, exec))
      .rejects.toThrow('no memory with id nope')
  })

  it('renders outputs and presents call cards', () => {
    const close = tools.get('memory_close_commitment')!
    expect(close.output.render({ id: 'a', status: 'done' }, { closed: true, id: 'a', status: 'done' }))
      .toEqual([{ type: 'text', text: 'Closed commitment a (done).' }])
    const pin = tools.get('memory_pin')!
    expect(pin.output.render({ id: 'a' }, { id: 'a', pinned: true }))
      .toEqual([{ type: 'text', text: 'Pinned memory a.' }])
    const unpin = tools.get('memory_unpin')!
    expect(unpin.output.render({ id: 'a' }, { id: 'a', pinned: false }))
      .toEqual([{ type: 'text', text: 'Unpinned memory a.' }])
    expect(close.presentCall!({ id: 'a' })).toMatchObject({ title: 'Close commitment', kind: 'other' })
    expect(pin.presentCall!({ id: 'a' })).toMatchObject({ title: 'Pin memory', kind: 'other' })
    expect(unpin.presentCall!({ id: 'a' })).toMatchObject({ title: 'Unpin memory', kind: 'other' })
  })
})
