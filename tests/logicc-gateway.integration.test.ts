import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import Redis from 'ioredis'
import { createApp, defineEventHandler, readBody, toNodeListener } from 'h3'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LOGICC_SETTINGS, type LogiccSettings } from '../shared/logicc'

const redisUrl = process.env.TEST_REDIS_URL
const fixture = vi.hoisted(() => ({
  redis: undefined as unknown as Redis,
  settings: undefined as unknown as LogiccSettings,
  candidates: [] as { id: string; limit: number }[],
  touched: [] as string[], marked: [] as { id: string; status: string }[],
  traces: new Map<string, unknown>(),
  provider: 'anthropic',
}))
vi.mock('../server/lib/redis', () => ({ getRedis: () => fixture.redis }))
vi.mock('../server/lib/db', () => ({ getDb: () => async (strings: TemplateStringsArray) => {
  // The only direct query the gateway makes: the model's provider for tokenizer selection.
  if (strings.join('?').includes("m->>'provider'")) return [{ provider: fixture.provider }]
  throw new Error('No database in this test')
} }))
vi.mock('../server/lib/settings', () => ({ getSettings: async () => ({ upstreamTimeoutSeconds: 30 }) }))
vi.mock('../server/modules/logicc/settings', () => ({ getLogiccSettings: async () => structuredClone(fixture.settings), getLogiccSecrets: async () => ({ anthropicCountKey: null, geminiCountKey: null }) }))
vi.mock('../server/modules/logicc/credentials', () => ({ accountToken: async (id: string) => 'jwt-for-' + id }))
vi.mock('../server/modules/logicc/store', async importOriginal => ({
  ...await importOriginal<object>(),
  listCandidates: async () => fixture.candidates,
  touchAccount: async (id: string) => { fixture.touched.push(id) },
  markAccountStatus: async (id: string, status: string) => { fixture.marked.push({ id, status }) },
}))
vi.mock('../server/lib/bridge/trace', () => ({ writeBridgeTrace: async (id: string, trace: unknown) => { fixture.traces.set(id, trace) } }))
import { handleLogiccChat } from '../server/modules/logicc/gateway'
import { localTokens } from '../server/modules/logicc/tokens'
import { readCooldowns } from '../server/lib/pool/scheduler'

