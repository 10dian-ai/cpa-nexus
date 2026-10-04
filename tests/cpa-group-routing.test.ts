import { beforeEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ credentials: [] as Record<string, unknown>[], documents: new Map<string, Record<string, unknown>>(),
  bindings: new Map<string, { groupIds: string[]; groupNames: string[] }>(), models: new Map<string, string[]>(), patches: [] as any[],
  config: [] as any[], plugins: [] as any[], persistent: true, request: vi.fn() }))
vi.mock('../server/lib/cpa/client', () => ({ createCpaClient: () => ({ request: fixture.request }) }))
vi.mock('../server/lib/cpa/preset-routing', () => ({ resetCpaPresetAccountRoutes: () => {} }))
vi.mock('../server/lib/cpa/preset-config-routing', () => ({ readCpaConfigGroupSources: async () => fixture.config,
  ensureCpaConfigAccountRoute: async (_client: unknown, credential: { id: string }, prefix: string) => { fixture.config.find(source => source.accountId === credential.id)!.prefix = prefix } }))
vi.mock('../server/lib/groups', () => ({ ensureAccountGroups: async (_sql: unknown, _moduleId: string, id: string) => {
  if (!fixture.bindings.has(id)) fixture.bindings.set(id, { groupIds: ['default'], groupNames: ['默认'] })
}, accountGroupBindings: async () => fixture.bindings }))
vi.mock('../server/lib/db', () => ({ getDb: () => {
  const sql: any = async () => []; sql.begin = async (callback: any) => callback(sql); return sql
} }))
import { listCpaGroupModels, listCpaGroupSources, prepareCpaGroupSource, resetCpaGroupRouting, resolveCpaGroupModel } from '../server/lib/cpa/group-routing'
const response = (body: unknown, status = 200) => ({ status, body: Buffer.from(JSON.stringify(body)) })
function file(name: string, group: string, prefix = '', runtimeIds = [name]) {
  fixture.documents.set(name, { type: 'codex', prefix, access_token: 'local-synthetic-only', refresh_token: 'local-refresh', unknown: { preserved: true } })
  fixture.bindings.set(name, { groupIds: [group], groupNames: [group] })
  for (const id of runtimeIds) fixture.credentials.push({ id, name: id, source: 'file', path: '/isolated/auth/' + name, provider: 'codex', runtime_only: runtimeIds.length > 1 })
}
beforeEach(() => {
  fixture.credentials = []; fixture.documents.clear(); fixture.bindings.clear(); fixture.models.clear(); fixture.patches = []; fixture.config = []; fixture.plugins = []; fixture.persistent = true
  resetCpaGroupRouting()
  fixture.request.mockImplementation(async (input: any) => {
    if (input.path === 'credentials' && !input.method) return response({ files: fixture.credentials })
    if (input.path === 'plugins') return response({ plugins: fixture.plugins })
    if (input.path === 'credentials/download') return response(fixture.documents.get(input.query.name), fixture.documents.has(input.query.name) ? 200 : 404)
    if (input.path === 'credentials/fields' || (input.path === 'credentials' && input.method === 'POST')) {
      const body = JSON.parse(input.body), name = input.query?.name || body.name; fixture.patches.push({ path: input.path, name, body })
      if (fixture.persistent) {
        if (input.path === 'credentials/fields') fixture.documents.get(name)!.prefix = body.prefix
        else fixture.documents.set(name, body)
      }
      return response({ status: 'ok' })
    }
    if (input.path === 'credentials/models') {
      const credential = fixture.credentials.find(item => item.id === input.query.name)
      const fileName = String(credential?.path || '').split('/').pop() || input.query.name
      const source = fixture.config.find(item => item.authIds.includes(input.query.name))
      const prefix = String(fixture.documents.get(fileName)?.prefix || source?.prefix || '')
      const modelIds = fixture.models.get(input.query.name) || ['same-model']
      return response({ models: modelIds.flatMap(id => [{ id }, ...(prefix ? [{ id: prefix + '/' + id }] : [])]) })
    }
    throw Error('Unexpected test path: ' + input.path)
  })
})
describe('CPA source-backed group isolation', () => {
  it('reads names and source identities without changing native routing or exposing tokens', async () => {
    file('a.json', 'A', 'existing')
    const sources = await listCpaGroupSources()
    expect(sources[0]).toMatchObject({ id: 'a.json', sourceType: 'cpa', sourceId: 'a.json', groupIds: ['A'], routingPrefix: 'existing', routingSupported: true })
    expect(JSON.stringify(sources)).not.toContain('synthetic')
    expect(fixture.patches).toEqual([])
  })
  it('separates identical models by source, handles group unions and preserves thinking suffixes', async () => {
    file('a.json', 'A'); file('b.json', 'B')
    expect((await listCpaGroupModels(['A'])).map(model => model.id)).toEqual(['same-model'])
    expect(fixture.patches).toEqual([])
    const a = await resolveCpaGroupModel('same-model(high)', ['A'], 'key-a')
    const b = await resolveCpaGroupModel('same-model', ['B'], 'key-b')
    expect(a?.accountId).toBe('a.json'); expect(b?.accountId).toBe('b.json')
    expect(a?.model).toMatch(/^nexus-[a-f0-9]{20}\/same-model\(high\)$/)
    expect(a?.model.split('/')[0]).not.toBe(b?.model.split('/')[0])
    expect(await resolveCpaGroupModel(b!.model, ['A'], 'key-a')).toBeNull()
    expect((await listCpaGroupModels(['A', 'B'])).map(model => model.id)).toEqual(['same-model'])
    const first = await resolveCpaGroupModel('same-model', ['A', 'B'], 'union')
    const second = await resolveCpaGroupModel('same-model', ['A', 'B'], 'union')
    expect(new Set([first?.accountId, second?.accountId])).toEqual(new Set(['a.json', 'b.json']))
  })
  it('refreshes source membership on each request rather than caching revoked group access', async () => {
    file('a.json', 'A', 'private-a')
    expect(await resolveCpaGroupModel('same-model', ['A'], 'key')).toEqual({ accountId: 'a.json', model: 'private-a/same-model' })
    fixture.bindings.set('a.json', { groupIds: ['B'], groupNames: ['B'] })
    expect(await resolveCpaGroupModel('same-model', ['A'], 'key')).toBeNull()
    expect(await listCpaGroupModels([])).toEqual([])
  })
  it('groups all virtual accounts from one file and preserves source JSON on durable re-synthesis', async () => {
    file('projects.json', 'A', '', ['project-1', 'project-2'])
    fixture.models.set('project-1', ['first']); fixture.models.set('project-2', ['second'])
    expect(await listCpaGroupSources()).toHaveLength(1)
    expect((await listCpaGroupModels(['A'])).map(model => model.id)).toEqual(['first', 'second'])
    const selected = await resolveCpaGroupModel('second', ['A'], 'key')
    expect(selected?.accountId).toBe('projects.json')
    expect(fixture.patches[0]).toMatchObject({ path: 'credentials', name: 'projects.json', body: {
      access_token: 'local-synthetic-only', refresh_token: 'local-refresh', unknown: { preserved: true },
    } })
  })
  it('rejects unpersisted writes and sources without an independently verifiable native route', async () => {
    file('a.json', 'A'); fixture.persistent = false
    await expect(prepareCpaGroupSource('a.json')).rejects.toMatchObject({ statusCode: 502 })
    fixture.credentials.push({ id: 'plugin-runtime', name: 'temporary', auth_index: 'runtime-index', source: 'memory', runtime_only: true })
    resetCpaGroupRouting()
    const runtime = (await listCpaGroupSources()).find(source => source.id.startsWith('runtime:'))!
    expect(runtime).toMatchObject({ routingSupported: false })
    await expect(prepareCpaGroupSource(runtime.id)).rejects.toMatchObject({ statusCode: 409 })
  })
  it('blocks another source impersonating the exact account model alias', async () => {
    file('a.json', 'A', 'private-a'); file('b.json', 'B', 'private-b')
    fixture.models.set('b.json', ['private-a/same-model'])
    await expect(resolveCpaGroupModel('same-model', ['A'], 'key')).rejects.toMatchObject({ statusCode: 409 })
  })
  it('fails closed for unverified active router plugins and accepts the pinned official Google provider', async () => {
    file('a.json', 'A', 'private-a')
    fixture.plugins = [{ id: 'custom-router', effective_enabled: true, metadata: { version: '1.0.0' } }]
    await expect(resolveCpaGroupModel('same-model', ['A'], 'key')).rejects.toMatchObject({ statusCode: 409 })
    fixture.plugins = [{ id: 'gemini-cli', effective_enabled: true, metadata: { version: '1.0.5' } }]
    expect(await resolveCpaGroupModel('same-model', ['A'], 'key')).toEqual({ accountId: 'a.json', model: 'private-a/same-model' })
  })
})
