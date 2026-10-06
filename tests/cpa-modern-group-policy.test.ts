import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ credentials: [] as any[], config: {} as Record<string, unknown>, capabilities: {} as any,
  bindings: new Map<string, { groupIds: string[]; groupNames: string[] }>(), request: vi.fn() }))
vi.mock('../server/lib/cpa/client', () => ({ createCpaClient: () => ({ request: fixture.request }), CpaClientError: class extends Error { constructor(public code: string, message: string, public statusCode: number) { super(message) } } }))
vi.mock('../server/lib/cpa/privacy', () => ({ ensureNativeCpaPrivacy: async () => ({ changed: false, updatedFiles: 0 }) }))
vi.mock('../server/lib/cpa/preset-routing', () => ({ resetCpaPresetAccountRoutes: () => {} }))
vi.mock('../server/lib/cpa/nexus-capabilities', () => ({ getNexusCpaCapabilities: async () => fixture.capabilities, resetNexusCpaCapabilities: () => {} }))
vi.mock('../server/lib/db', () => ({ getDb: () => { const sql: any = async () => []; sql.begin = async (cb: any) => cb(sql); return sql } }))
vi.mock('../server/lib/groups', () => ({ ensureAccountGroups: async (_sql: unknown, _module: unknown, id: string) => { if (!fixture.bindings.has(id)) fixture.bindings.set(id, { groupIds: ['default'], groupNames: ['default'] }) }, accountGroupBindings: async () => fixture.bindings }))
import { listCpaGroupModels, listCpaGroupSources, resetCpaGroupRouting, resolveCpaGroupPolicy, resolveCommandcodeBridgePolicy } from '../server/lib/cpa/group-routing'
const index = (family: string, base: string, key: string) => createHash('sha256').update((family === 'openai-compatibility' ? family : family + '-api-key') + ':' + base + '+' + key).digest('hex').slice(0, 16)
const response = (value: unknown) => ({ status: 200, body: Buffer.from(JSON.stringify(value)) })
beforeEach(() => {
  fixture.bindings.clear(); fixture.credentials = []
  fixture.config = { codex: [{ name: 'private', 'base-url': 'http://local-private', keys: [{ 'api-key': 'synthetic-private-key' }, { 'api-key': 'synthetic-private-key' }] }],
    'openai-compatibility': [{ name: 'nexus-commandcode', 'base-url': 'http://local-bridge/v1', keys: [{ 'api-key': 'synthetic-bridge-key' }] }],
    claude: [{ name: 'nexus-commandcode-messages', 'base-url': 'http://local-bridge', keys: [{ 'api-key': 'synthetic-bridge-key' }] }] }
  const privateIndex = index('codex', 'http://local-private', 'synthetic-private-key')
  fixture.bindings.set('config:' + privateIndex, { groupIds: ['private'], groupNames: ['private'] })
  fixture.capabilities = { schemaVersion: 1, groupPolicy: { enabled: true, protocol: 'opaque-hmac-sha256-v1' }, plugins: [], runtimeAccounts: [
    { id: 'actual-private-a', authIndex: privateIndex, fileName: '', provider: 'codex', source: 'config', sourcePath: '', disabled: false },
    { id: 'actual-private-b', authIndex: privateIndex, fileName: '', provider: 'codex', source: 'config', sourcePath: '', disabled: false },
    { id: 'actual-managed-chat', authIndex: index('openai-compatibility', 'http://local-bridge/v1', 'synthetic-bridge-key'), fileName: '', provider: 'nexus-commandcode', source: 'config', sourcePath: '', disabled: false },
    { id: 'actual-managed-messages', authIndex: index('claude', 'http://local-bridge', 'synthetic-bridge-key'), fileName: '', provider: 'claude', source: 'config', sourcePath: '', disabled: false },
  ] }
  fixture.request.mockImplementation(async (input: any) => {
    if (input.path === 'credentials') return response({ files: fixture.credentials })
    if (input.path === 'config/api-keys') return response(fixture.config)
    if (input.path === 'credentials/models') return response({ models: [{ id: 'local-model' }] })
    throw Error('Modern inventory must not download credentials: ' + input.path)
  })
  resetCpaGroupRouting()
})
describe('modern CPA runtime source policy inventory', () => {
  it('publishes exact native IDs when the original configuration forces a source prefix', async () => {
    fixture.capabilities.runtimeAccounts[0].prefix = 'private-prefix'
    fixture.capabilities.runtimeAccounts[1].prefix = 'private-prefix'
    fixture.request.mockImplementation(async (input: any) => {
      if (input.path === 'credentials') return response({ files: fixture.credentials })
      if (input.path === 'config/api-keys') return response(fixture.config)
      if (input.path === 'credentials/models') return response({ models: [{ id: 'private-prefix/local-model' }] })
      throw Error('Modern inventory must not download credentials: ' + input.path)
    })
    expect(await listCpaGroupModels(['private'])).toEqual([{ id: 'private-prefix/local-model', object: 'model' }])
    expect((await resolveCpaGroupPolicy('private-prefix/local-model', ['private'], 'private-key'))?.model).toBe('private-prefix/local-model')
  })

  it('binds repeated config credentials to one private source and grants no default runtime alias', async () => {
    const sources = await listCpaGroupSources()
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({ routingSupported: true, groupIds: ['private'] })
    expect(await resolveCpaGroupPolicy('router-any-alias', ['default'], 'default-key')).toBeNull()
    expect(await resolveCpaGroupPolicy('router-any-alias', ['private'], 'private-key')).toEqual({ model: 'router-any-alias', selectedGroupId: 'private', allowedAuthIDs: ['actual-private-a', 'actual-private-b'], allowedPluginIDs: [] })
    expect([...fixture.bindings.keys()].some(id => id.startsWith('runtime:'))).toBe(false)
  })
  it('never exposes managed bridge credentials as another default CPA source', async () => {
    fixture.credentials = [{ id: 'actual-managed-chat', auth_index: index('openai-compatibility', 'http://local-bridge/v1', 'synthetic-bridge-key'), source: 'memory', runtime_only: true }]
    expect((await listCpaGroupSources()).some(source => source.sourceId.includes('managed') || source.sourceId.startsWith('runtime:'))).toBe(false)
    expect(await resolveCommandcodeBridgePolicy('model-key')).toEqual({ allowedAuthIDs: ['actual-managed-chat', 'actual-managed-messages'], allowedPluginIDs: [] })
  })
  it('keeps memory-reported credentials and virtual children in their physical file group', async () => {
    fixture.credentials = [{ id: 'file-runtime', auth_index: 'file-index', name: 'project-child', source: 'memory', path: '/isolated/private-file.json', provider: 'codex' }]
    fixture.capabilities.runtimeAccounts.push({ id: 'file-runtime', authIndex: 'file-index', fileName: 'project-child', provider: 'codex', source: 'memory', sourcePath: '/isolated/private-file.json', disabled: false })
    fixture.bindings.set('private-file.json', { groupIds: ['private'], groupNames: ['private'] })
    const sources = await listCpaGroupSources()
    expect(sources.filter(source => source.sourceId === 'private-file.json')).toHaveLength(1)
    expect(sources.some(source => source.sourceId === 'runtime:file-index')).toBe(false)
    expect(await resolveCpaGroupPolicy('local-model', ['default'], 'default-key')).toBeNull()
    expect((await resolveCpaGroupPolicy('local-model', ['private'], 'private-key'))?.allowedAuthIDs).toContain('file-runtime')
    expect(fixture.request.mock.calls.some(([input]) => input.path === 'credentials/download')).toBe(false)
  })
  it('uses actual SDK roles for every provider/router/scheduler rather than a version whitelist', async () => {
    fixture.capabilities.plugins = [{ id: 'any-market-router', provider: 'local-plugin', executorModelScope: 'static', capabilities: { modelRouter: true, executor: true, scheduler: true }, modelClientIDs: ['plugin:any-market-router:local-plugin:executor'] }]
    fixture.bindings.set('plugin:any-market-router', { groupIds: ['private'], groupNames: ['private'] })
    expect((await listCpaGroupSources()).find(source => source.sourceId === 'plugin:any-market-router')).toMatchObject({ routingSupported: true })
    expect((await resolveCpaGroupPolicy('private-router-alias', ['private'], 'private-key'))?.allowedPluginIDs).toEqual(['any-market-router'])
    fixture.bindings.set('plugin:any-market-router', { groupIds: ['other'], groupNames: ['other'] })
    expect((await resolveCpaGroupPolicy('private-router-alias', ['private'], 'private-key'))?.allowedPluginIDs).toEqual([])
  })
})
