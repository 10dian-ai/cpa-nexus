import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, defineEventHandler, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Routing between the CPA kernel (including its native Devin provider), the
// Devin module and CommandCode for unified ccm_ model keys.
const fixture = vi.hoisted(() => ({
  authenticate: vi.fn(), enabled: vi.fn(), module: vi.fn(), groups: vi.fn(), cpaRoute: vi.fn(), cpaModels: vi.fn(),
  devinResolve: vi.fn(), devinModels: vi.fn(), devinHandle: vi.fn(), compat: vi.fn(), provider: vi.fn(), candidates: vi.fn(),
  presets: vi.fn(), policy: vi.fn(), log: vi.fn(),
}))
vi.mock('../server/lib/auth', () => ({ authenticateGatewayKey: fixture.authenticate }))
vi.mock('../server/lib/modules', () => ({ isModuleEnabled: fixture.enabled, requireModule: fixture.module }))
vi.mock('../server/lib/groups', () => ({ resolveEnabledKeyGroupIds: fixture.groups }))
vi.mock('../server/lib/cpa/group-routing', () => ({ listCpaGroupModels: fixture.cpaModels, resolveCpaGroupPolicy: fixture.cpaRoute }))
vi.mock('../server/lib/cpa/group-policy', () => ({ CPA_GROUP_POLICY_HEADER: 'x-nexus-group-policy', registerCpaGroupPolicy: fixture.policy }))
vi.mock('../server/lib/devin2api/routing', () => ({ resolveDevin2ApiModel: fixture.devinResolve, listDevin2ApiGroupModels: fixture.devinModels }))
vi.mock('../server/lib/devin2api/inference', () => ({ handleDevin2ApiInference: fixture.devinHandle }))
vi.mock('../server/lib/commandcode-compat', () => ({ handleCommandcodeCompatibility: fixture.compat }))
vi.mock('../server/lib/gateway/handler', () => ({ handleGateway: vi.fn() }))
vi.mock('../server/lib/gateway/accounts', () => ({ listGatewayModels: vi.fn(async () => ({ data: [] })), listCandidates: fixture.candidates }))
vi.mock('../server/lib/official-catalog', () => ({ getProviderModel: fixture.provider }))
vi.mock('../server/lib/presets', () => ({ resolveKeyPresetStack: fixture.presets }))
vi.mock('../server/lib/logs', () => ({ insertRequestLog: fixture.log }))
vi.mock('../server/lib/settings', () => ({ getSettings: async () => ({ maxRequestBodyMb: 1 }) }))
vi.mock('../server/lib/config', () => ({ getConfig: () => ({ encryptionKey: 'test-only-privacy-secret' }) }))
import { handleNexusInference } from '../server/lib/cpa/inference'
import { resolveInferenceRoute } from '../server/lib/inference-route'
import { modelErrorBody } from '../server/lib/model-errors'

const devinSelection = { model: 'claude-opus-5-5', matchedGroupId: 'group-devin', account: { id: 'devin-account' } }

