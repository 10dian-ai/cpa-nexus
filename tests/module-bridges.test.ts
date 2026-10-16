import { describe, expect, it, vi, beforeEach } from 'vitest'

const fixture = vi.hoisted(() => ({
  channels: [] as Record<string, unknown>[],
  claude: [] as Record<string, unknown>[],
  writes: [] as unknown[],
  secret: null as string | null,
  rejectWrite: false,
}))
const response = (status: number, value?: unknown) => ({ status, statusText: '', headers: new Headers(), body: new TextEncoder().encode(value === undefined ? '' : JSON.stringify(value)) })
vi.mock('../server/lib/cpa/client', () => ({ createCpaClient: () => ({ request: async (input: { path: string; method?: string; body?: string }) => {
  if (input.path === 'config/api-keys/openai-compatibility' && !input.method) return response(200, fixture.channels)
  if (input.path === 'config/api-keys' && !input.method) return response(200, { 'openai-compatibility': fixture.channels, claude: fixture.claude })
  if (input.path === 'config/api-keys' && input.method === 'PATCH') {
    if (fixture.rejectWrite) return response(500)
    const value = JSON.parse(input.body!)
    fixture.writes.push(value)
    if (value['openai-compatibility']) fixture.channels = value['openai-compatibility']
    if (value.claude) fixture.claude = value.claude
    return response(200, {})
  }
  throw new Error('Unexpected CPA call ' + input.path)
} }) }))
vi.mock('../server/lib/cpa/config-lock', () => ({ withKernelConfigLock: (callback: (tx: unknown) => unknown) => callback(fakeSql) }))
vi.mock('../server/lib/config', () => ({ getConfig: () => ({ bridgeBaseUrl: 'http://app:3000', encryptionKey: Buffer.alloc(32, 3).toString('base64') }) }))
const fakeSql: any = Object.assign(async (strings: TemplateStringsArray) => {
  const text = strings.join('?')
  if (text.includes('SELECT secret_ciphertext')) return fixture.secret ? [{ secret_ciphertext: fixture.secret }] : []
  if (text.includes('INSERT INTO nexus_module_bridges')) return []
  return []
}, { begin: async (callback: (tx: unknown) => unknown) => callback(fakeSql) })
vi.mock('../server/lib/db', () => ({ getDb: () => fakeSql }))
vi.mock('../server/lib/crypto', () => ({ encryptSecret: (value: string) => { fixture.secret = 'enc:' + value; return fixture.secret }, decryptSecret: (value: string) => value.slice(4), hashGatewayKey: (value: string) => 'h:' + value }))
import { reconcileBridge, removeBridge, moduleForAlias, pruneStaleBridges } from '../server/lib/cpa/module-bridges'
import { routeHeaders, verifyRouteHeaders } from '../server/lib/bridge/identity'

const userChannels = () => [
  { name: 'my-relay', 'base-url': 'https://relay.example/v1', keys: [{ 'api-key': 'user-secret' }] },
  { name: 'nexus-other-module', 'base-url': 'http://app:3000/x', keys: [] },
]

