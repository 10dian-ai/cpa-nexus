import { createHash, randomUUID } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import { getDb } from '../../lib/db'
import { getRedis } from '../../lib/redis'
import { decryptSecret, encryptSecret } from '../../lib/crypto'
import { accountGroupBindings, setAccountGroups } from '../../lib/groups'
import { readCooldowns, readInflightCounts } from '../../lib/pool/scheduler'
import type { LogiccAccountStatus, LogiccAccountView, LogiccCredentialKind, LogiccModel } from '../../../shared/logicc'
import { LOGICC_POOL_ID } from './config'
import { redactLogiccText } from './errors'

type Database = Sql | TransactionSql
const iso = (value: unknown): string | null => value == null ? null : new Date(value as string).toISOString()

export interface LogiccCredentialRecord {
  id: string; sessionId: string | null; enabled: boolean; status: LogiccAccountStatus
  clientCookie: string | null; token: string | null; tokenExpiresAt: number | null; credentialVersion: number
  loginEmail: string | null; loginPassword: string | null; autoLogin: boolean
}
export interface LogiccCandidate { id: string; limit: number }

/** Deterministic key for deduplicating password accounts by their login email. */
export function loginEmailHash(email: string): string {
  return createHash('sha256').update('logicc-login:').update(email.trim().toLowerCase()).digest('hex')
}
/** Mask a login email for display: `al***@gmail.com`. Never returns the full address. */
export function maskEmail(email: string | null): string | null {
  if (!email) return null
  const at = email.indexOf('@')
  if (at <= 0) return email.slice(0, 2) + '***'
  const name = email.slice(0, at)
  return (name.length <= 2 ? name[0] + '***' : name.slice(0, 2) + '***') + email.slice(at)
}

export function maskSession(sessionId: string | null): string | null {
  if (!sessionId) return null
  return sessionId.length <= 12 ? 'sess_…' : sessionId.slice(0, 8) + '…' + sessionId.slice(-3)
}

export function normalizeModels(value: unknown): LogiccModel[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: LogiccModel[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const model = item as Record<string, unknown>
    const id = typeof model.id === 'string' ? model.id.trim() : ''
    if (!id || id.length > 200 || seen.has(id)) continue
    seen.add(id)
    result.push({ id, name: typeof model.name === 'string' && model.name.trim() ? model.name.trim().slice(0, 200) : id,
      provider: typeof model.provider === 'string' && model.provider.trim() ? model.provider.trim().slice(0, 100) : 'logicc', isDefault: model.isDefault === true })
  }
  return result
}

export async function loadCredential(id: string, sql: Database = getDb()): Promise<LogiccCredentialRecord | null> {
  const rows = await sql`SELECT id,session_id,enabled,status,client_cookie_ciphertext,token_ciphertext,token_expires_at,credential_version,
    login_email_ciphertext,login_password_ciphertext,auto_login FROM logicc_accounts WHERE id=${id}`
  const row = rows[0]
  if (!row) return null
  const reveal = (value: unknown) => value ? decryptSecret(value as string) : null
  return {
    id: row.id, sessionId: row.session_id, enabled: row.enabled, status: row.status,
    clientCookie: reveal(row.client_cookie_ciphertext),
    token: reveal(row.token_ciphertext),
    tokenExpiresAt: row.token_expires_at ? new Date(row.token_expires_at).getTime() : null,
    credentialVersion: Number(row.credential_version),
    loginEmail: reveal(row.login_email_ciphertext),
    loginPassword: reveal(row.login_password_ciphertext),
    autoLogin: row.auto_login !== false,
  }
}

/** Persist a `__client` value rotated by Clerk, unless another process already replaced the credentials. */
export async function storeRotatedCookie(id: string, cookie: string, expectedVersion: number): Promise<boolean> {
  const rows = await getDb()`UPDATE logicc_accounts SET client_cookie_ciphertext=${encryptSecret(cookie)},credential_version=credential_version+1,updated_at=now()
    WHERE id=${id} AND credential_version=${expectedVersion} RETURNING id`
  return rows.length > 0
}

/**
 * Store the session a sign-in established: its ID, the fresh `__client`, and a
 * matching JWT when the caller has one. The account becomes `pending` for the
 * next check to confirm. A concurrent credential change (version mismatch)
 * wins and this is skipped.
 */
