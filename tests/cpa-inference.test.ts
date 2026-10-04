import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, defineEventHandler, getRequestURL, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ route: vi.fn(), authenticate: vi.fn(), module: vi.fn(), enabled: vi.fn(), compat: vi.fn(), internal: vi.fn(), groups: vi.fn(), cpaModels: vi.fn(), cpaRoute: vi.fn(), ccModels: vi.fn(), candidates: vi.fn(), provider: vi.fn(), limit: 1 }))
vi.mock('../server/lib/modules', () => ({ requireModule: fixture.module, isModuleEnabled: fixture.enabled }))
vi.mock('../server/lib/groups', () => ({ resolveEnabledKeyGroupIds: fixture.groups }))
vi.mock('../server/lib/cpa/group-routing', () => ({ listCpaGroupModels: fixture.cpaModels, resolveCpaGroupModel: fixture.cpaRoute }))
vi.mock('../server/lib/gateway/accounts', () => ({ listGatewayModels: fixture.ccModels, listCandidates: fixture.candidates }))
vi.mock('../server/lib/official-catalog', () => ({ getProviderModel: fixture.provider }))
vi.mock('../server/lib/auth', () => ({ authenticateGatewayKey: fixture.authenticate }))
vi.mock('../server/lib/presets', () => ({ resolveKeyPresetStack: async (...args: unknown[]) => { const value = await fixture.route(...args); return Array.isArray(value) ? value : value ? [value] : [] } }))
vi.mock('../server/lib/settings', () => ({ getSettings: async () => ({ maxRequestBodyMb: fixture.limit }) }))
vi.mock('../server/lib/commandcode-compat', () => ({ handleCommandcodeCompatibility: fixture.compat }))
vi.mock('../server/lib/gateway/handler', () => ({ handleGateway: fixture.internal }))
import { handleNexusInference, resetCpaInferenceAuthCache } from '../server/lib/cpa/inference'
import modelRoute from '../server/routes/v1/[...path]'

