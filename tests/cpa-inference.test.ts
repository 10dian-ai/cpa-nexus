import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, defineEventHandler, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ enabled: false, route: vi.fn(), account: vi.fn(), compat: vi.fn(), limit: 1 }))
vi.mock('../server/lib/modules', () => ({ isModuleEnabled: async () => fixture.enabled }))
vi.mock('../server/lib/presets', () => ({ resolvePresetRoute: fixture.route }))
vi.mock('../server/lib/cpa/preset-routing', () => ({ findCpaPresetAccountForModel: fixture.account }))
vi.mock('../server/lib/settings', () => ({ getSettings: async () => ({ maxRequestBodyMb: fixture.limit }) }))
vi.mock('../server/lib/commandcode-compat', () => ({ handleCommandcodeCompatibility: fixture.compat }))
import { handleNexusInference, resetCpaInferenceAuthCache } from '../server/lib/cpa/inference'

const preset = (name = 'Default') => ({ id: name, sourceJson: { prompts: [{ identifier: 'main', role: 'system', content: name }, { identifier: 'chatHistory', marker: true }], prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }], temperature: 0.4 }, variables: {} })
describe('public CPA and original CCM inference routing', () => {
  let core: Server, app: Server, url: string
  let received: { path: string; headers: Record<string, unknown>; raw: string }[]
  let release: (() => void) | undefined, cancelled: boolean
  beforeEach(async () => {
    vi.resetAllMocks(); resetCpaInferenceAuthCache(); fixture.enabled = false; fixture.limit = 1
    fixture.route.mockResolvedValue(null); fixture.account.mockResolvedValue(null)
    fixture.compat.mockImplementation(event => { event.node.res.end('CCM') })
    received = []; cancelled = false
    core = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const raw = Buffer.concat(chunks).toString()
      received.push({ path: req.url!, headers: req.headers, raw })
      if (req.headers.authorization !== 'Bearer native-key') { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"invalid core key"}'); return }
      if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"object":"list","data":[]}'); return }
      if (raw.includes('"stream":true')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n')
        release = () => res.end('data: [DONE]\n\n')
        res.once('close', () => { cancelled = true }); return
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-cpa-version': 'v8.0.11' }); res.end(JSON.stringify({ raw, body: JSON.parse(raw || '{}') }))
    })
    await new Promise<void>(resolve => core.listen(0, '127.0.0.1', resolve))
    vi.stubEnv('CPA_URL', 'http://127.0.0.1:' + (core.address() as AddressInfo).port)
    const h3 = createApp(); h3.use(defineEventHandler(handleNexusInference)); app = createServer(toNodeListener(h3))
    await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve))
    url = 'http://127.0.0.1:' + (app.address() as AddressInfo).port + '/nexus/cpa/v1'
  })
  afterEach(async () => {
    release?.(); release = undefined
    for (const server of [app, core]) await new Promise<void>(resolve => { server.close(resolve); server.closeAllConnections() })
    vi.unstubAllEnvs(); resetCpaInferenceAuthCache()
  })
  const post = (body: Record<string, unknown>, key = 'native-key', protocol = 'chat/completions') => fetch(url + '/' + protocol, { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', 'anthropic-beta': 'tools-fixture' }, body: JSON.stringify(body) })

  it('keeps native body bytes, protocol headers and core authentication untouched when disabled', async () => {
    const raw = '{ "model": "fixture", "messages": [{"role":"user","content":"hello"}], "tools": [] }'
    const response = await fetch(url + '/chat/completions?test=1', { method: 'POST', headers: { authorization: 'Bearer native-key', 'content-type': 'application/json', 'anthropic-beta': 'fixture' }, body: raw })
    expect(response.status).toBe(200); expect(response.headers.get('x-cpa-version')).toBe('v8.0.11')
    expect((await response.json()).raw).toBe(raw)
    expect(received[0]).toMatchObject({ path: '/v1/chat/completions?test=1', headers: { authorization: 'Bearer native-key', 'anthropic-beta': 'fixture' } })
    expect(fixture.route).not.toHaveBeenCalled(); expect(fixture.account).not.toHaveBeenCalled()
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

  it('applies the selected account preset once and preserves client controls and original model prefix', async () => {
    fixture.enabled = true; fixture.account.mockResolvedValue('config:stable-account'); fixture.route.mockResolvedValue(preset('Account rule'))
    const tools = [{ type: 'function', function: { name: 'lookup' } }]
    const response = await post({ model: 'nexus-prefix/fixture', messages: [{ role: 'user', content: 'hello' }], temperature: 0.9, tools })
    expect(response.status).toBe(200); expect(response.headers.get('x-nexus-preset-id')).toBe('Account rule')
    const { body } = await response.json()
    expect(body).toMatchObject({ model: 'nexus-prefix/fixture', temperature: 0.9, tools, messages: [{ role: 'system', content: 'Account rule' }, { role: 'user', content: 'hello' }] })
    expect(fixture.route).toHaveBeenCalledWith('cpa', 'config:stable-account')
    expect(received.filter(request => request.path === '/v1/chat/completions')).toHaveLength(1)
  })

  it('respects explicit account bypass and leaves CommandCode models for their own selected-account step', async () => {
    fixture.enabled = true; fixture.account.mockResolvedValue('account-bypass'); fixture.route.mockResolvedValue(null)
    const body = { model: 'prefix/fixture', messages: [{ role: 'user', content: 'hello' }] }
    expect((await (await post(body)).json()).body).toEqual(body)
    fixture.route.mockResolvedValue(preset())
    const commandcode = { ...body, model: 'commandcode/fixture' }
    expect((await (await post(commandcode)).json()).body).toEqual(commandcode)
    expect(fixture.route).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid credentials before reading or transforming a preset request', async () => {
    fixture.enabled = true; fixture.route.mockResolvedValue(preset())
    const response = await post({ model: 'fixture', messages: [] }, 'invalid')
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'invalid core key' })
    expect(fixture.route).not.toHaveBeenCalled(); expect(fixture.account).not.toHaveBeenCalled()
    expect(received).toHaveLength(1); expect(received[0]!.path).toBe('/v1/models')
  })

  it('keeps Responses input, instructions and tools while adding a preset', async () => {
    fixture.enabled = true; fixture.route.mockResolvedValue(preset())
    const response = await post({ model: 'fixture', input: 'hello', instructions: 'Client instruction', tools: [{ type: 'web_search' }] }, 'native-key', 'responses')
    expect(response.status).toBe(200)
    const { body } = await response.json()
    expect(body.tools).toEqual([{ type: 'web_search' }]); expect(body.model).toBe('fixture')
    expect(JSON.stringify(body)).toContain('Default'); expect(JSON.stringify(body)).toContain('Client instruction'); expect(JSON.stringify(body)).toContain('hello')
  })

  it('returns bounded JSON errors for invalid preset input without invoking inference', async () => {
    fixture.enabled = true
    const response = await fetch(url + '/messages', { method: 'POST', headers: { authorization: 'Bearer native-key', 'content-type': 'application/json' }, body: '{' })
    expect(response.status).toBe(400); expect((await response.json()).type).toBe('error')
    expect(received.map(request => request.path)).toEqual(['/v1/models'])
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
