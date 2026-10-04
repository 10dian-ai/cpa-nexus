import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import postgres, { type Sql } from 'postgres'
import { createApp, createRouter, toNodeListener } from 'h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { migrate } from '../server/lib/migrations'

const fixture = vi.hoisted(() => ({ sql: undefined as Sql | undefined, jobs: new Map<string, { text: string; groupName?: string; groupIds?: string[] }>() }))
vi.mock('../server/lib/db', () => ({ getDb: () => fixture.sql }))
vi.mock('../server/lib/events', () => ({ publishUpdate: async () => {} }))
vi.mock('../server/lib/config', () => ({ getConfig: () => ({ encryptionKey: Buffer.alloc(32, 7).toString('base64') }) }))
vi.mock('../server/lib/redis', () => ({ getRedis: () => ({ get: async (key: string) => key.startsWith('ccm:admin:session:') ? 'test-admin' : null }) }))
vi.mock('../server/lib/queues', () => ({
  enqueueAccountRefresh: async () => {},
  queueImport: async (text: string, groupName?: string, groupIds?: string[]) => {
    const jobId = randomUUID()
    fixture.jobs.set(jobId, { text, groupName, groupIds })
    return { jobId, accepted: 1, rejected: 0, duplicates: 0 }
  },
}))
import admin from '../server/middleware/admin'
import externalImport from '../server/api/external/accounts.post'
import adminImport from '../server/api/accounts/import.post'
import { attachIdentity, createPendingAccount } from '../server/lib/accounts'
import { accountGroupBindings, getModuleDefaultGroupIds, keyGroupBindings, setAccountGroups, setKeyGroups } from '../server/lib/groups'
import { hashGatewayKey } from '../server/lib/crypto'

const databaseUrl = process.env.TEST_DATABASE_URL
const schema = 'nexus_import_defaults_' + randomUUID().replaceAll('-', '')
describe.skipIf(!databaseUrl)('omitted source groups through import APIs and PostgreSQL account persistence', () => {
  let sql: Sql, connection: Sql, server: Server, base: string, created = false
  let defaults: { commandcode: string; cpa: string }
  const serviceSecret = 'ccm_service_' + 'c'.repeat(43)
  beforeAll(async () => {
    connection = postgres(databaseUrl!, { max: 1, connect_timeout: 5, onnotice: () => {} })
    await connection`CREATE SCHEMA ${connection(schema)}`; created = true
    sql = postgres(databaseUrl!, { max: 1, connect_timeout: 5, onnotice: () => {}, connection: { search_path: schema } }); fixture.sql = sql
    await migrate(sql)
    defaults = await getModuleDefaultGroupIds()
    await sql`INSERT INTO service_keys(id,name,prefix,secret_hash) VALUES(${randomUUID()},'Isolated importer',${serviceSecret.slice(0, 12)},${hashGatewayKey(serviceSecret)})`
    const router = createRouter().post('/api/external/accounts', externalImport).post('/api/accounts/import', adminImport)
    const app = createApp().use(admin).use(router)
    server = createServer(toNodeListener(app)); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }, 30_000)
  afterAll(async () => {
    if (server) await new Promise<void>(resolve => { server.close(resolve); server.closeAllConnections() })
    if (sql) await sql.end({ timeout: 5 })
    if (connection) { try { if (created && /^nexus_import_defaults_[a-f0-9]{32}$/.test(schema)) await connection`DROP SCHEMA ${connection(schema)} CASCADE` } finally { await connection.end({ timeout: 5 }) } }
  }, 30_000)
  const request = (endpoint: string, body: unknown) => fetch(base + endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(endpoint.startsWith('/api/external/') ? { authorization: 'Bearer ' + serviceSecret } : { cookie: 'ccm_session=test-admin-import' }) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(3000),
  })
  const persistImport = async (jobId: string) => {
    const job = fixture.jobs.get(jobId)!
    // The queue boundary is isolated; the account creation and identity merge use
    // the same actual persistence functions called by the production worker.
    const account = await createPendingAccount(randomUUID(), 'synthetic-import-cookie', job.groupName, job.groupIds)
    const merged = await attachIdentity(account.id, { id: randomUUID(), name: 'Imported fixture', email: null }, account.credential_fingerprint, account.cookie_ciphertext, job.groupName, job.groupIds)
    return merged.account.id as string
  }
  it.each([
    { endpoint: '/api/external/accounts', field: 'token', status: 202 },
    { endpoint: '/api/external/accounts', field: 'cookie', status: 202 },
    { endpoint: '/api/external/accounts', field: 'text', status: 202 },
    { endpoint: '/api/accounts/import', field: 'text', status: 200 },
  ])('keeps omitted groupIds on $endpoint $field imports in the CommandCode group alone', async ({ endpoint, field, status }) => {
    const response = await request(endpoint, { [field]: 'synthetic-import-' + randomUUID() })
    expect(response.status).toBe(status)
    const receipt = await response.json()
    expect(fixture.jobs.get(receipt.jobId)?.groupIds).toBeUndefined()
    const accountId = await persistImport(receipt.jobId)
    expect((await accountGroupBindings('commandcode', [accountId])).get(accountId)?.groupIds).toEqual([defaults.commandcode])
    expect((await accountGroupBindings('commandcode', [accountId])).get(accountId)?.groupIds).not.toContain(defaults.cpa)
  })
  it('preserves explicit multi-group choices from the external importer', async () => {
    const groups = [defaults.commandcode, defaults.cpa]
    const response = await request('/api/external/accounts', { token: 'synthetic-explicit-' + randomUUID(), groupIds: groups })
    expect(response.status).toBe(202)
    const accountId = await persistImport((await response.json()).jobId)
    expect(new Set((await accountGroupBindings('commandcode', [accountId])).get(accountId)?.groupIds)).toEqual(new Set(groups))
  })
  it('uses one module default for omitted source assignment and both defaults for an omitted model key assignment', async () => {
    const accountId = randomUUID(), keyId = randomUUID()
    await sql`INSERT INTO managed_accounts(id,credential_fingerprint,cookie_ciphertext) VALUES(${accountId},${randomUUID()},'synthetic-direct-cookie')`
    await setAccountGroups(sql, 'commandcode', accountId)
    await setAccountGroups(sql, 'cpa', 'synthetic-oauth.json')
    await sql`INSERT INTO gateway_keys(id,name,prefix,secret_hash) VALUES(${keyId},'Synthetic model key','ccm_defaults',${randomUUID()})`
    await setKeyGroups(sql, keyId)
    expect((await accountGroupBindings('commandcode', [accountId])).get(accountId)?.groupIds).toEqual([defaults.commandcode])
    expect((await accountGroupBindings('cpa', ['synthetic-oauth.json'])).get('synthetic-oauth.json')?.groupIds).toEqual([defaults.cpa])
    expect(new Set((await keyGroupBindings([keyId])).get(keyId)?.groupIds)).toEqual(new Set([defaults.commandcode, defaults.cpa]))
  })
})
