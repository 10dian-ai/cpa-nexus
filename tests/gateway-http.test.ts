import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, defineEventHandler, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  authenticate: vi.fn(), acquire: vi.fn(), release: vi.fn(), recordFailure: vi.fn(), recordAllowed: vi.fn(),
  log: vi.fn(), refresh: vi.fn(), upstream: vi.fn(), candidates: vi.fn(), providerModel: vi.fn(),
  maxRequestBodyMb: 1,
  preset: vi.fn(),
  originalKey: vi.fn(),
}))
vi.mock('../server/lib/auth', () => ({
  authenticateGatewayKey: fixture.authenticate,
  findEnabledModelKey: fixture.originalKey,
  requireModelKeyModule: async (key: { moduleId?: string }, moduleId: string) => {
    if ((key.moduleId || 'commandcode') !== moduleId) throw Object.assign(new Error('Key is bound to another module'), { statusCode: 403 })
  },
}))
vi.mock('../server/lib/config', () => ({ getConfig: () => ({ commandcodeApiUrl: 'http://fixture-provider/provider/v1', encryptionKey: Buffer.alloc(32, 9).toString('base64') }) }))
vi.mock('../server/lib/official-catalog', () => ({ getProviderModel: fixture.providerModel }))
vi.mock('../server/lib/crypto', () => ({ decryptSecret: () => 'fixture-upstream-key' }))
vi.mock('../server/lib/redis', () => ({ getRedis: () => ({}) }))
vi.mock('../server/lib/settings', () => ({ getSettings: async () => ({
  maxRequestBodyMb: fixture.maxRequestBodyMb, globalConcurrency: 10, affinityTtlSeconds: 60,
}) }))
vi.mock('../server/lib/queues', () => ({ enqueueAccountRefresh: fixture.refresh }))
vi.mock('../server/lib/logs', () => ({ insertRequestLog: fixture.log }))
vi.mock('../server/lib/events', () => ({ publishUpdate: async () => {} }))
vi.mock('../server/lib/presets', () => ({ resolveKeyPresetRoute: fixture.preset }))
vi.mock('../server/lib/gateway/accounts', () => ({
  listCandidates: fixture.candidates, listGatewayModels: async () => ({ object: 'list', data: [] }),
  touchAccount: async () => {}, recordFailure: fixture.recordFailure, recordModelAllowed: fixture.recordAllowed,
}))
vi.mock('../server/lib/gateway/scheduler', () => ({
  acquireLease: fixture.acquire, releaseLease: fixture.release, renewLease: async () => true, RENEW_INTERVAL_MS: 15_000,
}))
import { handleGateway } from '../server/lib/gateway/handler'
import { ORIGINAL_KEY_ID_HEADER, ORIGINAL_KEY_SIGNATURE_HEADER, signOriginalGatewayKey } from '../server/lib/commandcode-identity'
import { extractAffinity } from '../server/lib/gateway/affinity'

