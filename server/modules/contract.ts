import type { H3Event } from 'h3'
import type { ModuleView } from '../../shared/modules'

/** Verified routing context for one bridge request (key, serving group, request id). */
export interface BridgeRequestContext { keyId: string; groupId: string; requestId: string }

/**
 * An account-pool module below the CPA kernel. The platform drives these
 * through this uniform surface; each module keeps its own accounts, bridge
 * declaration and usage logic behind it.
 */
export interface PoolModule {
  readonly id: string
  /** Module status for the module list. */
  health(): Promise<Pick<ModuleView, 'status' | 'message' | 'runtimeVersion'>>
  /** Native model IDs the module currently serves, for the kernel bridge channel. */
  servingModels(): Promise<string[]>
  /** Serve one Chat Completions request forwarded from CPA through the bridge. */
  handleBridgeChat(event: H3Event, body: Record<string, unknown>, context: BridgeRequestContext): Promise<void>
  /** Reconcile this module's CPA bridge channel with its current catalog. */
  reconcileBridge(): Promise<void>
}
