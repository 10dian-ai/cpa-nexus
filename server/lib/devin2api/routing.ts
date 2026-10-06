import { getDb } from '../db'
import { listDevin2ApiModels, stripDevin2ApiModel, namespaceDevin2ApiModels, type Devin2ApiModel } from './catalog'
import { getDevin2ApiRuntimeLoad } from './runtime'
import { listDevin2ApiAccounts, type Devin2ApiAccount } from './accounts'

export interface Devin2ApiSelection {
  model: string
  account: Devin2ApiAccount
  /** The first caller-visible group through which this account was selected. */
  matchedGroupId: string
}

/**
 * Resolve a namespaced Devin model to an enabled account belonging to at least
 * one of the caller key's enabled groups. The embedded runtime stays unaware
 * of Nexus groups; this check is the authorization boundary.
 */
export async function resolveDevin2ApiModel(model: string, groupIds: string[], options: { fresh?: boolean } = {}): Promise<Devin2ApiSelection | null> {
  const modelId = stripDevin2ApiModel(model)
  if (!modelId || !groupIds.length) return null
  const accounts = await listDevin2ApiAccounts()
  if (!accounts.length) {
    // A caller must explicitly configure at least one account. The embedded
    // runtime never falls back to a shared singleton credential.
    return null
  }
  const enabled = accounts.filter(account => account.enabled && ['pending', 'ready'].includes(account.status))
  if (!enabled.length) return null
  const bindings = await listEnabledDevin2ApiAccountBindings(groupIds)
  const byId = new Map(enabled.map(account => [account.id, account]))
  let catalogError: unknown
  let catalogSucceeded = false
  // Group order is the caller's persisted key order. Prefer the first group
  // that can serve the model, then prefer the least-loaded available account
  // within that group. A saturated runtime is not a candidate: forwarding to
  // it would turn an otherwise healthy request into a needless 429. Returning
  // the group is necessary for per-group preset stacks.
  for (const groupId of groupIds) {
    const candidates = bindings.filter(binding => binding.groupId === groupId)
      .map(binding => byId.get(binding.accountId)).filter((account): account is Devin2ApiAccount => !!account)
      .map(account => {
        const load = getDevin2ApiRuntimeLoad(account.id)
        const maxConcurrency = Number.isSafeInteger(account.maxConcurrency) && account.maxConcurrency > 0 ? account.maxConcurrency : 2
        return { account, load, maxConcurrency }
      })
      .filter(candidate => candidate.load < candidate.maxConcurrency)
      .sort((a, b) => (a.load / a.maxConcurrency) - (b.load / b.maxConcurrency)
        || a.load - b.load || a.account.id.localeCompare(b.account.id))
    for (const { account } of candidates) {
      try {
        const catalog = await listDevin2ApiModels({ fresh: options.fresh, accountIds: [account.id] })
        catalogSucceeded = true
        if (catalog.some(item => item.id === modelId)) return { model: modelId, account, matchedGroupId: groupId }
      } catch (error) {
        // An unavailable lane must not hide a healthy account in this group.
        catalogError ??= error
      }
    }
  }
  if (!catalogSucceeded && catalogError) throw catalogError
  return null
}

export async function listDevin2ApiGroupModels(groupIds: string[], options: { fresh?: boolean } = {}): Promise<Devin2ApiModel[]> {
  if (!groupIds.length) return []
  const accounts = await listDevin2ApiAccounts()
  if (!accounts.length) return []
  const allowedIds = new Set(await listEnabledDevin2ApiAccountIds(groupIds))
  const allowed = accounts.filter(account => account.enabled && ['pending', 'ready'].includes(account.status) && allowedIds.has(account.id))
  if (!allowed.length) return []
  return namespaceDevin2ApiModels(await listDevin2ApiModels({ fresh: options.fresh, accountIds: allowed.map(account => account.id) }))
}

export async function listEnabledDevin2ApiAccountIds(groupIds: string[]): Promise<string[]> {
  return [...new Set((await listEnabledDevin2ApiAccountBindings(groupIds)).map(binding => binding.accountId))]
}

/** Return enabled account/group matches in the same stable order as routing. */
export async function listEnabledDevin2ApiAccountBindings(groupIds: string[]): Promise<Array<{ accountId: string; groupId: string }>> {
  if (!groupIds.length) return []
  const groupRows = await getDb()`SELECT a.id AS account_id,g.id AS group_id,a.created_at
    FROM devin2api_accounts a
    JOIN nexus_account_groups ag ON ag.module_id='devin2api' AND ag.account_id=a.id::text
    JOIN nexus_groups g ON g.id=ag.group_id
    WHERE a.enabled=true AND g.enabled=true AND g.id IN ${getDb()(groupIds)} ORDER BY a.created_at,a.id`
  const rank = new Map(groupIds.map((id, index) => [id, index]))
  return groupRows.map(row => ({ accountId: String(row.account_id), groupId: String(row.group_id), createdAt: String(row.created_at) }))
    .sort((a, b) => (rank.get(a.groupId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.groupId) ?? Number.MAX_SAFE_INTEGER)
      || a.accountId.localeCompare(b.accountId))
    .map(({ accountId, groupId }) => ({ accountId, groupId }))
}