export async function storeSignInResult(id: string, result: { sessionId: string; clientCookie: string; token?: string | null; tokenExpiresAt?: number | null }, expectedVersion: number): Promise<boolean> {
  const token = result.token ? encryptSecret(result.token) : null
  const expires = result.tokenExpiresAt ? new Date(result.tokenExpiresAt) : null
  const rows = await getDb()`UPDATE logicc_accounts SET session_id=${result.sessionId},client_cookie_ciphertext=${encryptSecret(result.clientCookie)},
    token_ciphertext=${token},token_expires_at=${expires},credential_version=credential_version+1,status='pending',sync_error=NULL,updated_at=now()
    WHERE id=${id} AND credential_version=${expectedVersion} RETURNING id`
  return rows.length > 0
}

export async function markAccountStatus(id: string, status: LogiccAccountStatus, error: string | null) {
  await getDb()`UPDATE logicc_accounts SET status=${status},sync_error=${error ? redactLogiccText(error) : null},last_sync_at=now(),updated_at=now() WHERE id=${id}`
}
/** A rejection that did not take the account out of the pool: shown to administrators, status unchanged. */
export async function noteAccountWarning(id: string, message: string) {
  await getDb()`UPDATE logicc_accounts SET sync_error=${redactLogiccText(message)},updated_at=now() WHERE id=${id}`
}
/** A failed background check: transient failures keep a ready account in the pool. */
export async function markSyncFailure(id: string, error: string) {
  await getDb()`UPDATE logicc_accounts SET status=CASE WHEN status='ready' THEN 'ready' ELSE 'sync_error' END,
    sync_error=${redactLogiccText(error)},last_sync_at=now(),updated_at=now() WHERE id=${id}`
}
export async function markAccountReady(id: string, models: LogiccModel[]) {
  await getDb()`UPDATE logicc_accounts SET status='ready',sync_error=NULL,models=${getDb().json(models as any)},last_sync_at=now(),updated_at=now() WHERE id=${id}`
}
/** A request succeeded: the account is usable regardless of an older failed check or warning. */
export async function touchAccount(id: string) {
  await getDb()`UPDATE logicc_accounts SET last_used_at=now(),status=CASE WHEN status IN ('sync_error','credential_expired') THEN 'ready' ELSE status END,
    sync_error=NULL WHERE id=${id}`
}

/**
 * Accounts whose models stay published while they are temporarily out of the
 * pool. Clients then get a retryable 503 (and the router tries other sources)
 * instead of a 404 that says the model does not exist.
 */
const LISTED_STATUSES = ['ready', 'sync_error', 'credential_expired', 'needs_login']

/** Accounts of one call group that may serve the model, oldest-used first. */
export async function listCandidates(groupId: string, model: string): Promise<LogiccCandidate[]> {
  const rows = await getDb()`SELECT a.id,a.max_concurrency FROM logicc_accounts a
    JOIN nexus_account_groups ag ON ag.module_id='logicc' AND ag.account_id=a.id::text AND ag.group_id=${groupId}
    JOIN nexus_groups g ON g.id=ag.group_id AND g.enabled=true
    WHERE a.enabled=true AND a.status='ready'
      AND (jsonb_array_length(a.models)=0 OR EXISTS(SELECT 1 FROM jsonb_array_elements(a.models) m WHERE m->>'id'=${model}))
    ORDER BY a.last_used_at ASC NULLS FIRST,a.id`
  return rows.map(row => ({ id: String(row.id), limit: Number(row.max_concurrency) }))
}

/** Models each requested group can serve through its enabled accounts (see LISTED_STATUSES). */
export async function groupModels(groupIds: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  if (!groupIds.length) return result
  const sql = getDb()
  const rows = await sql`SELECT ag.group_id,m->>'id' AS model FROM logicc_accounts a
    JOIN nexus_account_groups ag ON ag.module_id='logicc' AND ag.account_id=a.id::text AND ag.group_id IN ${sql(groupIds)}
    JOIN nexus_groups g ON g.id=ag.group_id AND g.enabled=true
    CROSS JOIN LATERAL jsonb_array_elements(a.models) m
    WHERE a.enabled=true AND a.status IN ${sql(LISTED_STATUSES)} GROUP BY ag.group_id,m->>'id' ORDER BY m->>'id'`
  for (const row of rows) {
    const list = result.get(String(row.group_id)) ?? []
    list.push(String(row.model))
    result.set(String(row.group_id), list)
  }
  return result
}

