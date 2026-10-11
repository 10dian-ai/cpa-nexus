import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, defineEventHandler, getRequestURL, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  presets: vi.fn(), authenticate: vi.fn(), module: vi.fn(), enabled: vi.fn(), compat: vi.fn(), internal: vi.fn(), routing: vi.fn(),
  offers: vi.fn(), ccModels: vi.fn(), candidates: vi.fn(), provider: vi.fn(), policy: vi.fn(), log: vi.fn(), bindings: vi.fn(),
  capabilities: vi.fn(), devinLevels: vi.fn(), invalidate: vi.fn(), limit: 1, stalePolicyOnce: false,
  /** Core behaviour per model sent to CPA: status and JSON body. */
  core: new Map<string, { status: number; body: unknown }>(),
}))
vi.mock('../server/lib/modules', () => ({ requireModule: fixture.module, isModuleEnabled: fixture.enabled }))
vi.mock('../server/lib/groups', () => ({ resolveKeyRouting: fixture.routing, accountGroupBindings: fixture.bindings }))
vi.mock('../server/lib/cpa/group-routing', () => ({ listCpaGroupOffers: fixture.offers }))
vi.mock('../server/lib/cpa/group-policy', () => ({ CPA_GROUP_POLICY_HEADER: 'x-nexus-group-policy', registerCpaGroupPolicy: fixture.policy, invalidateCpaGroupPolicy: fixture.invalidate }))
vi.mock('../server/lib/cpa/nexus-capabilities', () => ({ getNexusCpaCapabilities: fixture.capabilities }))
vi.mock('../server/lib/logs', () => ({ insertRequestLog: fixture.log }))
vi.mock('../server/lib/gateway/accounts', () => ({ listGatewayModels: fixture.ccModels, listCandidates: fixture.candidates }))
vi.mock('../server/lib/official-catalog', () => ({ getProviderModel: fixture.provider }))
vi.mock('../server/lib/auth', () => ({ authenticateGatewayKey: fixture.authenticate }))
vi.mock('../server/lib/config', () => ({ getConfig: () => ({ encryptionKey: 'test-only-privacy-secret' }) }))
vi.mock('../server/lib/presets', () => ({ resolveGroupPresetStack: fixture.presets }))
vi.mock('../server/lib/settings', () => ({ getSettings: async () => ({ maxRequestBodyMb: fixture.limit, upstreamTimeoutSeconds: 600, devinDefaultEffort: 'high', devinStripSampling: true }) }))
vi.mock('../server/lib/commandcode-compat', () => ({ handleCommandcodeCompatibility: fixture.compat, isCommandcodeFailure: (value: any) => !!value && value.failed === true }))
vi.mock('../server/lib/gateway/handler', () => ({ handleGateway: fixture.internal }))
vi.mock('../server/lib/routing/devin-params', async importOriginal => ({ ...await importOriginal<object>(), devinThinkingLevels: fixture.devinLevels }))
import { handleNexusInference } from '../server/lib/cpa/inference'
import { resetGlobalModelCache } from '../server/lib/routing/plan'
import modelRoute from '../server/routes/v1/[...path]'
import { signOriginalGatewayKey } from '../server/lib/commandcode-identity'

const preset = (name = 'Default') => ({ id: name, sourceJson: { prompts: [{ identifier: 'main', role: 'system', content: name }, { identifier: 'chatHistory', marker: true }], prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }], temperature: 0.4 }, variables: {} })
const offer = (groupId: string, sourceId: string, models: string[]) => ({ groupId, sourceId, provider: 'fixture', prefix: '', authIds: [sourceId + '-auth'], models })

