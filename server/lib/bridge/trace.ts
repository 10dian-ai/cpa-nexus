import { getRedis } from '../redis'

/**
 * A module bridge serves a request that the unified router logs. The module
 * records which of its accounts served the request under the router's request
 * ID; the router reads it when it writes the request log.
 */
export interface BridgeTrace {
  moduleId: string
  accountId: string | null
  attempts: { accountId: string; status: number; error: string }[]
  usageSource?: string
  /** How the module computed usage (tokenizer family, factors, local counts). Kept in logs only. */
  usageDetail?: Record<string, unknown>
}
const key = (requestId: string) => `ccm:bridge:trace:${requestId}`
export async function writeBridgeTrace(requestId: string, trace: BridgeTrace) {
  await getRedis().set(key(requestId), JSON.stringify(trace), 'EX', 900).catch(() => {})
}
export async function readBridgeTrace(requestId: string): Promise<BridgeTrace | null> {
  try {
    const value = await getRedis().get(key(requestId))
    return value ? JSON.parse(value) as BridgeTrace : null
  } catch { return null }
}
