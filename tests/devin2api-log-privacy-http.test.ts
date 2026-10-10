import { createServer, type Server } from 'node:http'
import { gzipSync } from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { createApp, defineEventHandler, getHeader, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ lease: vi.fn(), release: vi.fn() }))
vi.mock('../server/lib/devin2api/runtime', () => ({ acquireDevin2ApiRuntimeLease: fixture.lease }))
vi.mock('../server/lib/devin2api/routing', () => ({ resolveDevin2ApiModel: async () => null, listDevin2ApiGroupModels: async () => [] }))
vi.mock('../server/lib/devin2api/catalog', () => ({ stripDevin2ApiModel: (model: string) => model.replace(/^devin\//, '') }))
import { forwardDevin2Api } from '../server/lib/devin2api/forward'
import { forwardNativeCpa } from '../server/lib/cpa/inference'
import { BillingUsageObserver } from '../server/lib/billing'

const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }
const message = 'Devin Anthropic Codeium Windsurf GOAT HTTPS://upstream.example rejected'

describe('native CPA and embedded module diagnostic streams preserve real billing and leases', () => {
  let upstream: Server, platform: Server, base: string
  let received: Array<{ model: string; headers: import('node:http').IncomingHttpHeaders }>
  let observed: Array<Record<string, unknown> | null>
  beforeEach(async () => {
    vi.resetAllMocks(); received = []; observed = []
    upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      received.push({ model: JSON.parse(Buffer.concat(chunks).toString()).model, headers: req.headers })
      const mode = String(req.headers['x-test-mode'])
      if (mode === 'sse') {
        res.setHeader('content-type', 'text/event-stream')
        res.write('data: {"choices":[{"delta":{"content":"Gemini https://answer.example 中文😀"}}]}\n\n')
        const tail = Buffer.from('event: error\r\ndata: ' + JSON.stringify({ error: { message }, usage }) + '\r\n\r\ndata: [DONE]\n\n')
        for (let offset = 0; offset < tail.length; offset += 7) res.write(tail.subarray(offset, offset + 7))
        res.end(); return
      }
      const body = JSON.stringify(mode === 'normal'
        ? { model: 'gemini-pro', choices: [{ message: { content: 'Anthropic https://answer.example' }, finish_reason: 'stop' }], usage }
        : { error: { type: 'authentication_error', message }, model: 'gemini-pro', usage })
      res.statusCode = mode === 'http200' || mode === 'normal' ? 200 : 401
      res.setHeader('content-type', 'application/json')
      if (mode === 'gzip') {
        const compressed = gzipSync(body)
        res.setHeader('content-encoding', 'gzip'); res.setHeader('content-length', compressed.length)
        res.end(compressed)
      } else { res.setHeader('content-length', Buffer.byteLength(body)); res.end(body) }
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    const upstreamUrl = 'http://127.0.0.1:' + (upstream.address() as AddressInfo).port
    vi.stubEnv('CPA_URL', upstreamUrl)
    fixture.lease.mockResolvedValue({ baseUrl: upstreamUrl, apiKey: 'test-only-runtime-key', release: fixture.release })
    const app = createApp().use(defineEventHandler(async event => {
      const observer = new BillingUsageObserver()
      const body = { model: 'devin/glm-5', messages: [{ role: 'user', content: 'Actual Gemini request' }], stream: getHeader(event, 'x-test-mode') === 'sse' }
      if (event.path.startsWith('/native/')) await forwardNativeCpa(event, '/v1/chat/completions', body, undefined, undefined, observer)
      else await forwardDevin2Api(event, '/v1/chat/completions', { body, usageObserver: observer, selection: { model: 'glm-5', matchedGroupId: 'group-a', account: { id: 'source-account-a', baseUrl: null, model: 'glm-5', proxy: null, maxConcurrency: 2 } } as any })
      observed.push(observer.value())
    }))
    platform = createServer(toNodeListener(app))
    await new Promise<void>(resolve => platform.listen(0, '127.0.0.1', resolve))
    base = 'http://127.0.0.1:' + (platform.address() as AddressInfo).port
  })
  afterEach(async () => {
    for (const server of [platform, upstream]) if (server) await new Promise<void>(resolve => { server.close(resolve); server.closeAllConnections() })
    vi.unstubAllEnvs()
  })

  it.each(['module', 'native'])('filters %s JSON, HTTP-200 and gzip errors while retaining upstream models/usage', async route => {
    for (const mode of ['error', 'http200', 'gzip']) {
      const response = await fetch(base + '/' + route + '/', { method: 'POST', headers: { 'x-test-mode': mode }, body: '{}' })
      expect(response.status).toBe(mode === 'http200' ? 200 : 401)
      expect(await response.json()).toEqual({ error: { type: 'authentication_error', message: '*** *** *** *** *** *** rejected' }, model: '***-pro', usage })
      expect(response.headers.get('content-length')).toBeNull()
      expect(response.headers.get('content-encoding')).toBeNull()
      expect(received.at(-1)!.model).toBe(route === 'native' ? 'devin/glm-5' : 'glm-5')
      expect(received.at(-1)!.headers['accept-encoding']).toBe('identity')
      await vi.waitFor(() => expect(observed.at(-1)).toEqual(usage))
    }
    expect(fixture.release).toHaveBeenCalledTimes(route === 'module' ? 3 : 0)
  })

  it.each(['module', 'native'])('retains %s successful output and raw SSE billing while hiding only error events', async route => {
    const answer = await fetch(base + '/' + route + '/', { method: 'POST', headers: { 'x-test-mode': 'normal' }, body: '{}' }).then(response => response.json())
    expect(answer.model).toBe('gemini-pro')
    expect(answer.choices[0].message.content).toBe('Anthropic https://answer.example')
    const streamed = await fetch(base + '/' + route + '/', { method: 'POST', headers: { 'x-test-mode': 'sse' }, body: '{}' }).then(response => response.text())
    expect(streamed.startsWith('data: {"choices":[{"delta":{"content":"Gemini https://answer.example 中文😀"}}]}\n\n')).toBe(true)
    expect(streamed).toContain('"message":"*** *** *** *** *** *** rejected"')
    expect(streamed).not.toMatch(/upstream\.example|Devin|Codeium|Windsurf|GOAT/)
    expect(streamed.endsWith('data: [DONE]\n\n')).toBe(true)
    await vi.waitFor(() => expect(observed).toEqual([usage, usage]))
    expect(fixture.release).toHaveBeenCalledTimes(route === 'module' ? 2 : 0)
  })
})
