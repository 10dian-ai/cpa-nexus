import { fetchModels } from './client'
import { clearCredentialStrikes, forgetToken, keepSessionAlive, recordCredentialFailure } from './credentials'
import { LogiccError } from './errors'
import { markAccountReady, markSyncFailure } from './store'
import { getRedis } from '../../lib/redis'
import { clearCooldown } from '../../lib/pool/scheduler'
import { LOGICC_POOL_ID } from './config'

export interface AccountCheck { ok: boolean; models: number; error: string | null }

/**
 * Verify an account end to end: touch the Clerk session like the web app
 * does, mint a session JWT and read its model catalog. Used after import, by the
 * admin "check" action and by the worker's periodic sync.
 */
export async function checkAccount(id: string, options: { fresh?: boolean } = {}): Promise<AccountCheck> {
  try {
    await keepSessionAlive(id).catch(() => {})
    if (options.fresh) await forgetToken(id)
    const models = await fetchModels(id, AbortSignal.timeout(30_000))
    await markAccountReady(id, models)
    await clearCredentialStrikes(id).catch(() => {})
    await clearCooldown(getRedis(), LOGICC_POOL_ID, id).catch(() => {})
    return { ok: true, models: models.length, error: null }
  } catch (error) {
    const failure = error instanceof LogiccError ? error : new LogiccError('network', 502, '账号检测失败')
    if (failure.kind === 'credential') await recordCredentialFailure(id, failure)
    else await markSyncFailure(id, failure.message)
    return { ok: false, models: 0, error: failure.message }
  }
}