/** Every model an enabled account serves (or served before a temporary failure): the bridge channel's catalog in CPA. */
export async function servingModels(): Promise<string[]> {
  const sql = getDb()
  const rows = await sql`SELECT DISTINCT m->>'id' AS model FROM logicc_accounts a CROSS JOIN LATERAL jsonb_array_elements(a.models) m
    WHERE a.enabled=true AND a.status IN ${sql(LISTED_STATUSES)} ORDER BY 1`
  return rows.map(row => String(row.model)).filter(Boolean)
}

export interface NewAccountInput {
  sessionId: string; clientCookie: string | null; token: string | null; tokenExpiresAt: number | null
  loginEmail?: string | null; loginPassword?: string | null
  label?: string; note?: string; maxConcurrency: number; enabled?: boolean
}
/**
 * Add an account or refresh the credentials of the same Logicc session.
 * Group bindings change only for new accounts or when groups are given.
 */
export async function upsertAccount(input: NewAccountInput, groupIds?: string[]): Promise<{ id: string; created: boolean }> {
  return getDb().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'logicc:' + input.sessionId},0))`
    const existing = (await tx`SELECT id,label FROM logicc_accounts WHERE session_id=${input.sessionId} FOR UPDATE`)[0]
    const cookie = input.clientCookie ? encryptSecret(input.clientCookie) : null
    const token = input.token ? encryptSecret(input.token) : null
    const expires = input.tokenExpiresAt ? new Date(input.tokenExpiresAt) : null
    const email = input.loginEmail ? encryptSecret(input.loginEmail) : null
    const emailHash = input.loginEmail ? loginEmailHash(input.loginEmail) : null
    const password = input.loginPassword ? encryptSecret(input.loginPassword) : null
    if (existing) {
      // New credentials replace the old ones; a cookie is kept when only a JWT is re-imported.
      await tx`UPDATE logicc_accounts SET
        client_cookie_ciphertext=coalesce(${cookie},client_cookie_ciphertext),
        token_ciphertext=CASE WHEN ${token}::text IS NULL THEN token_ciphertext ELSE ${token} END,
        token_expires_at=CASE WHEN ${token}::text IS NULL THEN token_expires_at ELSE ${expires} END,
        login_email_ciphertext=coalesce(${email},login_email_ciphertext),
        login_email_hash=coalesce(${emailHash},login_email_hash),
        login_password_ciphertext=coalesce(${password},login_password_ciphertext),
        label=CASE WHEN ${input.label ?? ''}<>'' THEN ${input.label ?? ''} ELSE label END,
        credential_version=credential_version+1,status='pending',sync_error=NULL,updated_at=now()
        WHERE id=${existing.id}`
      if (groupIds !== undefined) await setAccountGroups(tx, 'logicc', existing.id, groupIds)
      return { id: String(existing.id), created: false }
    }
    const id = randomUUID()
    await tx`INSERT INTO logicc_accounts(id,label,note,session_id,client_cookie_ciphertext,token_ciphertext,token_expires_at,login_email_ciphertext,login_email_hash,login_password_ciphertext,enabled,max_concurrency)
      VALUES(${id},${input.label ?? ''},${input.note ?? ''},${input.sessionId},${cookie},${token},${expires},${email},${emailHash},${password},${input.enabled ?? true},${input.maxConcurrency})`
    if (groupIds !== undefined) await setAccountGroups(tx, 'logicc', id, groupIds)
    return { id, created: true }
  })
}

export interface PasswordAccountInput {
  loginEmail: string; loginPassword: string; label?: string; note?: string; maxConcurrency: number; enabled?: boolean
}
/**
 * Add or update an account identified by its login email, before any session
 * exists. A later sign-in fills in the session and cookie. Re-importing the
 * same email updates the password and keeps the account's groups.
 */
export async function upsertPasswordAccount(input: PasswordAccountInput, groupIds?: string[]): Promise<{ id: string; created: boolean }> {
  const hash = loginEmailHash(input.loginEmail)
  return getDb().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${'logicc-login:' + hash},0))`
    const existing = (await tx`SELECT id FROM logicc_accounts WHERE login_email_hash=${hash} FOR UPDATE`)[0]
    const email = encryptSecret(input.loginEmail)
    const password = encryptSecret(input.loginPassword)
    if (existing) {
      await tx`UPDATE logicc_accounts SET login_email_ciphertext=${email},login_password_ciphertext=${password},auto_login=true,
        label=CASE WHEN ${input.label ?? ''}<>'' THEN ${input.label ?? ''} ELSE label END,updated_at=now() WHERE id=${existing.id}`
      if (groupIds !== undefined) await setAccountGroups(tx, 'logicc', existing.id, groupIds)
      return { id: String(existing.id), created: false }
    }
    const id = randomUUID()
    // No session yet: it is established on first sign-in. Starts as needs_login.
    await tx`INSERT INTO logicc_accounts(id,label,note,login_email_ciphertext,login_email_hash,login_password_ciphertext,status,enabled,max_concurrency)
      VALUES(${id},${input.label ?? ''},${input.note ?? ''},${email},${hash},${password},'needs_login',${input.enabled ?? true},${input.maxConcurrency})`
    if (groupIds !== undefined) await setAccountGroups(tx, 'logicc', id, groupIds)
    return { id, created: true }
  })
}

