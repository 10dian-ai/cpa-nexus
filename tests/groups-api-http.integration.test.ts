import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import postgres, { type Sql } from 'postgres'
import { createApp, createRouter, toNodeListener } from 'h3'
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { migrate } from '../server/lib/migrations'
import type { GroupAccountView } from '../shared/groups'
import { DEFAULT_GROUP_ID } from '../shared/groups'

const fixture = vi.hoisted(() => ({ sql: undefined as Sql | undefined, sources: [] as GroupAccountView[], failInventory: false, prepare: vi.fn(async () => {}) }))
vi.mock('../server/lib/db', () => ({ getDb: () => fixture.sql }))
vi.mock('../server/lib/events', () => ({ publishUpdate: async () => {} }))
vi.mock('../server/lib/auth', async () => {
  const { createError, getHeader } = await import('h3')
  return { requireAdmin: async (event: Parameters<typeof getHeader>[0]) => {
    if (getHeader(event, 'cookie') !== 'ccm_session=groups-admin-test') throw createError({ statusCode: 401, message: 'Admin required' })
  }, requireServiceKey: async () => { throw createError({ statusCode: 401 }) } }
})
vi.mock('../server/lib/cpa/group-routing', async () => {
  const { createError } = await import('h3')
  const inventory = async () => { if (fixture.failInventory) throw createError({ statusCode: 502, message: 'CPA unavailable' }); return fixture.sources }
  return { listCpaGroupSources: inventory, validateCpaSource: async (id: string) => (await inventory()).find(source => source.sourceId === id) ?? null,
    prepareCpaGroupSource: fixture.prepare }
})
import admin from '../server/middleware/admin'
import listGroups from '../server/api/groups/index.get'
import createGroup from '../server/api/groups/index.post'
import patchGroup from '../server/api/groups/[id].patch'
import deleteGroup from '../server/api/groups/[id].delete'
import listSources from '../server/api/groups/accounts.get'
import patchSource from '../server/api/groups/accounts.patch'
import deleteSource from '../server/api/groups/accounts.delete'
import { accountGroupBindings, setAccountGroups, getModuleDefaultGroupIds } from '../server/lib/groups'

