import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryStore } from '@deepseek-ai/dsh-memory-store'

/** Cordis service wrapper making the H-MEM store injectable as `ctx.memoryStore`. */
export class MemoryStoreService extends Service {
  /** The open H-MEM database handle; closed when the owning fiber unloads. */
  readonly store: MemoryStore

  constructor(ctx: Context, store: MemoryStore) {
    super(ctx, 'memoryStore')
    this.store = store
    this.ctx.effect(() => () => { this.store.close() }, 'memoryStore.close')
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    memoryStore: MemoryStoreService
  }
}
