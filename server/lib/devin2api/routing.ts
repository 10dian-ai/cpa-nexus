import { getDb } from '../db'
import { listDevin2ApiModels, stripDevin2ApiModel, namespaceDevin2ApiModels, type Devin2ApiModel } from './catalog'
import { getDevin2ApiRuntimeConfig } from './client'
import { listDevin2ApiAccounts, type Devin2ApiAccount } from './accounts'

export interface Devin2ApiSelection {
  model: string
  account: Devin2ApiAccount
}

/**
 * Resolve a namespaced Devin model to an enabled account belonging to at least
 * one of the caller key's enabled groups. The sidecar itself remains unaware
 * of Nexus groups; this check is the authorization boundary.
 */
export async function resolveDevin2ApiModel(model: string, groupIds: string[], options: { fresh?: boolean } = {}): Promise<Devin2ApiSelection | null> {
  const modelId = stripDevin2ApiModel(model)
  if (!modelId || !groupIds.length) return null
  const catalog = await listDevin2ApiModels({ fresh: options.fresh })
  if (!catalog.some(item => item.id === modelId)) return null
  const accounts = await listDevin2ApiAccounts()
  if (!accounts.length) {
    // A sidecar may be deployed as a singleton. In that mode the integration
    // itself is the source and a caller still needs a key group; no account
    // records means the operator has not opted into singleton routing.
    return null
  }
  const enabled = accounts.filter(account => account.enabled && ['pending', 'ready'].includes(account.status))
  if (!enabled.length) return null
  const allowedIds = new Set(await listEnabledDevin2ApiAccountIds(groupIds))
  const allowed = enabled.filter(account => allowedIds.has(account.id))
  if (!allowed.length) return null
  // Stable order makes retries and tests deterministic; worker-level balancing
  // can be added later without changing the authorization contract.
  allowed.sort((a, b) => a.id.localeCompare(b.id))
  return { model: modelId, account: allowed[0]! }
}

export async function listDevin2ApiGroupModels(groupIds: string[], options: { fresh?: boolean } = {}): Promise<Devin2ApiModel[]> {
  if (!groupIds.length) return []
  const accounts = await listDevin2ApiAccounts()
  if (!accounts.length) return []
  const allowedIds = new Set(await listEnabledDevin2ApiAccountIds(groupIds))
  if (!accounts.some(account => account.enabled && ['pending', 'ready'].includes(account.status) && allowedIds.has(account.id))) return []
  return namespaceDevin2ApiModels(await listDevin2ApiModels({ fresh: options.fresh }))
}

export async function listEnabledDevin2ApiAccountIds(groupIds: string[]): Promise<string[]> {
  if (!groupIds.length) return []
  const rows = await getDb()`SELECT a.id FROM devin2api_accounts a
    JOIN nexus_account_groups ag ON ag.module_id='devin2api' AND ag.account_id=a.id::text
    JOIN nexus_groups g ON g.id=ag.group_id
    WHERE a.enabled=true AND g.enabled=true AND g.id IN ${getDb()(groupIds)} ORDER BY a.created_at,a.id`
  return rows.map(row => String(row.id))
}

export function devin2ApiAccountBaseUrl(account: Devin2ApiAccount): string {
  return account.baseUrl || getDevin2ApiRuntimeConfig().baseUrl
}
