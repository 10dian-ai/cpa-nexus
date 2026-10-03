import { beforeEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ credentials: [] as Record<string, unknown>[], documents: new Map<string, Record<string, unknown>>(), patches: [] as any[], persistent: true, bindings: [] as string[], config: [] as any[], request: vi.fn() }))
vi.mock('../server/lib/cpa/client', () => ({ createCpaClient: () => ({ request: fixture.request }) }))
vi.mock('../server/lib/cpa/preset-config-routing', () => ({ readCpaConfigAccountRoutes: async () => fixture.config, ensureCpaConfigAccountRoute: async () => {} }))
vi.mock('../server/lib/db', () => ({ getDb: () => {
  const sql: any = async (strings: TemplateStringsArray) => strings.join('').includes('SELECT account_id') ? fixture.bindings.map(account_id => ({ account_id })) : []
  sql.begin = async (fn: any) => fn(sql)
  return sql
} }))
import { ensureCpaPresetAccountRoute, findCpaPresetAccountForModel, listCpaPresetAccountRoutes, resetCpaPresetAccountRoutes } from '../server/lib/cpa/preset-routing'
const response = (data: unknown, status = 200) => ({ status, body: new TextEncoder().encode(JSON.stringify(data)) })
const file = (name: string, prefix = '') => {
  fixture.credentials.push({ name, id: name, source: 'file', runtime_only: false })
  fixture.documents.set(name, { prefix, access_token: 'never-return-this-token', refresh_token: 'never-return-this-refresh-token' })
}
beforeEach(() => {
  fixture.credentials = []; fixture.documents.clear(); fixture.patches = []; fixture.persistent = true; fixture.bindings = []; fixture.config = []
  resetCpaPresetAccountRoutes()
  fixture.request.mockImplementation(async (input: any) => {
    if (input.path === 'credentials') return response({ files: fixture.credentials })
    if (input.path === 'credentials/download') return response(fixture.documents.get(input.query.name) || {}, fixture.documents.has(input.query.name) ? 200 : 404)
    if (input.path === 'credentials/fields') {
      const body = JSON.parse(input.body); fixture.patches.push(body)
      if (fixture.persistent) fixture.documents.get(body.name)!.prefix = body.prefix
      return response({ status: 'ok' })
    }
    if (input.path === 'credentials/models') return response({ models: [{ id: fixture.documents.get(input.query.name)!.prefix + '/fixture' }] })
    throw Error('Unexpected fixture path: ' + input.path)
  })
})
describe('persisted native CPA account preset prefixes', () => {
  it('returns only route capabilities while retaining all account tokens on the server', async () => {
    file('oauth.json', 'my-account')
    const accounts = await listCpaPresetAccountRoutes()
    expect(accounts).toEqual([{ accountId: 'oauth.json', credentialName: 'oauth.json', prefix: 'my-account', supported: true }])
    expect(JSON.stringify(accounts)).not.toContain('token')
  })
  it('reuses an existing unique prefix and verifies its real model alias', async () => {
    file('oauth.json', 'original')
    expect(await ensureCpaPresetAccountRoute('oauth.json')).toMatchObject({ prefix: 'original', supported: true })
    expect(fixture.patches).toEqual([])
    expect(fixture.request).toHaveBeenCalledWith(expect.objectContaining({ path: 'credentials/models', query: { name: 'oauth.json' } }))
  })
  it('assigns and reads back a persistent independent prefix without changing identity or tokens', async () => {
    file('oauth.json')
    const route = await ensureCpaPresetAccountRoute('oauth.json')
    expect(route.accountId).toBe('oauth.json'); expect(route.prefix).toMatch(/^nexus-[a-f0-9]{20}$/)
    expect(fixture.patches).toEqual([{ name: 'oauth.json', prefix: route.prefix }])
    expect(fixture.documents.get('oauth.json')!.access_token).toBe('never-return-this-token')
  })
  it('does not accept a successful PATCH if the account document was not persisted', async () => {
    file('oauth.json'); fixture.persistent = false
    await expect(ensureCpaPresetAccountRoute('oauth.json')).rejects.toMatchObject({ statusCode: 502 })
  })
  it('splits shared prefixes before account selection and rejects collisions introduced later', async () => {
    file('one.json', 'shared'); file('two.json', 'shared')
    const selected = await ensureCpaPresetAccountRoute('one.json')
    expect(selected.prefix).not.toBe('shared'); expect(fixture.documents.get('two.json')!.prefix).toBe('shared')
    fixture.bindings = ['one.json']
    expect(await findCpaPresetAccountForModel(selected.prefix + '/fixture')).toBe('one.json')
    fixture.documents.get('two.json')!.prefix = selected.prefix; resetCpaPresetAccountRoutes()
    await expect(findCpaPresetAccountForModel(selected.prefix + '/fixture')).rejects.toMatchObject({ statusCode: 409 })
  })
  it('does not treat websocket or other non-persistent runtime credentials as file accounts', async () => {
    fixture.credentials = [{ name: 'websocket', auth_index: 'runtime-id', source: 'memory', runtime_only: true }]
    const route = (await listCpaPresetAccountRoutes())[0]!
    expect(route.supported).toBe(false)
    await expect(ensureCpaPresetAccountRoute(route.accountId)).rejects.toMatchObject({ statusCode: 409 })
    expect(fixture.patches).toHaveLength(0)
  })
})
