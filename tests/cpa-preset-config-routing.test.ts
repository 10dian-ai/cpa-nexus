import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ensureCpaConfigAccountRoute, readCpaConfigAccountRoutes, type CpaConfigRoutingClient } from '../server/lib/cpa/preset-config-routing'
import type { CpaRequest } from '../server/lib/cpa/client'

const index = (family: string, key: string, base = 'https://provider.example/v1') => createHash('sha256')
  .update((family === 'openai-compatibility' ? family : family + '-api-key') + ':' + base + '+' + key).digest('hex').slice(0, 16)
function fixture(config: Record<string, unknown>) {
  let persisted = structuredClone(config)
  const request = vi.fn(async (input: CpaRequest) => {
    expect(input.path).toBe('config/api-keys')
    if (input.method === 'PATCH') persisted = { ...persisted, ...JSON.parse(String(input.body)) }
    return { status: 200, statusText: 'OK', headers: new Headers(), body: Buffer.from(JSON.stringify(persisted)) }
  })
  return { client: { request } satisfies CpaConfigRoutingClient, request, config: () => persisted }
}
const credential = (family: string, key: string) => ({ id: 'old-runtime-id', name: 'old-runtime-id', auth_index: index(family, key), runtime_only: true, source: 'memory' })

describe('CPA fixed-version configuration account routes', () => {
  it('exposes stable non-secret identities and inherited prefixes without reading client keys', async () => {
    const { client } = fixture({ codex: [{ name: 'shared', 'base-url': 'https://provider.example/v1', prefix: 'shared', keys: [{ 'api-key': 'key-a' }, { 'api-key': 'key-b', prefix: 'personal' }] }] })
    const routes = await readCpaConfigAccountRoutes(client, [credential('codex', 'key-a'), credential('codex', 'key-b'), { name: 'oauth.json', source: 'file' }])
    expect(routes.map(({ name: _name, provider: _provider, ...route }) => route)).toEqual([
      { accountId: 'config:' + index('codex', 'key-a'), prefix: 'shared', supported: true },
      { accountId: 'config:' + index('codex', 'key-b'), prefix: 'personal', supported: true },
    ])
    expect(JSON.stringify(routes)).not.toContain('key-a')
    expect(JSON.stringify(routes)).not.toContain('key-b')
  })

  it('changes only a selected native key override and preserves all shared fields, siblings and families', async () => {
    const shared = { name: 'custom', 'base-url': 'https://provider.example/v1', prefix: 'old', priority: 7,
      headers: { 'X-Custom': 'value' }, models: [{ name: 'actual', alias: 'alias', 'is-compat': true }],
      'request-retry': 4, 'excluded-models': ['blocked'], keys: [{ 'api-key': 'key-a', weight: 9 }, { 'api-key': 'key-b', 'proxy-url': 'direct' }] }
    const other = [{ name: 'other', keys: [{ 'api-key': 'unrelated' }] }]
    const { client, request, config } = fixture({ codex: [shared], gemini: other })
    await ensureCpaConfigAccountRoute(client, credential('codex', 'key-b'), 'nexus-personal')
    expect(config()).toEqual({ codex: [{ ...shared, keys: [shared.keys[0], { ...shared.keys[1], prefix: 'nexus-personal' }] }], gemini: other })
    expect(JSON.parse(String(request.mock.calls.find(([request]) => request.method === 'PATCH')![0].body))).toEqual({ codex: config().codex })
    const routes = await readCpaConfigAccountRoutes(client, [credential('codex', 'key-b')])
    expect(routes.find(route => route.accountId === 'config:' + index('codex', 'key-b'))).toMatchObject({ accountId: 'config:' + index('codex', 'key-b'), prefix: 'nexus-personal', supported: true })
  })

  it('splits a compatibility provider only for the selected key while retaining model aliases and provider options', async () => {
    const shared = { name: 'custom', 'base-url': 'https://provider.example/v1', prefix: 'shared', priority: 3,
      headers: { 'X-Custom': 'value' }, models: [{ name: 'actual', alias: 'alias' }], 'request-retry': 2,
      keys: [{ 'api-key': 'key-a', weight: 2 }, { 'api-key': 'key-b', 'proxy-url': 'direct' }] }
    const { client, config } = fixture({ 'openai-compatibility': [shared] })
    await ensureCpaConfigAccountRoute(client, credential('openai-compatibility', 'key-b'), 'nexus-personal')
    expect(config()['openai-compatibility']).toEqual([
      { ...shared, keys: [shared.keys[0]] },
      { ...shared, name: 'custom-nexus-' + index('openai-compatibility', 'key-b'), prefix: 'nexus-personal', keys: [shared.keys[1]] },
    ])
    const routes = await readCpaConfigAccountRoutes(client, [credential('openai-compatibility', 'key-b')])
    expect(routes.find(route => route.accountId === 'config:' + index('openai-compatibility', 'key-b'))!.prefix).toBe('nexus-personal')
  })

  it('rejects ambiguous repeated credentials, collisions and the managed CommandCode bridges without writing', async () => {
    for (const [groups, account, prefix] of [
      [[{ name: 'a', 'base-url': 'https://provider.example/v1', keys: [{ 'api-key': 'key-a' }, { 'api-key': 'key-a' }] }], credential('codex', 'key-a'), 'personal'],
      [[{ name: 'a', 'base-url': 'https://provider.example/v1', keys: [{ 'api-key': 'key-a' }, { 'api-key': 'key-b', prefix: 'taken' }] }], credential('codex', 'key-a'), 'taken'],
      [[{ name: 'nexus-commandcode-messages', 'base-url': 'https://provider.example/v1', keys: [{ 'api-key': 'key-a' }] }], credential('codex', 'key-a'), 'personal'],
    ] as const) {
      const { client, request } = fixture({ codex: groups })
      await expect(ensureCpaConfigAccountRoute(client, account, prefix)).rejects.toMatchObject({ statusCode: 409 })
      expect(request.mock.calls.some(([input]) => input.method === 'PATCH')).toBe(false)
    }
  })

  it('treats a repeated stable identity as unsupported and does not expose configuration', async () => {
    const { client } = fixture({ codex: [{ name: 'a', 'base-url': 'https://provider.example/v1', keys: [{ 'api-key': 'key-a' }, { 'api-key': 'key-a', prefix: 'duplicate' }] }] })
    const routes = await readCpaConfigAccountRoutes(client, [credential('codex', 'key-a')])
    expect(routes[0]).toMatchObject({ supported: false, prefix: '' })
    expect(JSON.stringify(routes)).not.toContain('key-a')
  })

  it('reports failed persistence instead of treating an accepted write as durable', async () => {
    const { client, request } = fixture({ codex: [{ name: 'a', 'base-url': 'https://provider.example/v1', keys: [{ 'api-key': 'key-a' }] }] })
    request.mockImplementationOnce(client.request.getMockImplementation()!)
    request.mockImplementationOnce(async () => ({ status: 200, statusText: 'OK', headers: new Headers(), body: Buffer.from('{}') }))
    await expect(ensureCpaConfigAccountRoute(client, credential('codex', 'key-a'), 'personal')).rejects.toMatchObject({ statusCode: 502 })
  })
})