describe('unified model key router', () => {
  let core: Server, app: Server, url: string
  let received: { path: string; headers: Record<string, unknown>; raw: string; body: any }[]
  let release: (() => void) | undefined, cancelled: boolean
  beforeEach(async () => {
    vi.resetAllMocks(); resetGlobalModelCache(); fixture.limit = 1; fixture.core.clear(); fixture.stalePolicyOnce = false
    fixture.presets.mockResolvedValue([]); fixture.module.mockResolvedValue(undefined)
    fixture.enabled.mockResolvedValue(true); fixture.routing.mockResolvedValue({ groupIds: ['group-a'], strategy: 'failover' })
    fixture.policy.mockResolvedValue('server-generated-private-policy')
    fixture.log.mockResolvedValue(undefined); fixture.capabilities.mockResolvedValue(null); fixture.bindings.mockResolvedValue(new Map())
    fixture.devinLevels.mockResolvedValue(new Map([['devin/claude-opus-4-8', ['low', 'medium', 'high', 'max']]]))
    fixture.offers.mockResolvedValue([offer('group-a', 'source-a', ['native-model', 'devin/claude-opus-4-8', 'gemini-3-pro'])])
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
      let body: any; try { body = JSON.parse(raw || '{}') } catch { /* Native multipart uploads stay opaque. */ }
      received.push({ path: req.url!, headers: req.headers, raw, body })
      if (!['Bearer native-key', 'Bearer core-client-key'].includes(String(req.headers.authorization))) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"invalid core key"}'); return }
      if (req.url?.startsWith('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"object":"list","data":[{"id":"native-model"},{"id":"router-alias"}]}'); return }
      if (fixture.stalePolicyOnce && req.headers['x-nexus-group-policy']) {
        fixture.stalePolicyOnce = false
        res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":{"code":"nexus_group_policy_invalid","message":"Invalid or expired group policy"}}'); return
      }
      const scripted = fixture.core.get(body?.model)
      if (scripted) { res.writeHead(scripted.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(scripted.body)); return }
      if (raw.includes('"stream":true')) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'x-cpa-trace-id': '20261011000000-idx7-request' }); res.write('data: first\n\n')
        release = () => res.end('data: [DONE]\n\n')
        res.once('close', () => { cancelled = true }); return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-cpa-version': 'v8.0.15', 'x-cpa-trace-id': '20261011000000-idx7-request' }); res.end(JSON.stringify({ raw, body }))
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
    vi.unstubAllEnvs()
  })
  const post = (body: Record<string, unknown>, key = 'native-key', protocol = 'chat/completions') => fetch(url + '/' + protocol, { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', 'anthropic-beta': 'tools-fixture' }, body: JSON.stringify(body) })
  const generations = () => received.filter(item => !item.path.startsWith('/v1/models'))

  describe('native CPA keys', () => {
    it('preserves extended endpoints, query strings and multipart bodies', async () => {
      fixture.limit = 0.000001
      for (const path of ['images/generations', 'messages/count_tokens', 'videos']) {
        const body = { model: 'native-model', prompt: 'native protocol', messages: [{ role: 'user', content: 'native count' }] }
        const response = await post(body, 'native-key', path)
        expect(response.status).toBe(200); expect((await response.json()).body).toEqual(body)
        expect(received.at(-1)?.path).toBe('/v1/' + path)
      }
      const raw = '--fixture-boundary\r\nContent-Disposition: form-data; name="image"; filename="fixture.png"\r\nContent-Type: image/png\r\n\r\nlocal-image-bytes\r\n--fixture-boundary--\r\n'
      const edit = await fetch(url + '/images/edits?size=original', { method: 'POST', headers: { authorization: 'Bearer native-key', 'content-type': 'multipart/form-data; boundary=fixture-boundary', 'x-nexus-group-policy': 'caller-forged-policy' }, body: raw })
      expect(edit.status).toBe(200); expect((await edit.json()).raw).toBe(raw)
      expect(received.at(-1)?.headers['x-nexus-group-policy']).toBeUndefined()
      const status = await fetch(url + '/videos/native-job?poll=true', { headers: { authorization: 'Bearer native-key' } })
      expect(status.status).toBe(200); await status.text()
      expect(received.at(-1)?.path).toBe('/v1/videos/native-job?poll=true')
      expect(fixture.authenticate).not.toHaveBeenCalled(); expect(fixture.policy).not.toHaveBeenCalled(); expect(fixture.presets).not.toHaveBeenCalled()
    })

    it('keeps body bytes and core authentication untouched and hides the credential trace', async () => {
      const raw = '{ "model": "fixture", "messages": [{"role":"user","content":"hello"}], "tools": [] }'
      const response = await fetch(url + '/chat/completions?test=1', { method: 'POST', headers: { authorization: 'Bearer native-key', 'content-type': 'application/json', 'anthropic-beta': 'fixture', cookie: 'private=1', 'x-forwarded-for': '203.0.113.9', 'x-stainless-os': 'private' }, body: raw })
      expect(response.status).toBe(200); expect(response.headers.get('x-cpa-version')).toBe('v8.0.15')
      expect(response.headers.get('x-cpa-trace-id')).toBeNull()
      expect((await response.json()).raw).toBe(raw)
      expect(received[0]).toMatchObject({ path: '/v1/chat/completions?test=1', headers: { authorization: 'Bearer native-key', 'anthropic-beta': 'fixture' } })
      for (const name of ['cookie', 'x-forwarded-for', 'x-stainless-os']) expect(received[0]!.headers[name]).toBeUndefined()
      const denied = await post({ model: 'fixture' }, 'invalid'); expect(denied.status).toBe(401); await denied.text()
    })

    it('rejects a missing model key before contacting the core', async () => {
      const response = await fetch(url + '/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture', messages: [] }) })
      expect(response.status).toBe(401)
      expect((await response.json()).error.message).toBe('A valid model API key is required')
      expect(received).toHaveLength(0)
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
  })

  describe('model catalog', () => {
    it('lists original model names without provider namespaces', async () => {
      const direct = url.replace('/nexus/cpa/v1', '/v1')
      const catalog = await fetch(direct + '/models', { headers: { authorization: 'Bearer ccm_KA' } })
      expect(catalog.status).toBe(200)
      expect((await catalog.json()).data.map((model: { id: string }) => model.id)).toEqual(['claude-opus-4-8', 'gemini-3-pro', 'native-model'])
      const single = await fetch(url + '/models/claude-opus-4-8', { headers: { authorization: 'Bearer ccm_KA' } })
      expect((await single.json()).id).toBe('claude-opus-4-8')
      const missing = await fetch(url + '/models/devin-only-name', { headers: { authorization: 'Bearer ccm_KA' } })
      expect(missing.status).toBe(404); await missing.text()
      expect(generations()).toHaveLength(0)
    })

    it('serves the Gemini catalog shape on v1beta and accepts the key query parameter', async () => {
      const response = await fetch(url.replace('/v1', '/v1beta') + '/models?key=ccm_KA')
      expect(response.status).toBe(200)
      expect((await response.json()).models.map((model: { name: string }) => model.name)).toContain('models/claude-opus-4-8')
    })

    it('combines both modules for auto keys and survives one catalog outage', async () => {
      fixture.ccModels.mockResolvedValue({ object: 'list', data: [{ id: 'cc-model' }, { id: 'native-model' }] })
      const response = await fetch(url + '/models', { headers: { authorization: 'Bearer ccm_auto' } })
      expect((await response.json()).data.map((model: { id: string }) => model.id)).toEqual(['cc-model', 'claude-opus-4-8', 'gemini-3-pro', 'native-model'])
      fixture.offers.mockRejectedValue(new Error('Core unavailable'))
      const degraded = await fetch(url + '/models', { headers: { authorization: 'Bearer ccm_auto' } })
      expect((await degraded.json()).data.map((model: { id: string }) => model.id)).toEqual(['cc-model', 'native-model'])
    })
  })

  describe('requests', () => {
    it('maps the original name to the source model and restricts CPA to that group', async () => {
      const response = await post({ model: 'native-model', messages: [] }, 'ccm_KA')
      expect(response.status).toBe(200); expect(response.headers.get('x-cpa-trace-id')).toBeNull()
      expect((await response.json()).body.model).toBe('native-model')
      expect(fixture.policy).toHaveBeenCalledWith({ keyId: 'KA', allowedAuthIDs: ['source-a-auth'], allowedPluginIDs: [] })
      expect(generations()[0]!.headers).toMatchObject({ authorization: 'Bearer core-client-key', 'x-nexus-group-policy': 'server-generated-private-policy' })
    })

    it('converts standard thinking parameters for CPA Devin models', async () => {
      const response = await post({ model: 'claude-opus-4-8', reasoning_effort: 'max', temperature: 0.7, messages: [{ role: 'user', content: 'hi' }] }, 'ccm_KA')
      expect(response.status).toBe(200)
      const { body } = await response.json()
      expect(body.model).toBe('devin/claude-opus-4-8(max)')
      expect(body.reasoning_effort).toBeUndefined(); expect(body.temperature).toBeUndefined()
      const anthropic = await post({ model: 'claude-opus-4-8-high', max_tokens: 100, thinking: { type: 'enabled', budget_tokens: 2000 }, messages: [] }, 'ccm_KA', 'messages')
      expect((await anthropic.json()).body).toMatchObject({ model: 'devin/claude-opus-4-8(high)', max_tokens: 100 })
      const legacy = await post({ model: 'devin/claude-opus-4-8', messages: [] }, 'ccm_KA')
      expect((await legacy.json()).body.model).toBe('devin/claude-opus-4-8(high)')
      expect(fixture.log.mock.calls.at(-1)![0].usage.nexus.devin).toMatchObject({ level: 'high', source: 'default' })
    })

    it('applies the presets of the serving group exactly once', async () => {
      fixture.presets.mockImplementation(async (groupId: string) => groupId === 'group-a' ? [preset('First'), preset('Second')] : [])
      const response = await post({ model: 'native-model', messages: [{ role: 'user', content: 'Client' }] }, 'ccm_KB')
      expect(response.headers.get('x-nexus-preset-id')).toBe('First,Second')
      expect((await response.json()).body.messages).toEqual([{ role: 'system', content: 'First' }, { role: 'system', content: 'Second' }, { role: 'user', content: 'Client' }])
      expect(fixture.presets).toHaveBeenCalledWith('group-a')
      expect(generations()).toHaveLength(1)
    })

    it('fails over to the next group and uses that group’s presets', async () => {
      fixture.routing.mockResolvedValue({ groupIds: ['group-a', 'group-b'], strategy: 'failover' })
      fixture.offers.mockResolvedValue([offer('group-a', 'devin-a', ['devin/claude-opus-4-8']), offer('group-b', 'claude-b', ['claude-opus-4-8'])])
      fixture.presets.mockImplementation(async (groupId: string) => [preset('Preset ' + groupId)])
      fixture.core.set('devin/claude-opus-4-8(high)', { status: 403, body: { error: { message: 'permission_denied: an internal error occurred' } } })
      const response = await post({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }] }, 'ccm_KA')
      expect(response.status).toBe(200)
      const { body } = await response.json()
      expect(body.model).toBe('claude-opus-4-8')
      expect(body.messages[0]).toEqual({ role: 'system', content: 'Preset group-b' })
      expect(response.headers.get('x-nexus-preset-id')).toBe('Preset group-b')
      expect(generations().map(item => item.body.model)).toEqual(['devin/claude-opus-4-8(high)', 'claude-opus-4-8'])
      const log = fixture.log.mock.calls.at(-1)![0]
      expect(log.usage.nexus).toMatchObject({ groupId: 'group-b', strategy: 'failover', failover: [{ groupId: 'group-a', status: 403, error: 'permission_denied: an internal error occurred' }] })
    })

    it('returns client errors without trying other sources and passes the last failure through', async () => {
      fixture.routing.mockResolvedValue({ groupIds: ['group-a', 'group-b'], strategy: 'failover' })
      fixture.offers.mockResolvedValue([offer('group-a', 'a', ['native-model']), offer('group-b', 'b', ['native-model'])])
      fixture.core.set('native-model', { status: 400, body: { error: { message: 'messages: field required' } } })
      const invalid = await post({ model: 'native-model' }, 'ccm_KA')
      expect(invalid.status).toBe(400); expect((await invalid.json()).error.message).toBe('messages: field required')
      expect(generations()).toHaveLength(1)
      fixture.core.set('native-model', { status: 429, body: { error: { message: 'rate limited' } } })
      const limited = await post({ model: 'native-model', messages: [] }, 'ccm_KA')
      expect(limited.status).toBe(429); await limited.text()
      expect(generations()).toHaveLength(3)
      expect(fixture.log.mock.calls.at(-1)![0]).toMatchObject({ status: 'error', httpStatus: 429 })
    })

    it('returns 404 for a model outside the key groups and 403 without groups', async () => {
      const unknown = await post({ model: 'other-group-model', messages: [] }, 'ccm_auto')
      expect(unknown.status).toBe(404); expect((await unknown.json()).error.code).toBe('model_not_found')
      fixture.routing.mockResolvedValue({ groupIds: [], strategy: 'failover' })
      const disabled = await post({ model: 'native-model', messages: [] }, 'ccm_auto')
      expect(disabled.status).toBe(403); await disabled.text()
      expect(generations()).toHaveLength(0); expect(fixture.compat).not.toHaveBeenCalled()
    })

    it('lets CPA resolve router aliases inside the key groups', async () => {
      const response = await post({ model: 'router-alias', messages: [] }, 'ccm_KA')
      expect(response.status).toBe(200); expect((await response.json()).body.model).toBe('router-alias')
      expect(fixture.policy).toHaveBeenCalledWith({ keyId: 'KA', allowedAuthIDs: ['source-a-auth'], allowedPluginIDs: [] })
    })

    it('routes Gemini generateContent with the model in the path', async () => {
      const response = await fetch(url.replace('/v1', '/v1beta') + '/models/gemini-3-pro:generateContent?key=ccm_KA&alt=json', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }) })
      expect(response.status).toBe(200); await response.text()
      expect(generations()[0]!.path).toBe('/v1beta/models/gemini-3-pro:generateContent?alt=json')
      expect(generations()[0]!.headers.authorization).toBe('Bearer core-client-key')
    })

    it('forwards JSON calls without a model to CPA within the key sources', async () => {
      const response = await post({}, 'ccm_KA', 'responses/resp_1/cancel')
      expect(response.status).toBe(200); await response.text()
      expect(generations()[0]!.path).toBe('/v1/responses/resp_1/cancel')
      expect(fixture.policy).toHaveBeenCalledWith({ keyId: 'KA', allowedAuthIDs: ['source-a-auth'], allowedPluginIDs: [] })
    })

    it('registers a new group policy once when CPA no longer knows the cached one', async () => {
      fixture.stalePolicyOnce = true
      const response = await post({ model: 'native-model', messages: [] }, 'ccm_KA')
      expect(response.status).toBe(200); await response.text()
      expect(fixture.invalidate).toHaveBeenCalledWith({ keyId: 'KA', allowedAuthIDs: ['source-a-auth'], allowedPluginIDs: [] })
      expect(fixture.policy).toHaveBeenCalledTimes(2); expect(generations()).toHaveLength(2)
    })

    it('records the credential CPA actually used', async () => {
      fixture.capabilities.mockResolvedValue({ runtimeAccounts: [{ id: 'source-a-auth', authIndex: 'idx7', fileName: 'a.json' }] })
      const response = await post({ model: 'native-model', messages: [] }, 'ccm_KA'); await response.text()
      expect(fixture.log.mock.calls.at(-1)![0]).toMatchObject({ sourceId: 'source-a', status: 'success', usage: { nexus: { authIndex: 'idx7', groupId: 'group-a' } } })
      // The reply is kept for the request log detail page.
      expect(fixture.log.mock.calls.at(-1)![0].responseBody).toMatchObject({ body: { model: 'native-model' } })
    })

    it('preserves streaming with usage reporting for unified keys', async () => {
      fixture.presets.mockResolvedValue([preset('KB rule')])
      const response = await post({ model: 'native-model', messages: [{ role: 'user', content: 'hello' }], stream: true }, 'ccm_KB')
      expect(response.headers.get('x-nexus-preset-id')).toBe('KB rule')
      expect(response.headers.get('x-nexus-usage-policy')).toBe('upstream')
      const reader = response.body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('data: first')
      const forwarded = generations()[0]!.body
      expect(forwarded.messages[0].content).toBe('KB rule')
      expect(forwarded.stream_options).toEqual({ include_usage: true })
      release!()
      while (!(await reader.read()).done) { /* Drain the streamed response. */ }
    })

    it('normalizes the client identity and removes client credentials', async () => {
      const response = await fetch(url + '/messages', { method: 'POST', headers: {
        'x-api-key': 'ccm_KA', 'user-agent': 'claude-code/private-device', cookie: 'admin=private', 'x-goog-api-key': 'untrusted',
        'x-claude-code-session-id': 'private-session', 'anthropic-version': '2023-06-01',
        'x-nexus-original-key-id': 'forged', 'x-nexus-original-key-signature': 'forged',
      }, body: JSON.stringify({ model: 'native-model', messages: [{ role: 'user', content: 'hello' }] }) })
      expect(response.status).toBe(200); await response.text()
      const headers = generations()[0]!.headers
      expect(headers).toMatchObject({ authorization: 'Bearer core-client-key', 'user-agent': 'opencode', 'anthropic-version': '2023-06-01' })
      for (const header of ['cookie', 'x-api-key', 'x-goog-api-key', 'x-claude-code-session-id', 'x-nexus-original-key-id', 'x-nexus-original-key-signature']) expect(headers[header]).toBeUndefined()
    })

    it('returns bounded JSON errors for invalid input', async () => {
      const response = await fetch(url + '/messages', { method: 'POST', headers: { authorization: 'Bearer ccm_KB', 'content-type': 'application/json' }, body: '{' })
      expect(response.status).toBe(400); expect((await response.json()).type).toBe('error')
      expect(received).toHaveLength(0)
    })

    it('fails before forwarding when CPA is disabled or the private CPA key is absent', async () => {
      fixture.module.mockRejectedValueOnce(Object.assign(new Error('模块已停用'), { statusCode: 503 }))
      const disabled = await post({ model: 'native-model' }, 'ccm_KA')
      expect(disabled.status).toBe(503); await disabled.text()
      vi.stubEnv('CPA_CLIENT_KEY', '')
      const missing = await post({ model: 'native-model' }, 'ccm_KA')
      expect(missing.status).toBe(503); await missing.text()
      expect(received).toHaveLength(0)
    })
  })

  describe('CommandCode', () => {
    it('restores original CCM keys on all original public model paths', async () => {
      for (const path of ['models', 'chat/completions', 'messages', 'responses']) {
        const response = await fetch(url + '/' + path, { method: path === 'models' ? 'GET' : 'POST', headers: { authorization: 'Bearer ccm_original' }, ...(path === 'models' ? {} : { body: '{}' }) })
        expect(await response.text()).toBe('CCM')
        expect(fixture.compat.mock.calls.at(-1)![1]).toEqual({ protocolPath: path })
      }
      expect(received).toHaveLength(0)
    })

    it('rejects Command Code models for CPA-only keys', async () => {
      for (const protocol of ['chat/completions', 'messages', 'responses', 'systemone']) {
        const response = await post({ model: 'commandcode/fixture', messages: [] }, 'ccm_KA', protocol)
        expect(response.status).toBe(403); await response.text()
      }
      expect(received).toHaveLength(0); expect(fixture.compat).not.toHaveBeenCalled()
    })

    it('uses a CommandCode account from the key groups without consuming the body twice', async () => {
      fixture.provider.mockResolvedValue({ id: 'cc-model' }); fixture.candidates.mockResolvedValue([{ id: 'cc-account-a' }])
      fixture.bindings.mockResolvedValue(new Map([['cc-account-a', { groupIds: ['group-a'] }]]))
      const body = { model: 'cc-model', messages: [{ role: 'user', content: 'Group A' }], stream: true }
      const response = await post(body, 'ccm_auto'); expect(await response.text()).toBe('CCM')
      expect(fixture.candidates).toHaveBeenCalledWith('cc-model', 'auto')
      expect(fixture.compat.mock.calls.at(-1)![1]).toEqual({ protocolPath: 'chat/completions', body, failover: false })
      expect(generations()).toHaveLength(0)
    })

    it('fails over from CommandCode to a CPA source of the same model', async () => {
      fixture.provider.mockResolvedValue({ id: 'native-model' }); fixture.candidates.mockResolvedValue([{ id: 'cc-account-a' }])
      fixture.bindings.mockResolvedValue(new Map([['cc-account-a', { groupIds: ['group-a'] }]]))
      fixture.compat.mockResolvedValue({ failed: true, status: 429, message: 'all accounts cooling down' })
      const response = await post({ model: 'native-model', messages: [] }, 'ccm_auto')
      expect(response.status).toBe(200); expect((await response.json()).body.model).toBe('native-model')
      expect(fixture.compat.mock.calls[0]![1]).toMatchObject({ failover: true })
    })

    it('handles signed bridge callbacks and rejects unsigned ones', async () => {
      const direct = url.replace('/nexus/cpa/v1', '/v1')
      const bridge = await fetch(direct + '/messages', { method: 'POST', headers: { authorization: 'Bearer ccm_nexus_internal' }, body: '{}' })
      expect(await bridge.text()).toBe('internal bridge')
      const signed = await fetch(url + '/chat/completions', { method: 'POST', headers: {
        authorization: 'Bearer ccm_nexus_internal', 'content-type': 'application/json',
        'x-nexus-original-key-id': 'legacy-callback-key', 'x-nexus-original-key-signature': signOriginalGatewayKey('legacy-callback-key'),
      }, body: JSON.stringify({ model: 'fixture', messages: [] }) })
      expect(await signed.text()).toBe('internal bridge')
      expect(fixture.internal).toHaveBeenLastCalledWith(expect.anything(), { protocolPath: 'chat/completions' })
      for (const signature of ['', 'invalid-signature']) {
        const response = await fetch(url + '/messages', { method: 'POST', headers: {
          authorization: 'Bearer ccm_nexus_internal', 'content-type': 'application/json', 'x-nexus-original-key-id': 'legacy-callback-key',
          ...(signature ? { 'x-nexus-original-key-signature': signature } : {}),
        }, body: JSON.stringify({ model: 'fixture', messages: [] }) })
        expect(response.status).toBe(401); await response.text()
      }
    })
  })
})