describe('kernel-owned module bridge channels', () => {
  beforeEach(() => { fixture.channels = userChannels(); fixture.writes = []; fixture.secret = null; fixture.rejectWrite = false })

  it('adds only the module\'s own channel and leaves every other channel byte-for-byte unchanged', async () => {
    const state = await reconcileBridge({ moduleId: 'logicc', routePath: '/api/modules/logicc/bridge/v1', models: ['claude-x', 'gpt-y', 'claude-x'] })
    expect(state).toMatchObject({ connected: true, channel: 'nexus-logicc', modelCount: 3 })
    const written = fixture.writes[0] as Record<string, Record<string, unknown>[]>
    expect(Object.keys(written)).toEqual(['openai-compatibility'])
    expect(written['openai-compatibility']!.slice(0, 2)).toEqual(userChannels())
    const channel = written['openai-compatibility']![2]!
    expect(channel).toMatchObject({ name: 'nexus-logicc', 'base-url': 'http://app:3000/api/modules/logicc/bridge/v1', 'request-retry': 0, 'disable-cooling': true })
    expect(channel.models).toEqual([{ name: 'claude-x', alias: 'logicc/claude-x' }, { name: 'gpt-y', alias: 'logicc/gpt-y' }])
    expect(String((channel.keys as { 'api-key': string }[])[0]!['api-key'])).toMatch(/^ccm_nexus_logicc_/)
    expect(Object.keys(channel.headers as object)).toEqual(['X-Nexus-Original-Key-ID', 'X-Nexus-Route-Group', 'X-Nexus-Request-ID', 'X-Nexus-Route-Expires', 'X-Nexus-Route-Signature'])
  })

  it('does not write when nothing changed and removes only its own channel', async () => {
    await reconcileBridge({ moduleId: 'logicc', routePath: '/api/modules/logicc/bridge/v1', models: ['claude-x'] })
    await reconcileBridge({ moduleId: 'logicc', routePath: '/api/modules/logicc/bridge/v1', models: ['claude-x'] })
    expect(fixture.writes).toHaveLength(1)
    await removeBridge('logicc')
    expect(fixture.channels).toEqual(userChannels())
    // No models: nothing is advertised.
    await reconcileBridge({ moduleId: 'logicc', routePath: '/api/modules/logicc/bridge/v1', models: [] })
    expect(fixture.channels).toEqual(userChannels())
  })

  it('reports a rejected write without claiming success', async () => {
    fixture.rejectWrite = true
    await expect(reconcileBridge({ moduleId: 'logicc', routePath: '/api/modules/logicc/bridge/v1', models: ['m'] })).rejects.toMatchObject({ statusCode: 502 })
  })

  it('prunes channels of removed modules but keeps current bridges and user channels', async () => {
    fixture.channels = [...userChannels(), { name: 'nexus-commandcode', keys: [] }, { name: 'nexus-logicc', keys: [] }]
    fixture.claude = [{ name: 'my-claude', keys: [] }, { name: 'nexus-commandcode-messages', keys: [] }]
    expect((await pruneStaleBridges()).sort()).toEqual(['nexus-commandcode', 'nexus-commandcode-messages', 'nexus-other-module'])
    expect(fixture.channels.map(group => group.name)).toEqual(['my-relay', 'nexus-logicc'])
    expect(fixture.claude.map(group => group.name)).toEqual(['my-claude'])
    expect(await pruneStaleBridges()).toEqual([])
  })

  it('maps bridge aliases back to their module', () => {
    expect(moduleForAlias('logicc/claude-x')).toEqual({ moduleId: 'logicc', nativeModel: 'claude-x' })
    expect(moduleForAlias('devin/claude')).toBeNull()
  })
})

describe('signed bridge route headers', () => {
  const context = { moduleId: 'logicc', keyId: '00000000-0000-4000-8000-000000000001', groupId: '00000000-0000-4000-8000-000000000002', requestId: '00000000-0000-4000-8000-000000000003' }
  it('verifies the router\'s own headers and rejects tampering, other modules and expiry', () => {
    const now = Date.now()
    const headers = routeHeaders(context, now)
    expect(verifyRouteHeaders('logicc', headers, now)).toEqual(context)
    expect(verifyRouteHeaders('other', headers, now)).toBeNull()
    expect(verifyRouteHeaders('logicc', { ...headers, 'x-nexus-route-group': '00000000-0000-4000-8000-0000000000ff' }, now)).toBeNull()
    expect(verifyRouteHeaders('logicc', { ...headers, 'x-nexus-route-signature': 'A'.repeat(43) }, now)).toBeNull()
    expect(verifyRouteHeaders('logicc', headers, now + 11 * 60_000)).toBeNull()
    expect(() => routeHeaders({ ...context, keyId: 'not-a-uuid' })).toThrow()
  })
})