export async function accountViews(rows: Record<string, any>[]): Promise<LogiccAccountView[]> {
  const ids = rows.map(row => String(row.id))
  const redis = getRedis()
  const [inflight, cooldowns, bindings] = await Promise.all([
    readInflightCounts(redis, LOGICC_POOL_ID, ids), readCooldowns(redis, LOGICC_POOL_ID, ids), accountGroupBindings('logicc', ids),
  ])
  return rows.map(row => {
    const id = String(row.id)
    const cooldown = cooldowns.get(id)
    const credentialKind: LogiccCredentialKind = row.client_cookie_ciphertext ? 'client' : row.has_token ? 'jwt' : 'password'
    let loginEmail: string | null = null
    try { loginEmail = row.login_email_ciphertext ? decryptSecret(row.login_email_ciphertext) : null } catch { /* unreadable */ }
    return {
      id, label: row.label, note: row.note, sessionHint: maskSession(row.session_id),
      credentialKind, canSignIn: !!row.has_password, loginHint: maskEmail(loginEmail), autoLogin: row.auto_login !== false,
      enabled: row.enabled, status: row.status,
      maxConcurrency: Number(row.max_concurrency), inFlight: inflight.accounts[id] ?? 0, cooldownUntil: cooldown ? new Date(cooldown).toISOString() : null,
      models: normalizeModels(row.models), syncError: row.sync_error,
      tokenExpiresAt: row.client_cookie_ciphertext ? null : iso(row.token_expires_at),
      lastSyncAt: iso(row.last_sync_at), lastUsedAt: iso(row.last_used_at), createdAt: iso(row.created_at)!,
      ...(bindings.get(id) ?? { groupIds: [], groupNames: [] }),
    }
  })
}

const ACCOUNT_COLUMNS = (sql: Database) => sql`id,label,note,session_id,client_cookie_ciphertext IS NOT NULL AS has_cookie,
  CASE WHEN client_cookie_ciphertext IS NULL THEN NULL ELSE 'set' END AS client_cookie_ciphertext,
  token_ciphertext IS NOT NULL AS has_token,login_password_ciphertext IS NOT NULL AS has_password,login_email_ciphertext,auto_login,
  enabled,status,max_concurrency,models,sync_error,token_expires_at,last_sync_at,last_used_at,created_at`

export async function getAccount(id: string): Promise<LogiccAccountView | null> {
  const sql = getDb()
  const rows = await sql`SELECT ${ACCOUNT_COLUMNS(sql)} FROM logicc_accounts WHERE id=${id}`
  return rows.length ? (await accountViews(rows))[0]! : null
}

export interface AccountListQuery { q?: string; status?: string; groupId?: string; page: number; pageSize: number }
export async function listAccounts(input: AccountListQuery) {
  const sql = getDb()
  const pattern = `%${(input.q ?? '').replace(/[\\%_]/g, '\\$&')}%`
  const filter = sql`WHERE (${input.q ?? ''}='' OR label ILIKE ${pattern} OR note ILIKE ${pattern} OR session_id ILIKE ${pattern})
    AND (${input.status ?? ''}='' OR status=${input.status ?? ''})
    AND (${input.groupId ?? ''}='' OR EXISTS(SELECT 1 FROM nexus_account_groups ag WHERE ag.module_id='logicc' AND ag.account_id=logicc_accounts.id::text AND ag.group_id::text=${input.groupId ?? ''}))`
  const [rows, count] = await Promise.all([
    sql`SELECT ${ACCOUNT_COLUMNS(sql)} FROM logicc_accounts ${filter} ORDER BY created_at DESC,id LIMIT ${input.pageSize} OFFSET ${(input.page - 1) * input.pageSize}`,
    sql`SELECT count(*)::int AS total FROM logicc_accounts ${filter}`,
  ])
  return { items: await accountViews(rows), total: count[0]!.total as number, page: input.page, pageSize: input.pageSize }
}