type Script = { status?: number; events?: unknown[] }
describe.skipIf(!redisUrl)('Logicc gateway against a fake Logicc web API', () => {
  let logicc: Server, app: Server, appUrl: string
  const received: { path: string; auth: string; body: any }[] = []
  const scripts = new Map<string, Script>()
  let prefix = ''
  beforeAll(async () => {
    logicc = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
      const auth = String(req.headers.authorization)
      received.push({ path: req.url!, auth, body })
      const account = auth.replace('Bearer jwt-for-', '')
      if (req.url === '/api/chats') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'chat-' + account })); return }
      const first = scripts.get('first-generation')
      if (first) scripts.delete('first-generation')
      const script = first ?? scripts.get(account) ?? { events: [{ type: 'text-delta', delta: 'Hello' }, { type: 'text-delta', delta: ' world' }, { type: 'finish', finishReason: 'stop' }] }
      if (script.status) { res.writeHead(script.status, { 'content-type': 'application/json' }); res.end('{"error":"upstream"}'); return }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of script.events!) res.write(`data: ${JSON.stringify(event)}\n\n`)
      res.end('data: [DONE]\n\n')
    })
    await new Promise<void>(resolve => logicc.listen(0, '127.0.0.1', resolve))
    vi.stubEnv('LOGICC_API_BASE', `http://127.0.0.1:${(logicc.address() as AddressInfo).port}/api`)
    const h3 = createApp().use(defineEventHandler(async event => {
      const body = await readBody(event)
      await handleLogiccChat(event, body, { keyId: randomUUID(), groupId: randomUUID(), requestId: String(event.node.req.headers['x-request-id']) })
    }))
    app = createServer(toNodeListener(h3))
    await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve))
    appUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}`
  })
  afterAll(async () => {
    for (const server of [app, logicc]) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() })
    vi.unstubAllEnvs()
  })
  beforeEach(async () => {
    prefix = 'ccm-test:' + randomUUID() + ':'
    fixture.redis = new Redis(redisUrl!, { keyPrefix: prefix, lazyConnect: true, maxRetriesPerRequest: 1 })
    await fixture.redis.connect()
    fixture.settings = structuredClone(DEFAULT_LOGICC_SETTINGS)
    fixture.settings.usage.autoCalibrate = false
    fixture.candidates = [{ id: 'acct-a', limit: 0 }, { id: 'acct-b', limit: 0 }]
    fixture.touched = []; fixture.marked = []; fixture.traces.clear(); fixture.provider = 'anthropic'
    received.length = 0; scripts.clear()
  })
  afterEach(async () => {
    const raw = new Redis(redisUrl!)
    const keys = await raw.keys(prefix + '*'); if (keys.length) await raw.del(...keys)
    raw.disconnect(); fixture.redis.disconnect()
  })
  const call = (body: Record<string, unknown>) => {
    const requestId = randomUUID()
    return fetch(appUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': requestId }, body: JSON.stringify(body) })
      .then(response => ({ response, requestId }))
  }

  it('streams OpenAI chunks and always reports usage that never under-counts the prompt sent to Logicc', async () => {
    const { response, requestId } = await call({ model: 'claude-sonnet', stream: true, messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Say hello' }] })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const text = await response.text()
    const frames = text.split('\n\n').filter(frame => frame.startsWith('data: ') && !frame.includes('[DONE]')).map(frame => JSON.parse(frame.slice(6)))
    expect(frames.map(frame => frame.choices?.[0]?.delta?.content).filter(Boolean).join('')).toBe('Hello world')
    expect(text.trim().endsWith('data: [DONE]')).toBe(true)
    const usage = frames.find(frame => frame.usage)!.usage
    const prompt = received.find(item => item.path.startsWith('/api/chats/'))!.body.prompt as string
    // Claude: local o200k count × 1.25, plus the fixed overhead for Logicc's hidden instructions.
    expect(usage.prompt_tokens).toBeGreaterThanOrEqual(Math.ceil(localTokens(prompt) * 1.25) + 256)
    expect(usage.completion_tokens).toBeGreaterThanOrEqual(Math.ceil(localTokens('Hello world') * 1.25))
    expect(usage.total_tokens).toBe(usage.prompt_tokens + usage.completion_tokens)
    // Only the three standard fields reach clients; how they were computed stays in the platform.
    expect(Object.keys(usage).sort()).toEqual(['completion_tokens', 'prompt_tokens', 'total_tokens'])
    expect(fixture.traces.get(requestId)).toMatchObject({ moduleId: 'logicc', usageSource: 'estimated', usageDetail: { family: 'claude', factors: { input: 1.25, output: 1.25 } } })
  })

  it('moves to another account when one fails before the first token, and cools the failed one', async () => {
    // Whichever account is tried first fails before producing any output.
    scripts.set('first-generation', { status: 500 })
    const { response, requestId } = await call({ model: 'claude-sonnet', messages: [{ role: 'user', content: 'hi' }] })
    expect(response.status).toBe(200)
    const json = await response.json()
    expect(json.choices[0].message.content).toBe('Hello world')
    const trace = fixture.traces.get(requestId) as { accountId: string; attempts: { accountId: string; status: number }[] }
    expect(trace.attempts).toHaveLength(1)
    const failed = trace.attempts[0]!.accountId
    expect(trace.attempts[0]!.status).toBe(500)
    expect(trace.accountId).not.toBe(failed)
    expect((await readCooldowns(fixture.redis, 'logicc', ['acct-a', 'acct-b'])).has(failed)).toBe(true)
    expect(fixture.touched).toEqual([trace.accountId])
  })

  it('marks an account whose credentials Logicc rejects and answers 503 so the router can fail over', async () => {
    scripts.set('acct-a', { status: 403 })
    fixture.candidates = [{ id: 'acct-a', limit: 0 }]
    const { response } = await call({ model: 'claude-sonnet', messages: [{ role: 'user', content: 'hi' }] })
    expect(response.status).toBe(503)
    expect(fixture.marked).toContainEqual({ id: 'acct-a', status: 'credential_expired' })
  })

  it('turns an emulated tool envelope into standard tool calls', async () => {
    scripts.set('acct-a', { events: [{ type: 'text-delta', delta: '{"content":null,"tool_calls":[{"name":"get_weather","arguments":{"city":"Paris"}}]}' }, { type: 'finish', finishReason: 'stop' }] })
    fixture.candidates = [{ id: 'acct-a', limit: 0 }]
    const tools = [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }]
    const { response } = await call({ model: 'gpt-5', messages: [{ role: 'user', content: 'Weather in Paris?' }], tools })
    const json = await response.json()
    expect(json.choices[0].finish_reason).toBe('tool_calls')
    expect(json.choices[0].message.tool_calls[0].function).toEqual({ name: 'get_weather', arguments: '{"city":"Paris"}' })
    expect(received.find(item => item.path.startsWith('/api/chats/'))!.body.prompt).toContain('Declared client tools')
  })

  it('counts built-in tool results Logicc feeds back to the model as input', async () => {
    const result = 'search result '.repeat(400)
    scripts.set('acct-a', { events: [{ type: 'tool-output-available', toolCallId: 't1', output: result }, { type: 'text-delta', delta: 'Done' }, { type: 'finish', finishReason: 'stop' }] })
    fixture.candidates = [{ id: 'acct-a', limit: 0 }]
    fixture.provider = 'openai'
    const { response } = await call({ model: 'gpt-5', messages: [{ role: 'user', content: 'search' }] })
    const usage = (await response.json()).usage
    expect(usage.prompt_tokens).toBeGreaterThan(localTokens(result))
  })

  it('declines what Logicc cannot serve so another source takes it', async () => {
    const image = await call({ model: 'gpt-5', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } }] }] })
    expect(image.response.status).toBe(422)
    expect((await image.response.json()).error.code).toBe('nexus_source_unsupported')
    fixture.settings.toolPolicy = 'reject'
    const tools = await call({ model: 'gpt-5', messages: [{ role: 'user', content: 'x' }], tools: [{ type: 'function', function: { name: 'f' } }] })
    expect(tools.response.status).toBe(422); await tools.response.arrayBuffer()
    expect(received).toHaveLength(0)
  })

  it('reports a busy pool when every account is at its concurrency limit', async () => {
    fixture.candidates = [{ id: 'acct-a', limit: 1 }]
    const { acquireLease } = await import('../server/lib/pool/scheduler')
    expect((await acquireLease(fixture.redis, 'logicc', { candidates: fixture.candidates })).ok).toBe(true)
    const { response } = await call({ model: 'gpt-5', messages: [{ role: 'user', content: 'x' }] })
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBeTruthy()
  })
})
