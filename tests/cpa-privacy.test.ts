import { describe, expect, it, vi } from 'vitest'
import { applyCpaPrivacyPolicy, cpaPrivacyApiKeysPatch, cpaPrivacyCredentialPatch, cpaPrivacyDefaultsPatch, cpaPrivacyHeaders } from '../scripts/cpa-privacy-policy.mjs'
import { prepareNativePrivacy } from '../scripts/setup-native-cpa.mjs'

const response = (body: unknown, status = 200) => ({ status, body: Buffer.from(JSON.stringify(body)) })
const merge = (target: any, update: any) => {
  for (const [key, value] of Object.entries(update)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) { target[key] ||= {}; merge(target[key], value) }
    else target[key] = structuredClone(value)
  }
}
function fixture() {
  const config: any = { upstream: { claude: { 'header-defaults': { timeout: '600', timezone: 'Asia/Shanghai' } }, codex: { 'response-steering': true } },
    oauth: { 'auth-dir': '/isolated-auth', providers: { codex: { 'header-defaults': { 'beta-features': 'preserved-protocol-beta' } } } },
    'api-keys': { codex: [{ name: 'server-source', 'base-url': 'http://isolated.example', 'request-retry': 2, models: [{ name: 'actual', alias: 'public' }],
      headers: { 'X-Preserved': 'group' }, keys: [{ 'api-key': 'synthetic-upstream-key', 'disable-codex-cloaking': false, headers: { 'X-Preserved': 'key', 'User-Agent': 'old-client' } }] }] } }
  const documents = new Map<string, any>([
    ['oauth.json', { type: 'claude', access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', custom: { preserved: true }, headers: { 'X-Custom': 'keep', 'User-Agent': 'private-client', 'X-Stainless-Os': 'private-os', 'X-App': 'old-client-app' } }],
    ['projects.json', { type: 'gemini-cli', project_ids: ['one', 'two'], access_token: 'synthetic-project-access', headers: { 'X-Custom': 'keep' } }],
  ])
  const request = vi.fn(async (input: any) => {
    if (input.path === 'config') {
      if (input.method === 'PATCH') merge(config, JSON.parse(input.body))
      return response(input.method ? { status: 'ok' } : config)
    }
    if (input.path === 'config/api-keys' && input.method === 'PATCH') { merge(config['api-keys'], JSON.parse(input.body)); return response({ status: 'ok' }) }
    if (input.path === 'credentials' && !input.method) return response({ files: [...documents.keys()].map(name => ({ source: 'file', name, path: '/isolated/' + name })) })
    if (input.path === 'credentials/download') return response(documents.get(input.query.name))
    if (input.path === 'credentials/fields') {
      const { name, ...update } = JSON.parse(input.body)
      if (name === 'projects.json') return response({ error: 'plugin virtual source' }, 409)
      if (update.headers) {
        const next = { ...(documents.get(name).headers || {}) }
        for (const [key, value] of Object.entries(update.headers)) { if (value === '') delete next[key]; else next[key] = value }
        update.headers = next
      }
      Object.assign(documents.get(name), update); return response({ status: 'ok' })
    }
    if (input.path === 'credentials' && input.method === 'POST') { documents.set(input.query.name, JSON.parse(input.body)); return response({ status: 'ok' }) }
    throw Error('Unexpected test path')
  })
  return { config, documents, request, client: { request } }
}
describe('native CPA outgoing software identity policy', () => {
  it('normalizes software labels while preserving authorization and protocol header configuration', () => {
    expect(cpaPrivacyHeaders({ 'user-agent': 'Claude-Code/fixture', Authorization: 'server-owned-auth', 'Anthropic-Beta': 'tools-2026',
      'X-Stainless-Os': 'private-device', 'X-Device-Id': 'private-device-id', 'X-Custom': '$Server-Header' }, 'claude')).toEqual({
      Authorization: 'server-owned-auth', 'Anthropic-Beta': 'tools-2026', 'X-Custom': '$Server-Header',
      'User-Agent': 'opencode', 'X-Client-App': 'opencode',
    })
    expect(cpaPrivacyHeaders({}, 'codex')).toMatchObject({ 'User-Agent': 'opencode', Originator: 'opencode' })
    expect(cpaPrivacyHeaders({}, 'gemini-cli')).toMatchObject({ 'User-Agent': 'opencode', 'X-Goog-Api-Client': 'opencode' })
    expect(cpaPrivacyHeaders({ 'x-app': 'caller-app', 'X-App': 'caller-app' }, 'claude')).not.toHaveProperty('X-App')
  })
  it('produces minimal default patches without replacing OAuth or tool protocol options', () => {
    const { config } = fixture()
    const patch = cpaPrivacyDefaultsPatch(config)
    expect(patch).toEqual({ upstream: { claude: { 'header-defaults': { 'user-agent': 'opencode' } }, codex: { 'disable-codex-cloaking': true } },
      oauth: { providers: { codex: { 'header-defaults': { 'user-agent': 'opencode' } } } } })
    merge(config, patch)
    expect(config.upstream.claude['header-defaults'].timeout).toBe('600')
    expect(config.oauth.providers.codex['header-defaults']['beta-features']).toBe('preserved-protocol-beta')
    expect(cpaPrivacyDefaultsPatch(config)).toEqual({})
  })
  it('clears configured legacy device and SDK values while retaining unrelated protocol defaults', () => {
    const { config } = fixture()
    Object.assign(config.upstream.claude['header-defaults'], { 'user-agent': 'opencode', 'package-version': '1.2.3', 'runtime-version': 'v20.0.1', os: 'PrivateOS', arch: 'PrivateArch' })
    const patch = cpaPrivacyDefaultsPatch(config) as any
    expect(patch.upstream.claude['header-defaults']).toEqual({ 'package-version': '', 'runtime-version': '', os: '', arch: '' })
    merge(config, patch)
    expect(config.upstream.claude['header-defaults'].timeout).toBe('600')
    expect(config.upstream.claude['header-defaults'].timezone).toBe('Asia/Shanghai')
    expect(cpaPrivacyDefaultsPatch(config)).toEqual({})
  })
  it('retains every provider field, sibling key and model while disabling Codex final cloaking', () => {
    const { config } = fixture(), original = structuredClone(config['api-keys'])
    const patch = cpaPrivacyApiKeysPatch(original) as any
    expect(patch.codex[0]).toMatchObject({ name: 'server-source', 'request-retry': 2, models: original.codex[0].models,
      keys: [{ 'api-key': 'synthetic-upstream-key', 'disable-codex-cloaking': true, headers: { 'User-Agent': 'opencode', Originator: 'opencode', 'X-Preserved': 'key' } }] })
    expect(original).toEqual(config['api-keys'])
    expect(cpaPrivacyApiKeysPatch(patch)).toEqual({})
  })
  it('updates file metadata without dropping tokens and re-synthesizes virtual source files safely', async () => {
    const { client, config, documents, request } = fixture()
    expect(await applyCpaPrivacyPolicy(client)).toEqual({ changed: true, updatedFiles: 2 })
    expect(documents.get('oauth.json')).toMatchObject({ access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', custom: { preserved: true }, headers: { 'User-Agent': 'opencode', 'X-Custom': 'keep' } })
    expect(documents.get('oauth.json').headers).not.toHaveProperty('X-App')
    expect(documents.get('projects.json')).toMatchObject({ project_ids: ['one', 'two'], access_token: 'synthetic-project-access', headers: { 'User-Agent': 'opencode', 'X-Goog-Api-Client': 'opencode' } })
    expect(config['api-keys'].codex[0].keys[0]['api-key']).toBe('synthetic-upstream-key')
    expect(request.mock.calls.some(([input]) => input.path === 'credentials' && input.method === 'POST')).toBe(true)
    const previousWrites = request.mock.calls.filter(([input]) => input.method).length
    expect(await applyCpaPrivacyPolicy(client)).toEqual({ changed: false, updatedFiles: 0 })
    expect(request.mock.calls.filter(([input]) => input.method).length).toBe(previousWrites)
  })
  it('sets the Codex software headers while preserving the native session and account metadata', () => {
    const document = { type: 'codex', access_token: 'synthetic-oauth', account_id: 'private-upstream-account', unknown: { safe: true } }
    expect(cpaPrivacyCredentialPatch(document)).toEqual({ headers: { 'User-Agent': 'opencode', Originator: 'opencode' } })
    expect(document.account_id).toBe('private-upstream-account')
  })
  it('reports failed persistence instead of letting the caller assume outgoing labels were updated', async () => {
    const { client, request } = fixture()
    const implementation = request.getMockImplementation()!
    request.mockImplementation(async (input: any) => input.path === 'credentials/fields' ? response({ status: 'ok' }) : implementation(input))
    await expect(applyCpaPrivacyPolicy(client, { fileNames: ['oauth.json'] })).rejects.toThrow('not persisted')
  })
  it('allows the deployment adapter to update only the fixed management core without inference calls', async () => {
    const { client } = fixture(), paths: string[] = []
    const result = await prepareNativePrivacy({ baseUrl: 'http://127.0.0.1:8317', managementKey: 'local-test-management-key',
      fetch: async (input: RequestInfo | URL, options?: RequestInit) => {
        const url = new URL(String(input)); paths.push(url.pathname)
        expect(url.origin).toBe('http://127.0.0.1:8317')
        expect(new Headers(options?.headers).get('authorization')).toBe('Bearer local-test-management-key')
        const reply = await client.request({ path: url.pathname.slice('/v8/management/'.length), ...(options?.method === 'GET' ? {} : { method: options?.method }),
          query: Object.fromEntries(url.searchParams), ...(options?.body ? { body: options.body } : {}) } as any)
        return new Response(reply.body, { status: reply.status })
      } })
    expect(result).toEqual({ changed: true, updatedFiles: 2 })
    expect(paths.every(path => path.startsWith('/v8/management/'))).toBe(true)
  })
})