const preset = (name = 'Default') => ({ id: name, sourceJson: { prompts: [{ identifier: 'main', role: 'system', content: name }, { identifier: 'chatHistory', marker: true }], prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }], temperature: 0.4 }, variables: {} })
describe('public CPA and original CCM inference routing', () => {
  let core: Server, app: Server, url: string
  let received: { path: string; headers: Record<string, unknown>; raw: string }[]
  let release: (() => void) | undefined, cancelled: boolean
  beforeEach(async () => {
    vi.resetAllMocks(); resetCpaInferenceAuthCache(); fixture.limit = 1
    fixture.route.mockResolvedValue(null); fixture.module.mockResolvedValue(undefined)
    fixture.enabled.mockResolvedValue(true); fixture.groups.mockResolvedValue(['group-a'])
    fixture.cpaModels.mockResolvedValue([{ id: 'custom/model' }, { id: 'native-model' }])
    fixture.cpaRoute.mockImplementation(async (model: string) => ({ accountId: 'source-a', model }))
    fixture.ccModels.mockResolvedValue({ object: 'list', data: [{ id: 'cc-model' }] }); fixture.candidates.mockResolvedValue([]); fixture.provider.mockResolvedValue(null)
    fixture.authenticate.mockImplementation(async (secret: string) => secret === 'ccm_KA' || secret === 'ccm_KB'
      ? { id: secret.slice(4), name: secret.slice(4), moduleId: 'cpa' }
      : secret === 'ccm_original' ? { id: 'original', name: 'legacy', moduleId: 'commandcode' }
        : secret === 'ccm_auto' ? { id: 'auto', name: 'all sources', moduleId: 'auto' } : null)
    fixture.compat.mockImplementation(event => { event.node.res.end('CCM') })
    fixture.internal.mockImplementation(event => { event.node.res.end('internal bridge') })
    received = []; cancelled = false
    core = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks).toString()
      received.push({ path: req.url!, headers: req.headers, raw })
      if (!['Bearer native-key', 'Bearer core-client-key'].includes(String(req.headers.authorization))) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"invalid core key"}'); return }
      if (req.url?.startsWith('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"object":"list","data":[{"id":"native-model"},{"id":"commandcode/fixture"},{"id":"custom/model"}]}'); return }
      if (raw.includes('"stream":true')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n')
        release = () => res.end('data: [DONE]\n\n')
        res.once('close', () => { cancelled = true }); return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-cpa-version': 'v8.0.11' }); res.end(JSON.stringify({ raw, body: JSON.parse(raw || '{}') }))
    })
    await new Promise<void>(resolve => core.listen(0, '127.0.0.1', resolve))
    vi.stubEnv('CPA_URL', 'http://127.0.0.1:' + (core.address() as AddressInfo).port)
    vi.stubEnv('CPA_CLIENT_KEY', 'core-client-key')
    const h3 = createApp(); h3.use(defineEventHandler(event => getRequestURL(event).pathname.startsWith('/v1/') ? modelRoute(event) : handleNexusInference(event))); app = createServer(toNodeListener(h3))
    await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve))
    url = 'http://127.0.0.1:' + (app.address() as AddressInfo).port + '/nexus/cpa/v1'
  })
  afterEach(async () => {
    release?.(); release = undefined
    for (const server of [app, core]) await new Promise<void>(resolve => { server.close(resolve); server.closeAllConnections() })
    vi.unstubAllEnvs(); resetCpaInferenceAuthCache()
  })
  const post = (body: Record<string, unknown>, key = 'native-key', protocol = 'chat/completions') => fetch(url + '/' + protocol, { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', 'anthropic-beta': 'tools-fixture' }, body: JSON.stringify(body) })

  it('forwards all enabled presets for an opted-in key exactly once in library order', async () => {
    fixture.route.mockResolvedValue([preset('First'), preset('Second')])
    const response = await post({ model: 'fixture', messages: [{ role: 'user', content: 'Client' }] }, 'ccm_KB')
    expect(response.status).toBe(200)
    expect(response.headers.get('x-nexus-preset-id')).toBe('First,Second')
    expect((await response.json()).body.messages).toEqual([{ role: 'system', content: 'First' }, { role: 'system', content: 'Second' }, { role: 'user', content: 'Client' }])
    expect(received).toHaveLength(1)
    expect(fixture.route).toHaveBeenCalledWith('KB')
  })

  it('keeps native body bytes, protocol headers and core authentication untouched when disabled', async () => {
    const raw = '{ "model": "fixture", "messages": [{"role":"user","content":"hello"}], "tools": [] }'
    const response = await fetch(url + '/chat/completions?test=1', { method: 'POST', headers: { authorization: 'Bearer native-key', 'content-type': 'application/json', 'anthropic-beta': 'fixture' }, body: raw })
    expect(response.status).toBe(200); expect(response.headers.get('x-cpa-version')).toBe('v8.0.11')
    expect((await response.json()).raw).toBe(raw)
    expect(received[0]).toMatchObject({ path: '/v1/chat/completions?test=1', headers: { authorization: 'Bearer native-key', 'anthropic-beta': 'fixture' } })
    expect(fixture.route).not.toHaveBeenCalled()
    const denied = await post({ model: 'fixture' }, 'invalid'); expect(denied.status).toBe(401); await denied.text()
  })

  it('restores original CCM keys on all original public model paths', async () => {
    for (const path of ['models', 'chat/completions', 'messages', 'responses']) {
      const response = await fetch(url + '/' + path, { method: path === 'models' ? 'GET' : 'POST', headers: { authorization: 'Bearer ccm_original' }, ...(path === 'models' ? {} : { body: '{}' }) })
      expect(await response.text()).toBe('CCM')
      expect(fixture.compat.mock.calls.at(-1)![1]).toEqual({ protocolPath: path })
    }
    expect(received).toHaveLength(0)
  })

  it('supports the same public /v1 URL in local development and keeps private bridge callbacks separate', async () => {
    const direct = url.replace('/nexus/cpa/v1', '/v1')
    const response = await post({ model: 'fixture', messages: [] }, 'ccm_KA').then(reply => reply.json())
    expect(response.body.model).toBe('fixture')
    const catalog = await fetch(direct + '/models', { headers: { authorization: 'Bearer ccm_KA' } })
    expect(catalog.status).toBe(200); expect((await catalog.json()).data.map((model: { id: string }) => model.id)).toEqual(['custom/model', 'native-model'])
    const bridge = await fetch(direct + '/messages', { method: 'POST', headers: { authorization: 'Bearer ccm_nexus_internal' }, body: '{}' })
    expect(await bridge.text()).toBe('internal bridge'); expect(fixture.internal).toHaveBeenCalledTimes(1)
    const publicBridge = await post({ model: 'fixture' }, 'ccm_nexus_internal')
    expect(publicBridge.status).toBe(401); await publicBridge.text()
  })

  it('applies KB preset once and preserves client controls and original model prefix', async () => {
    fixture.route.mockResolvedValue(preset('KB rule'))
    const tools = [{ type: 'function', function: { name: 'lookup' } }]
    const response = await post({ model: 'nexus-prefix/fixture', messages: [{ role: 'user', content: 'hello' }], temperature: 0.9, tools }, 'ccm_KB')
    expect(response.status).toBe(200); expect(response.headers.get('x-nexus-preset-id')).toBe('KB rule')
    const { body } = await response.json()
    expect(body).toMatchObject({ model: 'nexus-prefix/fixture', temperature: 0.9, tools, messages: [{ role: 'system', content: 'KB rule' }, { role: 'user', content: 'hello' }] })
    expect(fixture.route).toHaveBeenCalledWith('KB')
    expect(received.filter(request => request.path === '/v1/chat/completions')).toHaveLength(1)
  })

  it('keeps KA ordinary and transforms only KB for the same model', async () => {
    fixture.route.mockImplementation(async (keyId: string) => keyId === 'KB' ? preset('KB rule') : null)
    const body = { model: 'prefix/fixture', messages: [{ role: 'user', content: 'hello' }] }
    const ordinary = await post(body, 'ccm_KA')
    expect(ordinary.headers.get('x-nexus-preset-id')).toBeNull()
    expect((await ordinary.json()).body).toEqual(body)
    const customized = await post(body, 'ccm_KB')
    expect(customized.headers.get('x-nexus-preset-id')).toBe('KB rule')
    expect((await customized.json()).body.messages).toEqual([{ role: 'system', content: 'KB rule' }, ...body.messages])
    expect(received).toHaveLength(2)
  })

  it('rejects invalid credentials before reading or transforming a preset request', async () => {
    fixture.route.mockResolvedValue(preset())
    const response = await post({ model: 'fixture', messages: [] }, 'ccm_invalid')
    expect(response.status).toBe(401); await response.text()
    expect(fixture.route).not.toHaveBeenCalled()
    expect(received).toHaveLength(0)
  })

  it('keeps Responses input, instructions and tools while adding a preset', async () => {
    fixture.route.mockResolvedValue(preset())
    const response = await post({ model: 'fixture', input: 'hello', instructions: 'Client instruction', tools: [{ type: 'web_search' }] }, 'ccm_KB', 'responses')
    expect(response.status).toBe(200)
    const { body } = await response.json()
    expect(body.tools).toEqual([{ type: 'web_search' }]); expect(body.model).toBe('fixture')
    expect(JSON.stringify(body)).toContain('Default'); expect(JSON.stringify(body)).toContain('Client instruction'); expect(JSON.stringify(body)).toContain('hello')
  })

  it('returns bounded JSON errors for invalid preset input without invoking inference', async () => {
    const response = await fetch(url + '/messages', { method: 'POST', headers: { authorization: 'Bearer ccm_KB', 'content-type': 'application/json' }, body: '{' })
    expect(response.status).toBe(400); expect((await response.json()).type).toBe('error')
    expect(received).toHaveLength(0)
  })

  it('uses the private core key for CPA and removes client credentials and bridge identity headers', async () => {
    const response = await fetch(url + '/messages', { method: 'POST', headers: {
      'x-api-key': 'ccm_KA', cookie: 'admin=private', 'x-goog-api-key': 'untrusted', 'anthropic-beta': 'fixture',
      'x-nexus-original-key-id': 'forged', 'x-nexus-original-key-signature': 'forged',
    }, body: JSON.stringify({ model: 'fixture', messages: [{ role: 'user', content: 'hello' }] }) })
    expect(response.status).toBe(200); await response.text()
    expect(received[0]!.headers).toMatchObject({ authorization: 'Bearer core-client-key', 'anthropic-beta': 'fixture' })
    for (const header of ['cookie', 'x-api-key', 'x-goog-api-key', 'x-nexus-original-key-id', 'x-nexus-original-key-signature']) expect(received[0]!.headers[header]).toBeUndefined()
  })

  it('filters Command Code models and rejects crossing a CPA key module binding', async () => {
    const catalog = await fetch(url + '/models', { headers: { authorization: 'Bearer ccm_KA' } })
    expect(await catalog.json()).toEqual({ object: 'list', data: [{ id: 'custom/model' }, { id: 'native-model' }] })
    received.length = 0
    for (const protocol of ['chat/completions', 'messages', 'responses', 'systemone']) {
      const response = await post({ model: 'commandcode/fixture', messages: [] }, 'ccm_KA', protocol)
      expect(response.status).toBe(403); await response.text()
    }
    expect(received).toHaveLength(0); expect(fixture.route).not.toHaveBeenCalled(); expect(fixture.compat).not.toHaveBeenCalled()
  })

  it('fails before forwarding when the selected module is disabled or the private CPA key is absent', async () => {
    fixture.module.mockRejectedValueOnce(Object.assign(new Error('模块已停用'), { statusCode: 503 }))
    const disabled = await post({ model: 'fixture' }, 'ccm_KA')
    expect(disabled.status).toBe(503); await disabled.text()
    vi.stubEnv('CPA_CLIENT_KEY', '')
    const missing = await post({ model: 'fixture' }, 'ccm_KA')
    expect(missing.status).toBe(503); await missing.text()
    expect(received).toHaveLength(0); expect(fixture.route).not.toHaveBeenCalled()
  })

  it('streams the first event promptly and cancels the core when the client disconnects', async () => {
    const abort = new AbortController()
    const response = await fetch(url + '/responses', { method: 'POST', headers: { authorization: 'Bearer native-key', 'content-type': 'application/json' }, body: '{"model":"fixture","stream":true}', signal: abort.signal })
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: first')
    abort.abort(); await reader.cancel().catch(() => {})
    for (let i = 0; i < 50 && !cancelled; i++) await new Promise(resolve => setTimeout(resolve, 20))
    expect(cancelled).toBe(true)
  })

  it('combines only the key-accessible catalogs across both modules and deduplicates model IDs', async () => {
    fixture.ccModels.mockResolvedValue({ object: 'list', data: [{ id: 'cc-model' }, { id: 'native-model' }] })
    const response = await fetch(url + '/models', { headers: { authorization: 'Bearer ccm_auto' } })
    expect(response.status).toBe(200)
    expect((await response.json()).data.map((model: { id: string }) => model.id)).toEqual(['cc-model', 'custom/model', 'native-model'])
    expect(fixture.cpaModels).toHaveBeenCalledWith(['group-a']); expect(fixture.ccModels).toHaveBeenCalledWith('auto')
    expect(received).toHaveLength(0)
  })

  it('uses a CommandCode provider from the same groups without consuming the body twice', async () => {
    fixture.provider.mockResolvedValue({ id: 'cc-model' }); fixture.candidates.mockResolvedValue([{ id: 'cc-account-a' }])
    const body = { model: 'cc-model', messages: [{ role: 'user', content: 'Group A' }], stream: true }
    const response = await post(body, 'ccm_auto'); expect(await response.text()).toBe('CCM')
    expect(fixture.candidates).toHaveBeenCalledWith('cc-model', 'auto')
    expect(fixture.compat.mock.calls.at(-1)![1]).toEqual({ protocolPath: 'chat/completions', body })
    expect(fixture.cpaRoute).not.toHaveBeenCalled(); expect(fixture.route).not.toHaveBeenCalled(); expect(received).toHaveLength(0)
  })

  it('uses the verified CPA source route after applying the shared preset once', async () => {
    fixture.cpaRoute.mockResolvedValue({ accountId: 'cpa-group-a', model: 'nexus-group-a/native-model(high)' })
    fixture.route.mockResolvedValue([preset('Shared')])
    const response = await post({ model: 'native-model(high)', messages: [{ role: 'user', content: 'Original' }] }, 'ccm_auto')
    expect(response.status).toBe(200)
    const { body } = await response.json()
    expect(body.model).toBe('nexus-group-a/native-model(high)')
    expect(body.messages).toEqual([{ role: 'system', content: 'Shared' }, { role: 'user', content: 'Original' }])
    expect(fixture.cpaRoute).toHaveBeenCalledWith('native-model(high)', ['group-a'], 'auto')
    expect(received).toHaveLength(1)
  })

  it('does not fall back to a model outside the key groups or with no enabled groups', async () => {
    fixture.cpaRoute.mockResolvedValue(null)
    const forbidden = await post({ model: 'other-group-model', messages: [] }, 'ccm_auto')
    expect(forbidden.status).toBe(404); await forbidden.text()
    fixture.groups.mockResolvedValue([])
    const disabled = await post({ model: 'native-model', messages: [] }, 'ccm_auto')
    expect(disabled.status).toBe(403); await disabled.text()
    expect(received).toHaveLength(0); expect(fixture.compat).not.toHaveBeenCalled()
  })

  it('keeps the healthy module usable when the other model catalog is unavailable', async () => {
    fixture.cpaModels.mockRejectedValue(new Error('Core unavailable'))
    const response = await fetch(url + '/models', { headers: { authorization: 'Bearer ccm_auto' } })
    expect(response.status).toBe(200); expect((await response.json()).data).toEqual([{ id: 'cc-model' }])
    fixture.provider.mockRejectedValue(new Error('Official catalog temporarily unavailable'))
    const native = await post({ model: 'native-model', messages: [] }, 'ccm_auto')
    expect(native.status).toBe(200); await native.text()
  })

  it('preserves streaming for a unified CPA key with its selected preset', async () => {
    fixture.route.mockResolvedValue(preset('KB rule'))
    const response = await post({ model: 'fixture', messages: [{ role: 'user', content: 'hello' }], stream: true }, 'ccm_KB')
    expect(response.headers.get('x-nexus-preset-id')).toBe('KB rule')
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: first')
    expect(JSON.parse(received[0]!.raw).messages[0].content).toBe('KB rule')
    release!()
    while (!(await reader.read()).done) { /* Drain the streamed response. */ }
  })
})
