import { randomUUID } from 'node:crypto'
import { createError } from 'h3'
import { getDb } from '../db'
import { decryptSecret, encryptSecret } from '../crypto'
import { accountGroupBindings, ensureAccountGroups, setAccountGroups } from '../groups'
import { publishUpdate } from '../events'
import { MAX_ACCOUNT_CONCURRENCY } from '../../../shared/concurrency'
import { invalidateDevin2ApiRuntime } from './runtime'

export interface Devin2ApiAccountInput {
  label?: string
  token?: string
  baseUrl?: string
  model?: string
  proxy?: string
  enabled?: boolean
  maxConcurrency?: number
  groupIds?: string[]
}

export interface Devin2ApiAccount {
  id: string
  label: string
  baseUrl: string | null
  model: string | null
  proxy: string | null
  enabled: boolean
  maxConcurrency: number
  status: string
  modelSnapshot: unknown
  snapshot: unknown
  lastUsedAt: string | null
  syncError: string | null
  lastSyncAt: string | null
  createdAt: string
  updatedAt: string
  hasToken: boolean
}

export interface Devin2ApiGroupSource extends Devin2ApiAccount {
  sourceId: string
  sourceType: 'devin2api'
  moduleId: 'devin2api'
  provider: 'Devin'
  groupIds: string[]
  groupNames: string[]
  routingSupported: true
}

type Row = Record<string, unknown>
const asString = (value: unknown): string => typeof value === 'string' ? value : ''
const asNullableString = (value: unknown): string | null => {
  const result = asString(value).trim()
  return result || null
}
const asBoolean = (value: unknown, fallback = false) => typeof value === 'boolean' ? value : fallback
const asConcurrency = (value: unknown): number => {
  const result = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(result) && result > 0 ? Math.min(result, MAX_ACCOUNT_CONCURRENCY) : 2
}
const iso = (value: unknown): string | null => value == null ? null : new Date(value as string | number | Date).toISOString()
const mapAccount = (row: Row): Devin2ApiAccount => ({
  id: asString(row.id), label: asString(row.label) || asString(row.email) || asString(row.id),
  baseUrl: asNullableString(row.base_url), model: asNullableString(row.model), proxy: asNullableString(row.proxy),
  enabled: asBoolean(row.enabled, true), maxConcurrency: asConcurrency(row.max_concurrency), status: asString(row.status) || 'pending',
  modelSnapshot: row.snapshot ?? null, snapshot: row.snapshot ?? null, lastUsedAt: iso(row.last_used_at), syncError: asNullableString(row.sync_error),
  lastSyncAt: iso(row.last_sync_at), createdAt: iso(row.created_at) || new Date(0).toISOString(), updatedAt: iso(row.updated_at) || new Date(0).toISOString(),
  hasToken: !!asNullableString(row.token_ciphertext),
})
const source = (account: Devin2ApiAccount, binding: { groupIds: string[]; groupNames: string[] }): Devin2ApiGroupSource => ({
  ...account, sourceId: account.id, sourceType: 'devin2api', moduleId: 'devin2api', provider: 'Devin', ...binding, routingSupported: true,
})