describe('unified model key routing', () => {
  let core: Server, app: Server, url: string
  let received: { path: string; body: Record<string, unknown>; headers: Record<string, unknown> }[]
  beforeEach(async () => {
    vi.resetAllMocks()
    fixture.authenticate.mockImplementation(async (secret: string) => ({
      ccm_auto: { id: 'auto', name: 'auto', moduleId: 'auto' },
      ccm_cpa: { id: 'cpa', name: 'cpa', moduleId: 'cpa' },
      ccm_legacy: { id: 'legacy', name: 'legacy', moduleId: 'commandcode' },
    } as Record<string, unknown>)[secret] ?? null)
    fixture.enabled.mockResolvedValue(true)
    fixture.module.mockResolvedValue(undefined)
    fixture.groups.mockResolvedValue(['group-cpa', 'group-devin'])
    fixture.cpaRoute.mockImplementation(async (model: string) => ({ model, selectedGroupId: 'group-cpa', allowedAuthIDs: ['devin-native-auth'], allowedPluginIDs: [] }))
    fixture.cpaModels.mockResolvedValue([])
    fixture.devinResolve.mockResolvedValue(null)
    fixture.devinModels.mockResolvedValue([])
    fixture.devinHandle.mockImplementation(event => { event.node.res.end('devin module') })
    fixture.compat.mockImplementation(event => { event.node.res.end('commandcode') })
    fixture.provider.mockResolvedValue(null)
    fixture.candidates.mockResolvedValue([])
    fixture.presets.mockResolvedValue([])
    fixture.policy.mockResolvedValue('signed-policy')
    fixture.log.mockResolvedValue(undefined)
    received = []
    core = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      received.push({ path: req.url!, body: JSON.parse(Buffer.concat(chunks).toString() || '{}'), headers: req.headers })
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}')
    })
    await new Promise<void>(resolve => core.listen(0, '127.0.0.1', resolve))
    vi.stubEnv('CPA_URL', 'http://127.0.0.1:' + (core.address() as AddressInfo).port)
    vi.stubEnv('CPA_CLIENT_KEY', 'core-client-key')
    const h3 = createApp(); h3.use(defineEventHandler(handleNexusInference)); app = createServer(toNodeListener(h3))
    await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve))
    url = 'http://127.0.0.1:' + (app.address() as AddressInfo).port + '/nexus/cpa/v1/'
  })
  afterEach(async () => {
    for (const server of [app, core]) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    vi.unstubAllEnvs()
  })
  const post = (key: string, body: Record<string, unknown>, path = 'chat/completions') => fetch(url + path, {
    method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

  it('keeps CPA native Devin models on the kernel when the Devin module is disabled', async () => {
    fixture.enabled.mockImplementation(async (id: string) => id !== 'devin2api')
    const response = await post('ccm_auto', { model: 'devin/claude-opus-5-5', messages: [] })
    expect(response.status).toBe(200)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ path: '/v1/chat/completions', body: { model: 'devin/claude-opus-5-5' } })
    expect(received[0]!.headers['x-nexus-group-policy']).toBe('signed-policy')
    expect(fixture.devinResolve).not.toHaveBeenCalled()
    expect(fixture.devinHandle).not.toHaveBeenCalled()
  })

  it('lets CPA-bound keys call the native Devin provider instead of rejecting devin/ models', async () => {
    const response = await post('ccm_cpa', { model: 'devin/swe-1-6', messages: [] })
    expect(response.status).toBe(200)
    expect(received[0]?.body.model).toBe('devin/swe-1-6')
    expect(fixture.devinResolve).not.toHaveBeenCalled()
  })

  it('falls back to the CPA native Devin provider when no Devin module account serves the model', async () => {
    const response = await post('ccm_auto', { model: 'devin/claude-opus-5-5', messages: [] })
    expect(response.status).toBe(200)
    expect(fixture.devinResolve).toHaveBeenCalledWith('devin/claude-opus-5-5', ['group-cpa', 'group-devin'])
    expect(received).toHaveLength(1)
    expect(fixture.devinHandle).not.toHaveBeenCalled()
  })

  it('hands the resolved Devin module selection to the module without resolving twice', async () => {
    fixture.devinResolve.mockResolvedValue(devinSelection)
    const response = await post('ccm_auto', { model: 'devin/claude-opus-5-5', messages: [] })
    expect(await response.text()).toBe('devin module')
    expect(received).toHaveLength(0)
    expect(fixture.devinHandle.mock.calls[0]![1]).toMatchObject({ keyId: 'auto', selection: devinSelection, protocolPath: 'chat/completions' })
  })

  it('reports the Devin module failure when CPA does not serve the model either', async () => {
    fixture.devinResolve.mockRejectedValue(Object.assign(new Error('Devin runtime model catalog returned HTTP 502'), { statusCode: 502 }))
    fixture.cpaRoute.mockResolvedValue(null)
    const response = await post('ccm_auto', { model: 'devin/claude-opus-5-5', messages: [] })
    expect(response.status).toBe(502)
    expect((await response.json()).error).toMatchObject({ type: 'server_error', code: 'upstream_error', message: expect.stringContaining('runtime model catalog returned HTTP 502') })
  })

  it('uses status-specific error codes instead of labelling everything a preset error', async () => {
    const missing = await post('ccm_unknown', { model: 'x' })
    expect(missing.status).toBe(401)
    expect((await missing.json()).error).toMatchObject({ type: 'authentication_error', code: 'invalid_api_key' })
    fixture.cpaRoute.mockResolvedValue(null)
    const notFound = await post('ccm_auto', { model: 'unknown-model' })
    expect(notFound.status).toBe(404)
    expect((await notFound.json()).error.code).toBe('model_not_found')
    const anthropic = await post('ccm_auto', { model: 'unknown-model', messages: [] }, 'messages')
    expect(await anthropic.json()).toMatchObject({ type: 'error', error: { type: 'not_found_error' } })
  })

  it('shows actionable platform messages for explicit 5xx failures', async () => {
    fixture.module.mockRejectedValue(Object.assign(new Error('此模块已停用，请在模块管理中启用'), { statusCode: 503 }))
    const response = await post('ccm_auto', { model: 'native-model' })
    expect(response.status).toBe(503)
    expect((await response.json()).error).toMatchObject({ code: 'service_unavailable', message: '此模块已停用，请在模块管理中启用' })
  })

  it('routes messages/count_tokens for ccm keys through the same group-scoped CPA sources', async () => {
    const response = await post('ccm_auto', { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }, 'messages/count_tokens')
    expect(response.status).toBe(200)
    expect(received[0]).toMatchObject({ path: '/v1/messages/count_tokens', body: { model: 'claude-sonnet-5' } })
    expect(received[0]!.headers.authorization).toBe('Bearer core-client-key')
    expect(received[0]!.headers['x-nexus-group-policy']).toBe('signed-policy')
    expect(fixture.presets).not.toHaveBeenCalled()
    expect(fixture.log).not.toHaveBeenCalled()
  })

  it('refuses token counting for module-only sources', async () => {
    fixture.devinResolve.mockResolvedValue(devinSelection)
    const devin = await post('ccm_auto', { model: 'devin/claude-opus-5-5', messages: [] }, 'messages/count_tokens')
    expect(devin.status).toBe(404)
    expect(fixture.devinHandle).not.toHaveBeenCalled()
    const legacy = await post('ccm_legacy', { model: 'cc', messages: [] }, 'messages/count_tokens')
    expect(legacy.status).toBe(404)
    expect(fixture.compat).not.toHaveBeenCalled()
  })
})

