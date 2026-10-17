import { randomUUID } from 'node:crypto'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { migrate } from '../server/lib/migrations'

const fixture = vi.hoisted(() => ({ sql: undefined as Sql | undefined }))
vi.mock('../server/lib/db', () => ({ getDb: () => fixture.sql }))
vi.mock('../server/lib/events', () => ({ publishUpdate: async () => {} }))
vi.mock('../server/lib/config', () => ({ getConfig: () => ({ encryptionKey: Buffer.alloc(32, 9).toString('base64') }) }))
import { createGroup, getModuleDefaultGroupIds, patchGroup } from '../server/lib/groups'
import { groupModels, listCandidates, loadCredential, loginEmailHash, googleEmailHash, maskEmail, servingModels, storeRotatedCookie, storeSignInResult, summary, upsertAccount, upsertGoogleAccount, upsertPasswordAccount } from '../server/modules/logicc/store'

const databaseUrl = process.env.TEST_DATABASE_URL
const schema = 'nexus_logicc_store_' + randomUUID().replaceAll('-', '')
const models = (...ids: string[]) => ids.map(id => ({ id, name: id, provider: 'anthropic', isDefault: false }))

describe.skipIf(!databaseUrl)('Logicc account pool on PostgreSQL', () => {
  let admin: Sql, sql: Sql, created = false
  let logiccGroup: string, teamGroup: string, a: string, b: string
  beforeAll(async () => {
    admin = postgres(databaseUrl!, { max: 1, connect_timeout: 5, onnotice: () => {} })
    await admin`CREATE SCHEMA ${admin(schema)}`; created = true
    sql = postgres(databaseUrl!, { max: 2, connect_timeout: 5, onnotice: () => {}, connection: { search_path: schema } }); fixture.sql = sql
    await migrate(sql)
    logiccGroup = (await getModuleDefaultGroupIds()).logicc
    teamGroup = (await createGroup({ name: 'Team B' })).id
    a = (await upsertAccount({ sessionId: 'sess_accounta1', clientCookie: 'cookie-a', token: null, tokenExpiresAt: null, maxConcurrency: 2 })).id
    b = (await upsertAccount({ sessionId: 'sess_accountb1', clientCookie: 'cookie-b', token: null, tokenExpiresAt: null, maxConcurrency: 0 }, [teamGroup])).id
    await sql`UPDATE logicc_accounts SET status='ready',models=${sql.json(models('claude-x', 'gpt-y') as never)} WHERE id=${a}`
    await sql`UPDATE logicc_accounts SET status='ready',models=${sql.json(models('claude-x') as never)} WHERE id=${b}`
  }, 60_000)
  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 })
    if (admin) { try { if (created) await admin`DROP SCHEMA ${admin(schema)} CASCADE` } finally { await admin.end({ timeout: 5 }) } }
  }, 30_000)

  it('selects accounts only from the serving group', async () => {
    expect((await listCandidates(logiccGroup, 'claude-x')).map(item => item.id)).toEqual([a])
    expect((await listCandidates(teamGroup, 'claude-x'))).toEqual([{ id: b, limit: 0 }])
    expect(await listCandidates(teamGroup, 'gpt-y')).toEqual([])
    const served = await groupModels([logiccGroup, teamGroup])
    expect(served.get(logiccGroup)).toEqual(['claude-x', 'gpt-y'])
    expect(served.get(teamGroup)).toEqual(['claude-x'])
    expect(await servingModels()).toEqual(['claude-x', 'gpt-y'])
  })

  it('drops disabled groups, disabled accounts and accounts that are not ready', async () => {
    await patchGroup(teamGroup, { enabled: false })
    expect(await listCandidates(teamGroup, 'claude-x')).toEqual([])
    await patchGroup(teamGroup, { enabled: true })
    await sql`UPDATE logicc_accounts SET status='credential_expired' WHERE id=${a}`
    expect(await listCandidates(logiccGroup, 'claude-x')).toEqual([])
    // Its models stay published, so callers get a retryable 503 rather than "model not found".
    expect(await servingModels()).toEqual(['claude-x', 'gpt-y'])
    await sql`UPDATE logicc_accounts SET status='pending' WHERE id=${a}`
    expect(await servingModels()).toEqual(['claude-x'])
    await sql`UPDATE logicc_accounts SET status='ready',enabled=false WHERE id=${a}`
    expect(await listCandidates(logiccGroup, 'claude-x')).toEqual([])
    await sql`UPDATE logicc_accounts SET enabled=true WHERE id=${a}`
  })

  it('keeps one account per Logicc session and encrypts credentials at rest', async () => {
    const again = await upsertAccount({ sessionId: 'sess_accounta1', clientCookie: 'cookie-a-new', token: null, tokenExpiresAt: null, maxConcurrency: 2, label: 'Renamed' })
    expect(again).toEqual({ id: a, created: false })
    const raw = (await sql`SELECT client_cookie_ciphertext,label,status FROM logicc_accounts WHERE id=${a}`)[0]!
    expect(raw.client_cookie_ciphertext).not.toContain('cookie-a-new')
    expect(raw).toMatchObject({ label: 'Renamed', status: 'pending' })
    const credential = (await loadCredential(a))!
    expect(credential.clientCookie).toBe('cookie-a-new')
    // A rotated cookie is stored only if nobody replaced the credentials meanwhile.
    expect(await storeRotatedCookie(a, 'rotated', credential.credentialVersion)).toBe(true)
    expect(await storeRotatedCookie(a, 'stale', credential.credentialVersion)).toBe(false)
    expect((await loadCredential(a))!.clientCookie).toBe('rotated')
    expect(await summary()).toMatchObject({ total: 2, enabled: 2 })
  })

  it('adds a password account without a session, then a sign-in fills it in', async () => {
    const { id, created } = await upsertPasswordAccount({ loginEmail: 'Boss@Work.CO', loginPassword: 'secret-pw', label: 'Pw acct', maxConcurrency: 3 })
    expect(created).toBe(true)
    // No session yet, waiting to log in, but its credentials are stored encrypted and never echoed.
    const raw = (await sql`SELECT session_id,status,login_email_ciphertext,login_password_ciphertext,login_email_hash FROM logicc_accounts WHERE id=${id}`)[0]!
    expect(raw.session_id).toBeNull()
    expect(raw.status).toBe('needs_login')
    expect(raw.login_password_ciphertext).not.toContain('secret-pw')
    expect(raw.login_email_hash).toBe(loginEmailHash('boss@work.co'))
    const record = (await loadCredential(id))!
    expect(record).toMatchObject({ loginEmail: 'Boss@Work.CO', loginPassword: 'secret-pw', sessionId: null, autoLogin: true })

    // Re-importing the same email (any case) updates the password and keeps one row.
    const again = await upsertPasswordAccount({ loginEmail: 'boss@work.co', loginPassword: 'new-pw', maxConcurrency: 3 })
    expect(again).toEqual({ id, created: false })
    expect((await loadCredential(id))!.loginPassword).toBe('new-pw')

    // A completed sign-in attaches the session and cookie; the account becomes checkable.
    const stored = await storeSignInResult(id, { sessionId: 'sess_pwlogin001', clientCookie: 'fresh-client', token: null }, (await loadCredential(id))!.credentialVersion)
    expect(stored).toBe(true)
    const signed = (await loadCredential(id))!
    expect(signed).toMatchObject({ sessionId: 'sess_pwlogin001', clientCookie: 'fresh-client', status: 'pending' })
    expect(maskEmail('boss@work.co')).toBe('bo***@work.co')
  })

  it('adds a Google account without a session, then a kernel harvest fills it in', async () => {
    const { id, created } = await upsertGoogleAccount({ googleEmail: 'Sam@Gmail.COM', googlePassword: 'g-pass', googleTotp: 'JBSWY3DPEHPK3PXP', googleProfile: JSON.stringify({ firstName: 'Sam' }), label: 'Google acct', maxConcurrency: 2 })
    expect(created).toBe(true)
    // No session yet; Google credentials are stored encrypted and never echoed.
    const raw = (await sql`SELECT session_id,status,google_email_ciphertext,google_password_ciphertext,google_totp_ciphertext,google_email_hash FROM logicc_accounts WHERE id=${id}`)[0]!
    expect(raw.session_id).toBeNull()
    expect(raw.status).toBe('needs_login')
    expect(raw.google_password_ciphertext).not.toContain('g-pass')
    expect(raw.google_totp_ciphertext).not.toContain('JBSWY3DPEHPK3PXP')
    expect(raw.google_email_hash).toBe(googleEmailHash('sam@gmail.com'))
    expect((await loadCredential(id))).toMatchObject({ googleEmail: 'Sam@Gmail.COM', googlePassword: 'g-pass', googleTotp: 'JBSWY3DPEHPK3PXP', googleProfile: JSON.stringify({ firstName: 'Sam' }), sessionId: null })

    // Re-importing the same Google email updates the credentials and keeps one row.
    const again = await upsertGoogleAccount({ googleEmail: 'sam@gmail.com', googlePassword: 'new-pass', googleTotp: 'JBSWY3DPEHPK3PXQ', maxConcurrency: 2 })
    expect(again).toEqual({ id, created: false })
    expect((await loadCredential(id))!.googlePassword).toBe('new-pass')

    // A kernel harvest attaches the session and cookie, like a password sign-in.
    const stored = await storeSignInResult(id, { sessionId: 'sess_google001', clientCookie: 'harvested-client', token: null }, (await loadCredential(id))!.credentialVersion)
    expect(stored).toBe(true)
    expect((await loadCredential(id))).toMatchObject({ sessionId: 'sess_google001', clientCookie: 'harvested-client', status: 'pending' })
  })
})
