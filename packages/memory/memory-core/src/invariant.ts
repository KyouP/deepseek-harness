/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-memory-core`.
 * @module @deepseek-ai/dsh-memory-core/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-memory-core'

/** Cordis companion plugin name. */
export const name = 'memory-core-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the scaffold owns exactly one fiber-scoped service
 * whose store lifecycle (open, close) is registered and disposed with the
 * fiber itself, and every durable relation lives in `@deepseek-ai/dsh-memory-store`
 * with no event stream for a companion to compare against yet.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