describe('resolveInferenceRoute', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fixture.enabled.mockResolvedValue(true)
    fixture.devinResolve.mockResolvedValue(null)
    fixture.provider.mockResolvedValue(null)
    fixture.candidates.mockResolvedValue([])
  })
  const route = (moduleId: 'auto' | 'cpa' | 'devin2api', model: string) => resolveInferenceRoute({ moduleId, model, keyId: 'key', groupIds: ['g'] })

  it('sends every request of a Devin-bound key to the module', async () => {
    expect(await route('devin2api', 'devin/x')).toEqual({ target: 'devin2api' })
  })
  it('keeps commandcode/ aliases off CPA-bound keys', async () => {
    expect(await route('auto', 'commandcode/x')).toEqual({ target: 'commandcode' })
    expect(await route('cpa', 'commandcode/x')).toMatchObject({ target: 'reject', status: 403 })
  })
  it('prefers the CommandCode pool for official provider models only when the key has candidates', async () => {
    fixture.provider.mockResolvedValue({ id: 'glm' })
    expect(await route('auto', 'glm')).toEqual({ target: 'cpa' })
    fixture.candidates.mockResolvedValue([{ id: 'account' }])
    expect(await route('auto', 'glm')).toEqual({ target: 'commandcode' })
    expect(await route('cpa', 'glm')).toEqual({ target: 'cpa' })
  })
  it('does not treat bare names that merely contain devin as Devin models', async () => {
    expect(await route('auto', 'devin-like-model')).toEqual({ target: 'cpa' })
    expect(fixture.devinResolve).not.toHaveBeenCalled()
  })
})

describe('modelErrorBody', () => {
  it('maps statuses for both protocol families', () => {
    expect(modelErrorBody('chat/completions', 403, 'no')).toEqual({ error: { type: 'permission_error', code: 'permission_denied', message: 'no' } })
    expect(modelErrorBody('responses', 503, 'down')).toEqual({ error: { type: 'server_error', code: 'service_unavailable', message: 'down' } })
    expect(modelErrorBody('messages', 503, 'down')).toEqual({ type: 'error', error: { type: 'overloaded_error', message: 'down' } })
    expect(modelErrorBody('messages/count_tokens', 401, 'key')).toEqual({ type: 'error', error: { type: 'authentication_error', message: 'key' } })
    expect(modelErrorBody('chat/completions', 422, 'bad preset', 'preset_route_error').error).toMatchObject({ code: 'preset_route_error' })
  })
})
