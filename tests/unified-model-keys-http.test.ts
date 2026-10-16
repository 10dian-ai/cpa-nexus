import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, createError, createRouter, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelModuleId } from '../shared/keys'
import { DEFAULT_GROUP_ID } from '../shared/groups'

interface StoredKey {
  id: string; name: string; prefix: string; secret_hash: string; enabled: boolean
  module_id: ModelModuleId; group_strategy?: 'failover' | 'mixed'; created_at: Date; last_used_at: Date | null
}
const fixture = vi.hoisted(() => ({
  keys: new Map<string, StoredKey>(), sessions: new Map<string, string>(),
  disabled: new Set<string>(), queries: [] as { sql: string; values: unknown[] }[],
  keyGroups: new Map<string, string[]>(), failGroupSave: false, failGroupRead: false,
  publish: vi.fn(async () => 1),
  defaultModelGroupIds: ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'],
}))
vi.mock('../server/lib/modules', () => ({ requireModule: async (id: string) => {
  if (fixture.disabled.has(id)) throw createError({ statusCode: 503, message: '此模块已停用' })
} }))
vi.mock('../server/lib/db', () => {
  const sqlQuery = async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const sql = strings.join('?').replace(/\s+/g, ' ').trim()
  fixture.queries.push({ sql, values })
  if (sql.startsWith('INSERT INTO gateway_keys')) {
    const row: StoredKey = { id: String(values[0]), name: String(values[1]), prefix: String(values[2]),
      secret_hash: String(values[3]), module_id: values[4] as ModelModuleId, group_strategy: values[5] as 'failover' | 'mixed', enabled: true,
      created_at: new Date('2026-10-03T00:00:00.000Z'), last_used_at: null }
    fixture.keys.set(row.id, row); return [{ created_at: row.created_at }]
  }
  if (sql.startsWith('SELECT')) {
    let rows = [...fixture.keys.values()]
    if (sql.includes('secret_hash=')) rows = rows.filter(row => row.secret_hash === values[0])
    else if (sql.includes('WHERE id=')) rows = rows.filter(row => row.id === values[0])
    if (sql.includes('enabled=true')) rows = rows.filter(row => row.enabled)
    if (sql.includes("left(prefix,10)<>'ccm_nexus_'")) rows = rows.filter(row => !row.prefix.startsWith('ccm_nexus_'))
    return rows.map(row => ({ ...row }))
  }
  if (sql.startsWith('UPDATE gateway_keys SET last_used_at')) {
    const row = fixture.keys.get(String(values[0])); if (row) row.last_used_at = new Date()
    return []
  }
  if (sql.startsWith('UPDATE gateway_keys SET name=coalesce')) {
    const row = fixture.keys.get(String(values[4]))
    if (!row || row.prefix.startsWith('ccm_nexus_')) return []
    if (values[0] !== null) row.name = String(values[0])
    if (values[1] !== null) row.enabled = Boolean(values[1])
    if (values[2] !== null) row.module_id = values[2] as ModelModuleId
    if (values[3] !== null) row.group_strategy = values[3] as 'failover' | 'mixed'
    return [{ id: row.id, module_id: row.module_id, group_strategy: row.group_strategy ?? 'failover' }]
  }
  if (sql.startsWith('DELETE FROM gateway_keys')) {
    const row = fixture.keys.get(String(values[0]))
    if (row && !row.prefix.startsWith('ccm_nexus_')) fixture.keys.delete(row.id)
    return []
  }
  throw new Error('Unexpected model key fixture query: ' + sql)
  }
  return { getDb: () => Object.assign(sqlQuery, { begin: async (callback: (tx: typeof sqlQuery) => Promise<unknown>) => {
    const keys = new Map([...fixture.keys].map(([id, row]) => [id, { ...row }]))
    const groups = new Map(fixture.keyGroups)
    try { return await callback(sqlQuery) }
    catch (error) { fixture.keys = keys; fixture.keyGroups = groups; throw error }
  } }) }
})
vi.mock('../server/lib/groups', async () => { const { z } = await import('zod'); return {
  groupIdsSchema: z.array(z.string().uuid()).min(1),
  setKeyGroups: async (_tx: unknown, id: string, groupIds?: string[]) => {
    if (fixture.failGroupSave) throw createError({ statusCode: 503, message: 'Group storage unavailable' })
    fixture.keyGroups.set(id, groupIds ?? [...fixture.defaultModelGroupIds])
  },
  keyGroupBindings: async (ids: string[]) => {
    if (fixture.failGroupRead) throw createError({ statusCode: 503, message: 'Group read unavailable' })
    return new Map(ids.map(id => [id, { groupIds: fixture.keyGroups.get(id) ?? [...fixture.defaultModelGroupIds], groupNames: ['CPA', 'CommandCode'] }]))
  },
} })
vi.mock('../server/lib/redis', () => ({ getRedis: () => ({
  get: async (key: string) => fixture.sessions.get(key) ?? null, publish: fixture.publish,
}) }))