export interface AccountPatch { label?: string; note?: string; enabled?: boolean; maxConcurrency?: number; groupIds?: string[]; autoLogin?: boolean }
export async function patchAccount(id: string, values: AccountPatch): Promise<boolean> {
  return getDb().begin(async tx => {
    const rows = await tx`UPDATE logicc_accounts SET label=coalesce(${values.label ?? null},label),note=coalesce(${values.note ?? null},note),
      enabled=coalesce(${values.enabled ?? null},enabled),max_concurrency=coalesce(${values.maxConcurrency ?? null},max_concurrency),
      auto_login=coalesce(${values.autoLogin ?? null},auto_login),updated_at=now()
      WHERE id=${id} RETURNING id`
    if (!rows.length) return false
    if (values.groupIds !== undefined) await setAccountGroups(tx, 'logicc', id, values.groupIds)
    return true
  })
}

export async function setAccountsEnabled(ids: string[], enabled: boolean): Promise<number> {
  if (!ids.length) return 0
  const sql = getDb()
  return (await sql`UPDATE logicc_accounts SET enabled=${enabled},updated_at=now() WHERE id IN ${sql(ids)} RETURNING id`).length
}
export async function deleteAccounts(ids: string[]): Promise<number> {
  if (!ids.length) return 0
  const sql = getDb()
  return (await sql`DELETE FROM logicc_accounts WHERE id IN ${sql(ids)} RETURNING id`).length
}
export async function accountExists(id: string, sql: Database = getDb()): Promise<boolean> {
  return (await sql`SELECT 1 FROM logicc_accounts WHERE id=${id} FOR UPDATE`).length > 0
}
export async function accountLabels(ids: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>()
  const valid = ids.filter(id => /^[0-9a-f-]{36}$/i.test(id))
  if (!valid.length) return result
  const sql = getDb()
  for (const row of await sql`SELECT id,label,session_id FROM logicc_accounts WHERE id IN ${sql(valid)}`) result.set(String(row.id), row.label || maskSession(row.session_id) || String(row.id))
  return result
}

/** Accounts due for a background check, spread over the interval by stable ID order. */
export async function accountsDueForSync(intervalMinutes: number, limit: number): Promise<string[]> {
  const rows = await getDb()`SELECT id FROM logicc_accounts
    WHERE enabled=true AND (last_sync_at IS NULL OR last_sync_at < now() - (${intervalMinutes} * INTERVAL '1 minute'))
    ORDER BY last_sync_at ASC NULLS FIRST,id LIMIT ${limit}`
  return rows.map(row => String(row.id))
}

export async function summary() {
  const rows = await getDb()`SELECT count(*)::int AS total,count(*) FILTER(WHERE enabled)::int AS enabled,
    count(*) FILTER(WHERE enabled AND status='ready')::int AS ready,
    count(*) FILTER(WHERE enabled AND status IN ('credential_expired','sync_error','needs_login'))::int AS attention,
    count(*) FILTER(WHERE status='pending')::int AS pending FROM logicc_accounts`
  const row = rows[0]!
  return { total: row.total as number, enabled: row.enabled as number, ready: row.ready as number, needsAttention: row.attention as number, pending: row.pending as number }
}

export async function modelCoverage(): Promise<{ id: string; name: string; accounts: number }[]> {
  const rows = await getDb()`SELECT m->>'id' AS id,max(m->>'name') AS name,count(*)::int AS accounts FROM logicc_accounts a
    CROSS JOIN LATERAL jsonb_array_elements(a.models) m WHERE a.enabled=true AND a.status='ready' GROUP BY 1 ORDER BY 1`
  return rows.map(row => ({ id: String(row.id), name: String(row.name || row.id), accounts: Number(row.accounts) }))
}