function validateBaseUrl(value: string | undefined): string | null {
  const text = value?.trim() || ''
  if (!text) return null
  let parsed: URL
  try { parsed = new URL(text) } catch {
    throw createError({ statusCode: 400, message: 'Devin 地址必须是无凭据的 http 或 https URL' })
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw createError({ statusCode: 400, message: 'Devin 地址必须是无凭据的 http 或 https URL' })
  return text.replace(/\/$/, '')
}

/** Return account rows without ever exposing the encrypted token. */
export async function listDevin2ApiAccounts(): Promise<Devin2ApiAccount[]> {
  const rows = await getDb()`SELECT id,label,base_url,model,proxy,enabled,max_concurrency,status,snapshot,sync_error,last_sync_at,last_used_at,created_at,updated_at,token_ciphertext
    FROM devin2api_accounts ORDER BY created_at DESC,id`
  return rows.map(row => mapAccount(row as Row))
}

export async function getDevin2ApiAccount(id: string): Promise<Devin2ApiAccount | null> {
  const rows = await getDb()`SELECT id,label,base_url,model,proxy,enabled,max_concurrency,status,snapshot,sync_error,last_sync_at,last_used_at,created_at,updated_at,token_ciphertext
    FROM devin2api_accounts WHERE id=${id}`
  return rows.length ? mapAccount(rows[0] as Row) : null
}

/** List accounts in the common group-source shape consumed by the Groups panel. */
export async function listDevin2ApiGroupSources(): Promise<Devin2ApiGroupSource[]> {
  const accounts = await listDevin2ApiAccounts()
  if (!accounts.length) return []
  const bindings = await accountGroupBindings('devin2api' as never, accounts.map(account => account.id))
  return accounts.map(account => source(account, bindings.get(account.id) || { groupIds: [], groupNames: [] }))
}

export async function createDevin2ApiAccount(input: Devin2ApiAccountInput): Promise<Devin2ApiAccount> {
  const id = randomUUID()
  const label = input.label?.trim() || 'Devin'
  if (input.maxConcurrency !== undefined && (!Number.isSafeInteger(input.maxConcurrency) || input.maxConcurrency < 1 || input.maxConcurrency > MAX_ACCOUNT_CONCURRENCY)) throw createError({ statusCode: 400, message: 'Devin 单账号并发上限无效' })
  const baseUrl = validateBaseUrl(input.baseUrl)
  const token = input.token?.trim() || ''
  const tokenCiphertext = token ? encryptSecret(token) : null
  const rows = await getDb().begin(async tx => {
    const inserted = await tx`INSERT INTO devin2api_accounts(id,label,token_ciphertext,base_url,model,proxy,enabled,max_concurrency,status)
      VALUES(${id},${label},${tokenCiphertext},${baseUrl},${input.model?.trim() || null},${input.proxy?.trim() || null},${input.enabled ?? true},${input.maxConcurrency ?? 2},'pending') RETURNING *`
    if (input.groupIds !== undefined) await setAccountGroups(tx, 'devin2api' as never, id, input.groupIds)
    else await ensureAccountGroups(tx, 'devin2api' as never, id)
    return inserted
  })
  await invalidateDevin2ApiRuntime(id)
  await publishUpdate({ type: 'accounts', accountId: id })
  return mapAccount(rows[0] as Row)
}

export async function patchDevin2ApiAccount(id: string, input: Devin2ApiAccountInput): Promise<Devin2ApiAccount | null> {
  const runtimeChanged = input.token !== undefined || input.baseUrl !== undefined || input.model !== undefined || input.proxy !== undefined || input.enabled !== undefined || input.maxConcurrency !== undefined
  const updates: Record<string, unknown> = {}
  if (input.label !== undefined) updates.label = input.label.trim()
  if (input.baseUrl !== undefined) updates.base_url = validateBaseUrl(input.baseUrl)
  if (input.model !== undefined) updates.model = input.model.trim() || null
  if (input.proxy !== undefined) updates.proxy = input.proxy.trim() || null
  if (input.enabled !== undefined) updates.enabled = input.enabled
  if (input.maxConcurrency !== undefined) {
    if (!Number.isSafeInteger(input.maxConcurrency) || input.maxConcurrency < 1 || input.maxConcurrency > MAX_ACCOUNT_CONCURRENCY) throw createError({ statusCode: 400, message: 'Devin 单账号并发上限无效' })
    updates.max_concurrency = input.maxConcurrency
  }
  if (input.token !== undefined) updates.token_ciphertext = input.token.trim() ? encryptSecret(input.token.trim()) : null
  updates.updated_at = new Date()
  const rows = await getDb().begin(async tx => {
    const updated = await tx`UPDATE devin2api_accounts SET ${tx(updates)} WHERE id=${id} RETURNING *`
    if (updated.length && input.groupIds !== undefined) await setAccountGroups(tx, 'devin2api' as never, id, input.groupIds)
    return updated
  })
  if (!rows.length) return null
  if (runtimeChanged) await invalidateDevin2ApiRuntime(id)
  await publishUpdate({ type: 'accounts', accountId: id })
  return mapAccount(rows[0] as Row)
}

export async function deleteDevin2ApiAccount(id: string): Promise<boolean> {
  const deleted = await getDb().begin(async tx => {
    await tx`DELETE FROM nexus_account_groups WHERE module_id='devin2api' AND account_id=${id}`
    const rows = await tx`DELETE FROM devin2api_accounts WHERE id=${id} RETURNING id`
    return rows.length > 0
  })
  if (deleted) {
    await invalidateDevin2ApiRuntime(id)
    await publishUpdate({ type: 'accounts', accountId: id })
  }
  return deleted
}

/** Internal use only. Callers must never include the returned token in logs or responses. */
export async function decryptDevin2ApiAccountToken(id: string): Promise<string | null> {
  const rows = await getDb()`SELECT token_ciphertext FROM devin2api_accounts WHERE id=${id}`
  const ciphertext = rows.length ? asNullableString(rows[0]!.token_ciphertext) : null
  return ciphertext ? decryptSecret(ciphertext) : null
}