const databaseUrl = process.env.TEST_DATABASE_URL
const schema = 'nexus_groups_http_' + randomUUID().replaceAll('-', '')
describe.skipIf(!databaseUrl)('group administration over HTTP and PostgreSQL', () => {
  let sql: Sql, connection: Sql, server: Server, base: string, created = false, groupId: string, accountId: string
  const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
    method, headers: { cookie: 'ccm_session=groups-admin-test', 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000),
  })
  beforeAll(async () => {
    connection = postgres(databaseUrl!, { max: 1, connect_timeout: 5, onnotice: () => {} })
    await connection`CREATE SCHEMA ${connection(schema)}`; created = true
    sql = postgres(databaseUrl!, { max: 1, connect_timeout: 5, onnotice: () => {}, connection: { search_path: schema } }); fixture.sql = sql
    await migrate(sql)
    fixture.sources = []; fixture.failInventory = false; fixture.prepare.mockClear()
    const app = createApp().use(admin), router = createRouter()
    router.get('/api/groups', listGroups).post('/api/groups', createGroup).patch('/api/groups/:id', patchGroup).delete('/api/groups/:id', deleteGroup)
    router.get('/api/groups/accounts', listSources).patch('/api/groups/accounts', patchSource).delete('/api/groups/accounts', deleteSource)
    app.use(router); server = createServer(toNodeListener(app)); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    accountId = randomUUID()
    await sql`INSERT INTO managed_accounts(id,credential_fingerprint,cookie_ciphertext,label) VALUES(${accountId},${randomUUID()},'test-cookie','CC Source')`
  }, 30_000)
  afterAll(async () => {
    if (server) await new Promise<void>(resolve => { server.close(resolve); server.closeAllConnections() })
    if (sql) await sql.end({ timeout: 5 })
    if (connection) { try { if (created && /^nexus_groups_http_[a-f0-9]{32}$/.test(schema)) await connection`DROP SCHEMA ${connection(schema)} CASCADE` } finally { await connection.end({ timeout: 5 }) } }
  }, 30_000)
  it('requires an administrator and rejects a cross-origin mutation', async () => {
    const response = await request('/api/groups', 'GET', undefined, { cookie: '', authorization: 'Bearer ccm_service_test' })
    expect(response.status).toBe(401); await response.arrayBuffer()
    const crossOrigin = await request('/api/groups', 'POST', { name: 'Denied' }, { origin: 'https://other.example.invalid' })
    expect(crossOrigin.status).toBe(403); await crossOrigin.arrayBuffer()
  })
  it('creates, lists and updates a group, returning safe binding counts and preventing duplicate names', async () => {
    const created = await request('/api/groups', 'POST', { name: '  Team A  ', description: 'Two-source group' })
    expect(created.status).toBe(200); const group = await created.json(); groupId = group.id
    expect(group).toMatchObject({ name: 'Team A', description: 'Two-source group', enabled: true, accountCount: 0, keyCount: 0 })
    const listed = await (await request('/api/groups')).json()
    expect(listed.defaultGroupId).toBe(DEFAULT_GROUP_ID); expect(listed.items.some((item: { id: string }) => item.id === groupId)).toBe(true)
    expect(listed.moduleDefaultGroupIds).toEqual(await getModuleDefaultGroupIds())
    expect(new Set(listed.defaultGroupIds)).toEqual(new Set(Object.values(listed.moduleDefaultGroupIds)))
    const duplicate = await request('/api/groups', 'POST', { name: 'Team A' }); expect(duplicate.status).toBe(409); await duplicate.arrayBuffer()
    const update = await request('/api/groups/' + groupId, 'PATCH', { description: 'Changed', enabled: false })
    expect(update.status).toBe(200); expect(await update.json()).toMatchObject({ description: 'Changed', enabled: false })
    await request('/api/groups/' + groupId, 'PATCH', { enabled: true })
  })
  it('lists and rebinds a CommandCode account without changing its credential or legacy label', async () => {
    const initial = await (await request('/api/groups/accounts?moduleId=commandcode')).json()
    expect(initial.items).toContainEqual(expect.objectContaining({ sourceId: accountId, sourceType: 'commandcode', groupIds: [(await getModuleDefaultGroupIds()).commandcode] }))
    const update = await request('/api/groups/accounts', 'PATCH', { moduleId: 'commandcode', sourceType: 'commandcode', sourceId: accountId, groupIds: [groupId,DEFAULT_GROUP_ID] })
    expect(update.status).toBe(200); await update.arrayBuffer()
    const binding = (await accountGroupBindings('commandcode', [accountId])).get(accountId)!
    expect(new Set(binding.groupIds)).toEqual(new Set([groupId,DEFAULT_GROUP_ID]))
    expect((await sql`SELECT cookie_ciphertext,group_name FROM managed_accounts WHERE id=${accountId}`)[0]).toMatchObject({ cookie_ciphertext: 'test-cookie', group_name: '' })
    const remove = await request('/api/groups/' + groupId, 'DELETE'); expect(remove.status).toBe(409); await remove.arrayBuffer()
  })
  it('exposes missing CPA ledger entries without automatically deleting their retained permission', async () => {
    await sql.begin(tx => setAccountGroups(tx, 'cpa', 'deleted-oauth.json', [groupId]))
    const listed = await request('/api/groups/accounts?moduleId=cpa')
    expect(listed.status).toBe(200)
    const items = (await listed.json()).items
    expect(items).toContainEqual(expect.objectContaining({ sourceId: 'deleted-oauth.json', missing: true, enabled: false, routingSupported: false, groupIds: [groupId] }))
    expect((await accountGroupBindings('cpa')).has('deleted-oauth.json')).toBe(true)
  })
  it('keeps the readable module visible and reports a failed CPA read without inventing missing sources', async () => {
    fixture.failInventory = true
    try {
      const mixed = await request('/api/groups/accounts')
      expect(mixed.status).toBe(200)
      const result = await mixed.json()
      expect(result.items).toContainEqual(expect.objectContaining({ sourceId: accountId, moduleId: 'commandcode' }))
      expect(result.items.some((item: GroupAccountView) => item.moduleId === 'cpa')).toBe(false)
      expect(result.issues).toEqual([expect.objectContaining({ moduleId: 'cpa', message: expect.any(String) })])
      const isolated = await (await request('/api/groups/accounts?moduleId=cpa')).json()
      expect(isolated.items).toEqual([])
      expect(isolated.issues).toHaveLength(1)
      expect((await accountGroupBindings('cpa')).has('deleted-oauth.json')).toBe(true)
    } finally { fixture.failInventory = false }
  })
  it('clears only missing CPA bindings and rejects active sources or a failed inventory read', async () => {
    const activeSource = 'active-oauth.json'
    await sql.begin(tx => setAccountGroups(tx, 'cpa', activeSource, [groupId]))
    fixture.sources = [{ id: activeSource, sourceId: activeSource, sourceType: 'cpa', moduleId: 'cpa', name: 'Active', provider: 'test', enabled: true, groupIds: [groupId], groupNames: ['Team A'], routingSupported: true }]
    const active = await request('/api/groups/accounts', 'DELETE', { moduleId: 'cpa', sourceType: 'cpa', sourceId: activeSource })
    expect(active.status).toBe(409); await active.arrayBuffer()
    expect((await accountGroupBindings('cpa')).has(activeSource)).toBe(true)
    fixture.failInventory = true
    const failure = await request('/api/groups/accounts', 'DELETE', { moduleId: 'cpa', sourceType: 'cpa', sourceId: 'deleted-oauth.json' })
    expect(failure.status).toBe(502); await failure.arrayBuffer()
    expect((await accountGroupBindings('cpa')).has('deleted-oauth.json')).toBe(true)
    fixture.failInventory = false
    const removed = await request('/api/groups/accounts', 'DELETE', { moduleId: 'cpa', sourceType: 'cpa', sourceId: 'deleted-oauth.json' })
    expect(removed.status).toBe(200); expect(await removed.json()).toEqual({ ok: true })
    expect((await accountGroupBindings('cpa')).has('deleted-oauth.json')).toBe(false)
    expect((await accountGroupBindings('cpa')).has(activeSource)).toBe(true)
    const invalid = await request('/api/groups/accounts', 'DELETE', { moduleId: 'commandcode', sourceType: 'commandcode', sourceId: accountId })
    expect(invalid.status).toBe(400); await invalid.arrayBuffer()
  })
})