const actualFetch = globalThis.fetch
const answer = () => new Response(JSON.stringify({ choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }] }), {
  status: 200, headers: { 'content-type': 'application/json' },
})
describe('gateway over real HTTP connections', () => {
  let server: Server
  let url: string
  beforeEach(async () => {
    vi.resetAllMocks()
    fixture.maxRequestBodyMb = 1
    fixture.preset.mockResolvedValue(null)
    fixture.authenticate.mockResolvedValue({ id: 'gateway-key' })
    fixture.originalKey.mockImplementation(async id => ({ id, name: 'Original key', moduleId: 'commandcode' }))
    fixture.providerModel.mockResolvedValue({ id: 'fixture/model', supportedEndpoints: ['chat/completions', 'messages', 'responses'] })
    fixture.release.mockResolvedValue(undefined)
    fixture.refresh.mockResolvedValue(undefined)
    fixture.recordFailure.mockResolvedValue(undefined)
    fixture.recordAllowed.mockResolvedValue(undefined)
    fixture.log.mockResolvedValue(undefined)
    fixture.candidates.mockResolvedValue([
      { id: 'account-a', limit: 1, apiKeyCiphertext: 'cipher-a' },
      { id: 'account-b', limit: 1, apiKeyCiphertext: 'cipher-b' },
    ])
    fixture.acquire.mockImplementation(async (_redis, input) => ({
      ok: true, lease: { accountId: input.candidates[0].id, token: 'fixture-lease', expiresAt: Date.now() + 60_000 },
    }))
    fixture.upstream.mockImplementation(async () => answer())
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => String(input).startsWith('http://fixture-provider')
      ? fixture.upstream(input, init) : actualFetch(input, init))
    const app = createApp()
    app.use(defineEventHandler(handleGateway))
    server = createServer(toNodeListener(app))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    vi.restoreAllMocks()
  })
  const post = (url: string, stream = false) => actualFetch(url + '/v1/chat/completions', {
    method: 'POST', headers: { authorization: 'Bearer fixture-gateway-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fixture/model', stream, messages: [{ role: 'user', content: 'hello' }] }),
  })
  it('returns 413 for oversized chunked bodies without resetting the connection', async () => {
    fixture.maxRequestBodyMb = 32 / (1024 * 1024)
    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest(url + '/v1/chat/completions', {
        method: 'POST', headers: { authorization: 'Bearer fixture-gateway-key', 'content-type': 'application/json' },
      }, response => {
        let body = ''
        response.on('data', chunk => { body += chunk })
        response.on('end', () => resolve({ status: response.statusCode!, body }))
        response.on('error', reject)
      })
      request.on('error', reject)
      request.write('{"model":"fixture/model","input":"')
      request.write('a'.repeat(128))
      request.end('"}')
    })
    expect(response.status).toBe(413)
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'invalid_request_error' } })
    expect(fixture.upstream).not.toHaveBeenCalled()
    expect(fixture.acquire).not.toHaveBeenCalled()
  })
  it('uses the selected account API key on the official Provider route without browser cookies or client keys', async () => {
    const requestBody = { model: 'fixture/model', messages: [{ role: 'user', content: 'hello' }], tools: [{ type: 'function', function: { name: 'example' } }] }
    const response = await actualFetch(url + '/v1/chat/completions', {
      method: 'POST', headers: {
        authorization: 'Bearer fixture-gateway-key', 'x-api-key': 'another-client-key', cookie: 'session=browser-cookie',
        'content-type': 'application/json', 'x-cmd-zdr': '1', 'x-session-id': 'conversation-a',
      }, body: JSON.stringify(requestBody),
    })
    expect(response.status).toBe(200)
    await response.text()
    const [destination, options] = fixture.upstream.mock.calls[0]!
    expect(destination).toBe('http://fixture-provider/provider/v1/chat/completions')
    expect(JSON.parse(options.body)).toEqual(requestBody)
    expect(options.headers.get('authorization')).toBe('Bearer fixture-upstream-key')
    expect(options.headers.get('cookie')).toBeNull()
    expect(options.headers.get('x-api-key')).toBeNull()
    expect(options.headers.get('x-cmd-zdr')).toBe('1')
    expect(options.headers.get('x-session-id')).toBe('conversation-a')
  })
  it('attributes signed legacy callers to their original key for logs and affinity only through an authenticated bridge key', async () => {
    const originalId = 'original-client-key'
    const session = 'legacy-session'
    const signedHeaders = {
      [ORIGINAL_KEY_ID_HEADER]: originalId, [ORIGINAL_KEY_SIGNATURE_HEADER]: signOriginalGatewayKey(originalId),
      'x-session-id': session, 'content-type': 'application/json',
    }
    const invoke = async (authorization: string, headers = signedHeaders) => {
      const response = await actualFetch(url + '/v1/chat/completions', {
        method: 'POST', headers: { ...headers, authorization }, body: JSON.stringify({ model: 'fixture/model', messages: [{ role: 'user', content: 'hello' }] }),
      })
      expect(response.status).toBe(200)
      await response.text()
    }
    await invoke('Bearer ccm_nexus_test-bridge-key')
    await vi.waitFor(() => expect(fixture.log).toHaveBeenLastCalledWith(expect.objectContaining({ keyId: originalId })))
    expect(fixture.acquire.mock.calls[0]![1].affinityHash).toBe(extractAffinity({ keyId: originalId, body: {}, headers: { 'x-session-id': session } }).affinityHash)
    const upstreamHeaders = fixture.upstream.mock.calls[0]![1].headers as Headers
    expect(upstreamHeaders.get(ORIGINAL_KEY_ID_HEADER)).toBeNull()
    expect(upstreamHeaders.get(ORIGINAL_KEY_SIGNATURE_HEADER)).toBeNull()
    expect(fixture.preset).toHaveBeenLastCalledWith(originalId)
    await invoke('Bearer original-manager-client-key')
    await vi.waitFor(() => expect(fixture.log).toHaveBeenLastCalledWith(expect.objectContaining({ keyId: 'gateway-key' })))
    expect(fixture.preset).toHaveBeenLastCalledWith('gateway-key')
    fixture.preset.mockClear()
    await invoke('Bearer ccm_nexus_test-bridge-key', { ...signedHeaders, [ORIGINAL_KEY_SIGNATURE_HEADER]: 'A'.repeat(43) })
    await vi.waitFor(() => expect(fixture.log).toHaveBeenLastCalledWith(expect.objectContaining({ keyId: 'gateway-key' })))
    expect(fixture.preset).not.toHaveBeenCalled()
  })
  it('uses the same selected account with KA direct and KB applying its own preset', async () => {
    fixture.authenticate.mockImplementation(async secret => ({ id: secret === 'ccm_kb' ? 'KB' : 'KA', moduleId: 'commandcode' }))
    fixture.preset.mockImplementation(async keyId => keyId === 'KB' ? {
      id: 'KB-preset', variables: {}, sourceJson: { main_prompt: 'Only KB' },
    } : null)
    for (const secret of ['ccm_ka', 'ccm_kb']) {
      const response = await actualFetch(url + '/v1/chat/completions', {
        method: 'POST', headers: { authorization: 'Bearer ' + secret, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'fixture/model', messages: [{ role: 'user', content: 'hello' }] }),
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('x-nexus-preset-id')).toBe(secret === 'ccm_kb' ? 'KB-preset' : null)
      await response.text()
    }
    const first = JSON.parse(fixture.upstream.mock.calls[0]![1].body)
    const second = JSON.parse(fixture.upstream.mock.calls[1]![1].body)
    expect(first.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(second.messages).toEqual([{ role: 'system', content: 'Only KB' }, { role: 'user', content: 'hello' }])
    expect(fixture.preset.mock.calls).toEqual([['KA'], ['KB']])
  })
  it('rejects a key bound to CPA and disabled or rebound signed original keys before model execution', async () => {
    fixture.authenticate.mockResolvedValueOnce({ id: 'cpa-key', moduleId: 'cpa' })
    const denied = await post(url)
    expect(denied.status).toBe(403); await denied.text()
    const originalId = 'original-client-key'
    for (const original of [null, { id: originalId, moduleId: 'cpa' }]) {
      fixture.originalKey.mockResolvedValueOnce(original)
      const response = await actualFetch(url + '/v1/chat/completions', {
        method: 'POST', headers: { authorization: 'Bearer ccm_nexus_test-bridge-key', 'content-type': 'application/json',
          [ORIGINAL_KEY_ID_HEADER]: originalId, [ORIGINAL_KEY_SIGNATURE_HEADER]: signOriginalGatewayKey(originalId) },
        body: JSON.stringify({ model: 'fixture/model', messages: [] }),
      })
      expect(response.status).toBe(403); await response.text()
    }
    expect(fixture.preset).not.toHaveBeenCalled()
    expect(fixture.acquire).not.toHaveBeenCalled()
    expect(fixture.upstream).not.toHaveBeenCalled()
  })
  it('rejects an unsupported protocol with exact official endpoint guidance before leasing an account', async () => {
    fixture.providerModel.mockResolvedValueOnce({ id: 'fixture/model', supportedEndpoints: ['messages'] })
    const response = await post(url)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request_error', model: 'fixture/model', supported_endpoints: ['/v1/messages'] } })
    expect(fixture.acquire).not.toHaveBeenCalled()
    expect(fixture.upstream).not.toHaveBeenCalled()
  })
  it('fails closed when the catalog is unavailable and rejects models not in a loaded official catalog', async () => {
    fixture.providerModel.mockRejectedValueOnce(new Error('No official catalog snapshot'))
    const unavailable = await post(url)
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toMatchObject({ error: { code: 'model_catalog_unavailable' } })
    fixture.providerModel.mockResolvedValueOnce(null)
    const unknown = await post(url)
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).toMatchObject({ error: { code: 'unsupported_model' } })
    fixture.providerModel.mockResolvedValueOnce({ id: 'fixture/model', supportedEndpoints: [] })
    const noEndpoints = await post(url)
    expect(noEndpoints.status).toBe(503)
    await noEndpoints.text()
    expect(fixture.acquire).not.toHaveBeenCalled()
    expect(fixture.upstream).not.toHaveBeenCalled()
  })
  it('preserves native Messages and Responses requests on their advertised endpoints', async () => {
    for (const protocol of ['messages', 'responses']) {
      const body = protocol === 'messages' ? { model: 'fixture/model', max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }
        : { model: 'fixture/model', input: 'hello', tools: [{ type: 'custom', name: 'example' }] }
      const nativeAnswer = protocol === 'messages' ? { type: 'message', content: [{ type: 'text', text: 'native answer' }], stop_reason: 'end_turn' }
        : { object: 'response', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'native answer' }] }] }
      fixture.upstream.mockResolvedValueOnce(new Response(JSON.stringify(nativeAnswer), { headers: { 'content-type': 'application/json' } }))
      const response = await actualFetch(url + '/v1/' + protocol, {
        method: 'POST', headers: { authorization: 'Bearer fixture-gateway-key', 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(nativeAnswer)
      const [destination, options] = fixture.upstream.mock.calls.at(-1)!
      expect(destination).toBe('http://fixture-provider/provider/v1/' + protocol)
      expect(JSON.parse(options.body)).toEqual(body)
    }
  })
  it('serves typed System One decisions and refuses streaming before acquiring a lease', async () => {
    fixture.providerModel.mockResolvedValue({ id: 'typesafe/jev', supportedEndpoints: ['systemone'] })
    const body = { model: 'typesafe/jev', state: 'A request', questions: { urgent: { type: 'noul', instructions: 'Is it urgent?' } } }
    const decisions = { model: 'typesafe/jev', answers: { urgent: { type: 'noul', noul: 0.96 } }, usage: { input_tokens: 8, output_tokens: 1 } }
    fixture.upstream.mockResolvedValueOnce(new Response(JSON.stringify(decisions), { headers: { 'content-type': 'application/json' } }))
    const response = await actualFetch(url + '/v1/systemone', {
      method: 'POST', headers: { authorization: 'Bearer fixture-gateway-key', 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(decisions)
    await vi.waitFor(() => expect(fixture.log).toHaveBeenCalledWith(expect.objectContaining({ status: 'success', protocol: 'systemone', usage: decisions.usage })))
    expect(fixture.upstream.mock.calls[0]![0]).toBe('http://fixture-provider/provider/v1/systemone')
    const streamed = await actualFetch(url + '/v1/systemone', {
      method: 'POST', headers: { authorization: 'Bearer fixture-gateway-key', 'content-type': 'application/json' }, body: JSON.stringify({ ...body, stream: true }),
    })
    expect(streamed.status).toBe(400)
    expect(await streamed.json()).toMatchObject({ error: { code: 'invalid_request_error' } })
    expect(fixture.acquire).toHaveBeenCalledTimes(1)
    expect(fixture.upstream).toHaveBeenCalledTimes(1)
  })
  it('retries a model rejection on another account while applying the same client key preset once', async () => {
    fixture.preset.mockImplementation(async keyId => ({
      id: keyId, variables: {}, sourceJson: {
        prompts: [{ identifier: 'main', role: 'system', content: 'Key ' + keyId }, { identifier: 'chatHistory', marker: true }],
        prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
      },
    }))
    fixture.upstream.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'MODEL_NOT_IN_PLAN' } }), { status: 401 }))
    const response = await post(url)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ choices: [{ message: { content: 'answer' } }] })
    await vi.waitFor(() => expect(fixture.log).toHaveBeenCalled())
    expect(fixture.upstream).toHaveBeenCalledTimes(2)
    expect(fixture.release).toHaveBeenCalledTimes(2)
    expect(fixture.recordFailure).toHaveBeenCalledWith('account-a', 'fixture/model', expect.objectContaining({ category: 'model_denied' }))
    expect(fixture.log).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'account-b', status: 'success' }))
    const first = JSON.parse(fixture.upstream.mock.calls[0]![1].body)
    const second = JSON.parse(fixture.upstream.mock.calls[1]![1].body)
    expect(first.messages).toEqual([{ role: 'system', content: 'Key gateway-key' }, { role: 'user', content: 'hello' }])
    expect(second.messages).toEqual(first.messages)
    expect(fixture.preset.mock.calls).toEqual([['gateway-key'], ['gateway-key']])
    expect(fixture.log).toHaveBeenCalledWith(expect.objectContaining({ requestBody: second }))
  })
  it('never replays an ambiguous failure or a streaming request', async () => {
    for (const stream of [false, true]) {
      fixture.upstream.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: stream ? 'MODEL_NOT_IN_PLAN' : 'upstream_error' } }), { status: 502 }))
      const response = await post(url, stream)
      expect(response.status).toBe(502)
      await response.text()
    }
    await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledTimes(2))
    expect(fixture.upstream).toHaveBeenCalledTimes(2)
  })
  it('logs a stream without a completion event as incomplete while preserving its bytes', async () => {
    const wire = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
    fixture.upstream.mockResolvedValueOnce(new Response(wire, { headers: { 'content-type': 'text/event-stream' } }))
    const response = await post(url, true)
    expect(await response.text()).toBe(wire)
    await vi.waitFor(() => expect(fixture.log).toHaveBeenCalledWith(expect.objectContaining({ status: 'incomplete' })))
    expect(fixture.release).toHaveBeenCalledTimes(1)
  })
  it('aborts the upstream and releases the lease when the downstream disconnects during generation', async () => {
    let upstreamSignal: AbortSignal | undefined
    let signalReady!: () => void
    const ready = new Promise<void>(resolve => { signalReady = resolve })
    fixture.upstream.mockImplementationOnce(async (_url, init: RequestInit) => {
      upstreamSignal = init.signal as AbortSignal
      signalReady()
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'))
          upstreamSignal!.addEventListener('abort', () => controller.error(upstreamSignal!.reason), { once: true })
        },
      }), { headers: { 'content-type': 'text/event-stream' } })
    })
    const controller = new AbortController()
    const response = await actualFetch(url + '/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer fixture-gateway-key' },
      body: JSON.stringify({ model: 'fixture/model', stream: true }), signal: controller.signal,
    })
    await ready
    const reader = response.body!.getReader()
    await reader.read()
    controller.abort()
    await vi.waitFor(() => {
      expect(upstreamSignal?.aborted).toBe(true)
      expect(fixture.release).toHaveBeenCalledTimes(1)
      expect(fixture.log).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }))
    })
  })
  it('pauses the upstream idle timer while waiting for downstream backpressure', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    let responseSocket: import('node:http').ServerResponse | undefined
    let writeReady!: () => void
    const blocked = new Promise<void>(resolve => { writeReady = resolve })
    server.prependOnceListener('request', (_request, response) => {
      responseSocket = response
      const originalWrite = response.write.bind(response)
      let firstWrite = true
      response.write = ((...args: any[]) => {
        const written = (originalWrite as (...args: any[]) => boolean)(...args)
        if (!firstWrite) return written
        firstWrite = false
        writeReady()
        return false
      }) as typeof response.write
    })
    fixture.upstream.mockResolvedValueOnce(new Response('data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    }))
    const pending = post(url, true)
    await blocked
    const timers = timeoutSpy.mock.calls.flatMap((call, index) => call[1] === 120_000 ? [timeoutSpy.mock.results[index]!.value] : [])
    expect(timers.length).toBeGreaterThan(0)
    for (const timer of timers) expect(clearSpy).toHaveBeenCalledWith(timer)
    responseSocket!.emit('drain')
    expect(await (await pending).text()).toContain('answer')
    await vi.waitFor(() => expect(fixture.log).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' })))
  })
})
