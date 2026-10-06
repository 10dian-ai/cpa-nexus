import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, defineEventHandler, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../server/lib/cpa/group-routing', () => ({ assertCpaGroupRoutingSafe: async () => {}, resolveCommandcodeBridgePolicy: async () => ({ allowedAuthIDs: ['internal-only-bridge'], allowedPluginIDs: [] }) }))
vi.mock('../server/lib/cpa/group-policy', () => ({ CPA_GROUP_POLICY_HEADER: 'x-nexus-group-policy', registerCpaGroupPolicy: async () => 'signed-internal-bridge-policy' }))

const fixture = vi.hoisted(() => ({ authenticate: vi.fn(), module: vi.fn(), direct: vi.fn(), upstream: vi.fn(), models: vi.fn(), maxBody: 1 }))
vi.mock('../server/lib/auth', () => ({ authenticateGatewayKey: fixture.authenticate }))
vi.mock('../server/lib/modules', () => ({ requireModule: fixture.module }))
vi.mock('../server/lib/config', () => ({ getConfig: () => ({ encryptionKey: Buffer.alloc(32, 9).toString('base64') }) }))
vi.mock('../server/lib/settings', () => ({ getSettings: async () => ({ maxRequestBodyMb: fixture.maxBody }) }))
vi.mock('../server/lib/gateway/handler', () => ({ handleGateway: fixture.direct }))
vi.mock('../server/lib/gateway/accounts', () => ({ listGatewayModels: fixture.models }))
import { handleCommandcodeCompatibility } from '../server/lib/commandcode-compat'
import { ORIGINAL_KEY_ID_HEADER, ORIGINAL_KEY_SIGNATURE_HEADER, signOriginalGatewayKey, verifyOriginalGatewayKey } from '../server/lib/commandcode-identity'