import { authenticateGatewayKey, findEnabledModelKey } from '../server/lib/auth'
import { hashGatewayKey } from '../server/lib/crypto'
import adminMiddleware from '../server/middleware/admin'
import listKeys from '../server/api/keys/index.get'
import createKey from '../server/api/keys/index.post'
import updateKey from '../server/api/keys/[id].patch'
import deleteKey from '../server/api/keys/[id].delete'

const KEY_ID = '11111111-1111-4111-8111-111111111111'
const BRIDGE_ID = '22222222-2222-4222-8222-222222222222'
const KEY = 'ccm_' + 'a'.repeat(43)
const BRIDGE_KEY = 'ccm_nexus_' + 'b'.repeat(43)
function seed(id: string, secret: string, moduleId: ModelModuleId = 'auto') {
  const row: StoredKey = { id, name: 'Existing key', prefix: secret.slice(0, 12), secret_hash: hashGatewayKey(secret),
    module_id: moduleId, enabled: true, created_at: new Date('2026-10-02T00:00:00.000Z'), last_used_at: null }
  fixture.keys.set(id, row); return row
}

describe('unified model keys with persistent module binding over HTTP', () => {
  let server: Server, base: string
  const request = (path: string, method = 'GET', body?: unknown) => fetch(base + path, {
    method, headers: { cookie: 'ccm_session=admin-model-keys', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000),
  })
  beforeEach(async () => {
    fixture.keys.clear(); fixture.sessions.clear(); fixture.disabled.clear(); fixture.queries.length = 0; fixture.publish.mockClear(); fixture.keyGroups.clear(); fixture.failGroupSave = false; fixture.failGroupRead = false
    seed(KEY_ID, KEY); seed(BRIDGE_ID, BRIDGE_KEY, 'auto')
    fixture.sessions.set('ccm:admin:session:' + hashGatewayKey('admin-model-keys'), 'admin')
    const app = createApp(); app.use(adminMiddleware)
    const router = createRouter(); router.get('/api/keys', listKeys); router.post('/api/keys', createKey)
    router.patch('/api/keys/:id', updateKey); router.delete('/api/keys/:id', deleteKey); app.use(router)
    server = createServer(toNodeListener(app)); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => { await new Promise<void>(resolve => { server.close(resolve); server.closeAllConnections() }) })

  it('persists explicit module bindings, stores only hashes and returns safe metadata', async () => {
    for (const moduleId of ['auto', 'cpa'] as const) {
      const response = await request('/api/keys', 'POST', { name: '  ' + moduleId + ' client  ', moduleId })
      expect(response.status).toBe(200)
      const created = await response.json()
      expect(created.key).toMatch(/^ccm_[A-Za-z0-9_-]{43}$/)
      expect(created.item).toMatchObject({ name: moduleId + ' client', moduleId, groupStrategy: 'failover', enabled: true, groupIds: fixture.defaultModelGroupIds })
      expect(fixture.keys.get(created.item.id)?.module_id).toBe(moduleId)
      expect(await authenticateGatewayKey(created.key)).toEqual({ id: created.item.id, name: moduleId + ' client', moduleId })
      const insert = fixture.queries.filter(query => query.sql.startsWith('INSERT INTO gateway_keys')).at(-1)!
      expect(insert.values).not.toContain(created.key)
      expect(insert.values).toContain(hashGatewayKey(created.key))
      const listed = await (await request('/api/keys')).json()
      expect(listed.items.find((key: { id: string }) => key.id === created.item.id)).toMatchObject({ ...created.item, lastUsedAt: expect.any(String) })
      expect(JSON.stringify(listed)).not.toContain(created.key)
      expect(JSON.stringify(listed)).not.toContain(hashGatewayKey(created.key))
      expect(listed.items.some((key: { id: string }) => key.id === BRIDGE_ID)).toBe(false)
    }
  })

  it('changes module bindings between unified routing and CPA-only', async () => {
    expect(await authenticateGatewayKey(KEY)).toEqual({ id: KEY_ID, name: 'Existing key', moduleId: 'auto' })
    for (const moduleId of ['cpa', 'auto'] as const) {
      const changed = await request(`/api/keys/${KEY_ID}`, 'PATCH', { moduleId, name: 'Moved key' })
      expect(await changed.json()).toMatchObject({ ok: true, moduleId })
      const key = (await authenticateGatewayKey(KEY))!
      expect(key).toEqual({ id: KEY_ID, name: 'Moved key', moduleId })
      const listed = await (await request('/api/keys')).json()
      expect(listed.items[0]).toMatchObject({ id: KEY_ID, moduleId })
      expect(await findEnabledModelKey(KEY_ID)).toEqual(key)
    }
  })

  it('preserves an existing module binding during unrelated key edits', async () => {
    seed(KEY_ID, KEY, 'cpa')
    for (const body of [{ name: 'Renamed CPA key' }, { enabled: false }, { groupStrategy: 'mixed' }, { groupIds: [DEFAULT_GROUP_ID] }]) {
      const response = await request(`/api/keys/${KEY_ID}`, 'PATCH', body)
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ ok: true, moduleId: 'cpa' })
      expect(fixture.keys.get(KEY_ID)?.module_id).toBe('cpa')
    }
  })

  it('defaults new model keys to unified routing while retaining historical internal identities', async () => {
    const created = await (await request('/api/keys', 'POST', { name: 'Old client' })).json()
    expect(created.item.moduleId).toBe('auto')
    expect(created.item.groupStrategy).toBe('failover')
    // Rows written before migration 021 with the removed module read back as unified keys.
    seed(KEY_ID, KEY, 'commandcode' as never)
    expect(await authenticateGatewayKey(KEY)).toMatchObject({ moduleId: 'auto' })
  })

  it('saves the multi-group strategy with key creation and edits', async () => {
    const response = await request('/api/keys', 'POST', { name: 'Mixed key', groupStrategy: 'mixed' })
    expect(response.status).toBe(200)
    const created = await response.json()
    expect(created.item).toMatchObject({ moduleId: 'auto', groupStrategy: 'mixed' })
    expect(fixture.keys.get(created.item.id)?.group_strategy).toBe('mixed')
    fixture.publish.mockRejectedValueOnce(new Error('Notification unavailable'))
    const second = await request('/api/keys', 'POST', { name: 'No notification' })
    expect(second.status).toBe(200)
    expect((await second.json()).key).toMatch(/^ccm_[A-Za-z0-9_-]{43}$/)
  })

  it('changes only the supplied strategy and preserves it during unrelated edits', async () => {
    const mixed = await request(`/api/keys/${KEY_ID}`, 'PATCH', { groupStrategy: 'mixed' })
    expect(await mixed.json()).toMatchObject({ ok: true, groupStrategy: 'mixed' })
    const rename = await request(`/api/keys/${KEY_ID}`, 'PATCH', { name: 'Renamed mixed key' })
    expect(await rename.json()).toMatchObject({ groupStrategy: 'mixed' })
    const listed = await (await request('/api/keys')).json()
    expect(listed.items.find((key: { id: string }) => key.id === KEY_ID)).toMatchObject({ groupStrategy: 'mixed' })
    const failover = await request(`/api/keys/${KEY_ID}`, 'PATCH', { groupStrategy: 'failover' })
    expect(await failover.json()).toMatchObject({ groupStrategy: 'failover' })
  })

  it('rolls back a new or edited key if saving its groups fails', async () => {
    fixture.failGroupSave = true
    const creation = await request('/api/keys', 'POST', { name: 'Must roll back', groupIds: [DEFAULT_GROUP_ID] })
    expect(creation.status).toBe(503); await creation.arrayBuffer()
    expect(fixture.keys.size).toBe(2)
    const edit = await request(`/api/keys/${KEY_ID}`, 'PATCH', { name: 'Must roll back edit', moduleId: 'cpa', groupIds: [DEFAULT_GROUP_ID] })
    expect(edit.status).toBe(503); await edit.arrayBuffer()
    expect(fixture.keys.get(KEY_ID)).toMatchObject({ name: 'Existing key', module_id: 'auto' })
    expect(fixture.publish).not.toHaveBeenCalled()
  })
  it('rolls back creation if reading the response group binding fails, preserving one-time secret delivery', async () => {
    fixture.failGroupRead = true
    const response = await request('/api/keys', 'POST', { name: 'Must roll back group read' })
    expect(response.status).toBe(503); await response.arrayBuffer()
    expect(fixture.keys.size).toBe(2)
    expect(fixture.keyGroups.size).toBe(0)
    expect(fixture.publish).not.toHaveBeenCalled()
  })

  it('lets keys be managed while a source module is stopped and rejects the removed module binding', async () => {
    fixture.disabled.add('logicc')
    const create = await request('/api/keys', 'POST', { name: 'Stopped module', moduleId: 'auto' })
    expect(create.status).toBe(200); await create.arrayBuffer()
    const removedModule = await request(`/api/keys/${KEY_ID}`, 'PATCH', { moduleId: 'commandcode' })
    expect(removedModule.status).toBe(400); await removedModule.arrayBuffer()
    const disabled = await request(`/api/keys/${KEY_ID}`, 'PATCH', { enabled: false })
    expect(disabled.status).toBe(200); await disabled.arrayBuffer()
    expect(await authenticateGatewayKey(KEY)).toBeNull(); expect(await findEnabledModelKey(KEY_ID)).toBeNull()
    const removed = await request(`/api/keys/${KEY_ID}`, 'DELETE')
    expect(removed.status).toBe(200); await removed.arrayBuffer(); expect(fixture.keys.has(KEY_ID)).toBe(false)
  })

  it('keeps system bridge keys hidden and immutable through the public key API', async () => {
    expect(await findEnabledModelKey(BRIDGE_ID)).toBeNull()
    const patched = await request(`/api/keys/${BRIDGE_ID}`, 'PATCH', { moduleId: 'cpa', enabled: false })
    expect(patched.status).toBe(404); await patched.arrayBuffer()
    const deleted = await request(`/api/keys/${BRIDGE_ID}`, 'DELETE')
    expect(deleted.status).toBe(200); await deleted.arrayBuffer()
    expect(fixture.keys.get(BRIDGE_ID)).toMatchObject({ enabled: true, module_id: 'auto' })
    const before = fixture.queries.length
    expect(await findEnabledModelKey('forged-original-id')).toBeNull(); expect(fixture.queries).toHaveLength(before)
  })

  it('rejects unsupported module types and malformed edits before persistence', async () => {
    for (const body of [{ name: 'Invalid', moduleId: 'presets' }, { name: 'Invalid', moduleId: [] }, { name: 'Invalid', extra: true }, { name: 'Invalid', presetEnabled: true }, { name: 'Invalid', groupStrategy: 'random' }]) {
      const response = await request('/api/keys', 'POST', body)
      expect(response.status).toBe(400); await response.arrayBuffer()
    }
    for (const body of [{ moduleId: 'platform' }, { moduleId: null }, {}, { unrelated: true }, { presetEnabled: false }, { groupStrategy: null }]) {
      const response = await request(`/api/keys/${KEY_ID}`, 'PATCH', body)
      expect(response.status).toBe(400); await response.arrayBuffer()
    }
    expect(fixture.keys.size).toBe(2); expect(fixture.keys.get(KEY_ID)?.module_id).toBe('auto')
  })
  it('supports multiple group assignments and rejects an empty group selection before persistence', async () => {
    const ids = [DEFAULT_GROUP_ID, '33333333-3333-4333-8333-333333333333']
    const create = await request('/api/keys', 'POST', { name: 'Multi group key', groupIds: ids })
    expect(create.status).toBe(200)
    const created = await create.json()
    expect(created.item.groupIds).toEqual(ids)
    const edit = await request(`/api/keys/${created.item.id}`, 'PATCH', { groupIds: [ids[1]] })
    expect(edit.status).toBe(200); expect((await edit.json()).groupIds).toEqual([ids[1]])
    for (const method of ['POST','PATCH']) {
      const response = await request(method === 'POST' ? '/api/keys' : `/api/keys/${KEY_ID}`, method, method === 'POST' ? { name: 'Empty', groupIds: [] } : { groupIds: [] })
      expect(response.status).toBe(400); await response.arrayBuffer()
    }
  })
})