const actualFetch = globalThis.fetch
describe('legacy manager ingress via local CPA', () => {
  let server: Server
  let url: string
  beforeEach(async () => {
    vi.resetAllMocks()
    fixture.maxBody = 1
    fixture.models.mockResolvedValue({ object: 'list', data: [{ id: 'claude-test', supported_endpoints: ['/v1/messages'] }] })
    fixture.authenticate.mockResolvedValue({ id: 'original-key', name: 'legacy client' })
    fixture.module.mockResolvedValue(undefined)
    fixture.upstream.mockResolvedValue(new Response('{"choices":[{"message":{"content":"answer"}}]}', { headers: { 'content-type': 'application/json', 'x-request-id': 'inner-request' } }))
    vi.stubEnv('CPA_URL', 'http://fixture-cpa:8317')
    vi.stubEnv('CPA_CLIENT_KEY', 'local-cpa-client-key')
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => String(input).startsWith('http://fixture-cpa:8317') ? fixture.upstream(input, init) : actualFetch(input, init))
    const app = createApp()
    app.use(defineEventHandler(handleCommandcodeCompatibility))
    server = createServer(toNodeListener(app))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/commandcode/v1`
  })
  afterEach(async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    vi.restoreAllMocks(); vi.unstubAllEnvs()
  })
  const post = (url: string, body: Record<string, unknown> = { model: 'claude-test', messages: [{ role: 'user', content: 'hello' }] }, headers: Record<string, string> = {}) => actualFetch(url + '/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer ccm_original-client-key', 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  it('aliases the exact model once, isolates credentials and signs the authenticated original key ID', async () => {
    for (const model of ['claude-test', 'commandcode/claude-test']) {
      fixture.upstream.mockResolvedValueOnce(new Response('{}', { headers: { 'x-request-id': 'inner-request' } }))
      const response = await post(url, { model, messages: [{ role: 'user', content: '你好' }] }, {
        cookie: 'session=browser-secret', 'x-api-key': 'client-api-secret', 'x-session-id': 'session-a', 'x-cmd-zdr': '1',
        [ORIGINAL_KEY_ID_HEADER]: 'forged-key', [ORIGINAL_KEY_SIGNATURE_HEADER]: 'forged-signature',
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('x-request-id')).toBe('inner-request')
      await response.text()
      const [destination, options] = fixture.upstream.mock.calls.at(-1)!
      expect(destination).toBe('http://fixture-cpa:8317/v1/chat/completions')
      expect(JSON.parse(options.body)).toEqual({ model: 'commandcode/claude-test', messages: [{ role: 'user', content: '你好' }] })
      expect(options.headers.get('authorization')).toBe('Bearer local-cpa-client-key')
      expect(options.headers.get('x-api-key')).toBeNull()
      expect(options.headers.get('cookie')).toBeNull()
      expect(options.headers.get('x-cmd-zdr')).toBe('1')
      expect(options.headers.get('x-session-id')).toBe('session-a')
      expect(options.headers.get(ORIGINAL_KEY_ID_HEADER)).toBe('original-key')
      expect(options.headers.get(ORIGINAL_KEY_SIGNATURE_HEADER)).toBe(signOriginalGatewayKey('original-key'))
    }
  })
  it('retains raw model IDs and official endpoint metadata on the legacy models route', async () => {
    const response = await actualFetch(url + '/models', { headers: { authorization: 'Bearer ccm_original-client-key' } })
    expect(await response.json()).toEqual({ object: 'list', data: [{ id: 'claude-test', supported_endpoints: ['/v1/messages'] }] })
    expect(fixture.upstream).not.toHaveBeenCalled()
  })
  it('returns a structured 503 when the official catalog is temporarily unavailable', async () => {
    fixture.models.mockRejectedValueOnce(new Error('official catalog unavailable'))
    const response = await actualFetch(url + '/models', { headers: { authorization: 'Bearer ccm_original-client-key' } })
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: 'model_catalog_unavailable' } })
    expect(fixture.upstream).not.toHaveBeenCalled()
  })
  it('rejects a CPA-bound client key on every Command Code compatibility route', async () => {
    fixture.authenticate.mockResolvedValue({ id: 'cpa-key', name: 'CPA client', moduleId: 'cpa' })
    for (const path of ['models', 'chat/completions', 'messages', 'responses']) {
      const response = await actualFetch(url + '/' + path, {
        method: path === 'models' ? 'GET' : 'POST', headers: { authorization: 'Bearer ccm_cpa-client-key' },
        ...(path === 'models' ? {} : { body: '{"model":"claude-test"}' }),
      })
      expect(response.status).toBe(403); await response.text()
    }
    expect(fixture.upstream).not.toHaveBeenCalled()
  })
  it('preserves the applied preset header returned by the Command Code bridge', async () => {
    fixture.upstream.mockResolvedValueOnce(new Response('{}', { headers: { 'x-nexus-preset-id': 'KB-rule' } }))
    const response = await post(url)
    expect(response.headers.get('x-nexus-preset-id')).toBe('KB-rule'); await response.text()
  })
  it('rejects unauthenticated cookies and missing or malformed trusted CPA configuration before forwarding', async () => {
    const unauthorized = await actualFetch(url + '/chat/completions', {
      method: 'POST', headers: { cookie: 'ccm_session=browser-admin', 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-test' }),
    })
    expect(unauthorized.status).toBe(401); await unauthorized.text()
    expect(fixture.authenticate).not.toHaveBeenCalled()
    vi.stubEnv('CPA_CLIENT_KEY', '')
    const missing = await post(url)
    expect(missing.status).toBe(503); await missing.text()
    vi.stubEnv('CPA_CLIENT_KEY', 'local-cpa-client-key'); vi.stubEnv('CPA_URL', 'http://user:password@fixture-cpa:8317/path')
    const malformed = await post(url)
    expect(malformed.status).toBe(503); await malformed.text()
    expect(fixture.upstream).not.toHaveBeenCalled()
  })
  it('rejects malformed and oversized bodies with the original request limit', async () => {
    fixture.maxBody = 32 / (1024 * 1024)
    const oversized = await post(url, { model: 'claude-test', input: 'x'.repeat(64) })
    expect(oversized.status).toBe(413); await oversized.text()
    fixture.maxBody = 1
    const invalid = await post(url, { model: '' })
    expect(invalid.status).toBe(400); await invalid.text()
    expect(fixture.upstream).not.toHaveBeenCalled()
  })
  it('preserves UTF-8 SSE bytes without buffering and aborts CPA when the client disconnects', async () => {
    const wire = new TextEncoder().encode('data: {"text":"你好🌍"}\n\n')
    fixture.upstream.mockImplementationOnce(async (_url, init: RequestInit) => new Response(new ReadableStream({
      start(controller) { controller.enqueue(wire); init.signal!.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true }) },
    }), { headers: { 'content-type': 'text/event-stream' } }))
    const controller = new AbortController()
    const response = await actualFetch(url + '/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ccm_original-client-key' }, body: JSON.stringify({ model: 'claude-test', stream: true }), signal: controller.signal })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const chunk = await response.body!.getReader().read()
    expect(chunk.value).toEqual(wire)
    controller.abort()
    await vi.waitFor(() => expect(fixture.upstream.mock.calls[0]![1].signal.aborted).toBe(true))
  })
  it('delegates System One directly using an explicit protocol path instead of entering a CPA loop', async () => {
    fixture.direct.mockResolvedValue({ model: 'typesafe/jev', answers: {} })
    const response = await actualFetch(url + '/systemone', { method: 'POST', headers: { authorization: 'Bearer ccm_original-client-key' }, body: JSON.stringify({ model: 'typesafe/jev', state: 'hello', questions: {} }) })
    expect(await response.json()).toMatchObject({ model: 'typesafe/jev' })
    expect(fixture.direct).toHaveBeenCalledWith(expect.anything(), { protocolPath: 'systemone' })
    expect(fixture.upstream).not.toHaveBeenCalled()
  })
})

describe('signed original gateway identities', () => {
  it('binds an ID to the configured encryption key and rejects modified identities, signatures and duplicate headers', () => {
    const signature = signOriginalGatewayKey('original-key')
    expect(verifyOriginalGatewayKey({ [ORIGINAL_KEY_ID_HEADER]: 'original-key', [ORIGINAL_KEY_SIGNATURE_HEADER]: signature })).toBe('original-key')
    expect(verifyOriginalGatewayKey({ [ORIGINAL_KEY_ID_HEADER]: 'changed-key', [ORIGINAL_KEY_SIGNATURE_HEADER]: signature })).toBeNull()
    expect(verifyOriginalGatewayKey({ [ORIGINAL_KEY_ID_HEADER]: ['original-key'], [ORIGINAL_KEY_SIGNATURE_HEADER]: signature })).toBeNull()
    expect(verifyOriginalGatewayKey({ [ORIGINAL_KEY_ID_HEADER]: 'original-key', [ORIGINAL_KEY_SIGNATURE_HEADER]: signature.slice(1) })).toBeNull()
  })
})
