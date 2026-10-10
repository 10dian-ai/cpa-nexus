import { createServer, type Server } from 'node:http'
import { gzipSync } from 'node:zlib'
import type { AddressInfo } from 'node:net'
import { createApp, createError, createRouter, defineEventHandler, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../server/lib/redis', () => ({ getRedis: () => ({ get: async () => 'admin' }) }))
vi.mock('../server/lib/cpa/privacy-hooks', () => ({ applyCpaPrivacyAfterResponse: async () => {} }))
import { forwardNativeCpa } from '../server/lib/cpa/inference'
import managementHandler from '../server/api/cpa/management/[...path]'
import consoleHandler from '../server/api/cpa/console/[...path]'
import adminMiddleware from '../server/middleware/admin'
import diagnosticErrorHandler from '../server/error-handler'

const error = { error: { type: 'authentication_error', message: 'Provider authentication failed. Anthropic HTTPS://upstream.example/private' }, model: 'gemini-pro' }
const normal = '{ "model":"gemini-pro", "choices":[{"message":{"content":"ChatGPT https://answer.example"}}] }'
const errorFilename = 'error-gemini-generateContent.log'

describe('diagnostic privacy over real local HTTP', () => {
  let upstream: Server, platform: Server, url: string
  let paths: string[]
  beforeEach(async () => {
    paths = []
    upstream = createServer((req, res) => {
      paths.push(req.url!)
      if (/\/management\/(?:observability\/logs\/errors|request-error-logs)$/.test(req.url!)) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ files: [{ name: errorFilename, size: 100 }] })); return
      }
      if (req.url?.endsWith('/' + errorFilename)) {
        res.setHeader('content-type', 'text/plain')
        res.setHeader('content-disposition', 'attachment; filename="' + errorFilename + '"')
        res.end('Anthropic ChatGPT Gemini HTTPS://upstream.example/private'); return
      }
      if (req.url?.includes('/management/observability/logs')) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ lines: ['Gemini HTTP://upstream.example/private'], 'line-count': 1 })); return
      }
      const mode = req.url!.split('/').at(-1)
      if (mode === 'sse') {
        res.setHeader('content-type', 'text/event-stream')
        const first = 'data: {"choices":[{"delta":{"content":"ChatGPT https://answer.example 中文😀"}}]}\n\n'
        res.write(first)
        const last = Buffer.from('event: error\r\ndata: ' + JSON.stringify(error) + '\r\n\r\ndata: [DONE]\n\n')
        for (let offset = 0; offset < last.length; offset += 5) res.write(last.subarray(offset, offset + 5))
        res.end(); return
      }
      if (mode === 'plain') {
        res.statusCode = 502; res.setHeader('content-type', 'text/plain')
        res.end('ChatGPT https://upstream.example failed'); return
      }
      const body = mode === 'normal' ? normal : JSON.stringify(error)
      res.statusCode = ['error', 'gzip'].includes(mode!) ? 401 : 200
      res.setHeader('content-type', 'application/json')
      res.setHeader('etag', 'pre-redaction')
      if (mode === 'gzip') {
        const compressed = gzipSync(body)
        res.setHeader('content-encoding', 'gzip'); res.setHeader('content-length', compressed.length)
        res.end(compressed)
      } else { res.setHeader('content-length', Buffer.byteLength(body)); res.end(body) }
    })
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
    vi.stubEnv('CPA_URL', 'http://127.0.0.1:' + (upstream.address() as AddressInfo).port)
    vi.stubEnv('CPA_MANAGEMENT_KEY', 'test-only-management-key')
    vi.stubEnv('CPA_CLIENT_KEY', '')
    const router = createRouter()
      .use('/native/**', defineEventHandler(event => forwardNativeCpa(event, event.path)))
      .use('/api/cpa/management/**', managementHandler)
      .use('/api/cpa/console/**', consoleHandler)
      .get('/api/failure', defineEventHandler(() => { throw createError({ statusCode: 422, message: 'Gemini HTTP://failure.example failed', data: { model: 'claude-sonnet' } }) }))
    const app = createApp({ onError: diagnosticErrorHandler }).use(adminMiddleware).use(router)
    platform = createServer(toNodeListener(app))
    await new Promise<void>(resolve => platform.listen(0, '127.0.0.1', resolve))
    url = 'http://127.0.0.1:' + (platform.address() as AddressInfo).port
  })
  afterEach(async () => {
    for (const server of [platform, upstream]) if (server) await new Promise<void>(resolve => { server.close(resolve); server.closeAllConnections() })
    vi.unstubAllEnvs()
  })
  const read = (path: string) => fetch(url + path, { headers: { cookie: 'ccm_session=privacy-test' } })

  it.each(['error', 'http200', 'gzip'])('redacts %s model errors before writing and fixes length/compression headers', async mode => {
    const response = await read('/native/' + mode)
    expect(response.status).toBe(mode === 'http200' ? 200 : 401)
    expect(await response.json()).toEqual({ error: { type: 'authentication_error', message: 'Provider authentication failed. *** ***' }, model: '***-pro' })
    expect(response.headers.get('content-length')).toBeNull()
    expect(response.headers.get('content-encoding')).toBeNull()
    expect(response.headers.get('etag')).toBeNull()
  })

  it('keeps real provider names/URLs in successful model answers while hiding HTTP and SSE errors', async () => {
    const success = await read('/native/normal')
    expect(await success.text()).toBe(normal)
    const plain = await read('/native/plain')
    expect(await plain.text()).toBe('*** *** failed')
    const streaming = await read('/native/sse')
    const body = await streaming.text()
    expect(body.startsWith('data: {"choices":[{"delta":{"content":"ChatGPT https://answer.example 中文😀"}}]}\n\n')).toBe(true)
    expect(body).toContain('Provider authentication failed. *** ***')
    expect(body).not.toContain('upstream.example')
    expect(body.endsWith('data: [DONE]\n\n')).toBe(true)
  })

  it.each(['/api/cpa/management/observability/logs/errors', '/api/cpa/console/v0/management/request-error-logs'])('hides historical filename/content while keeping downloads usable through %s', async path => {
    const listing = await read(path).then(response => response.json())
    expect(JSON.stringify(listing)).not.toMatch(/gemini/i)
    expect(listing.files[0].name).toMatch(/^request-log-[a-f0-9]{64}\.log$/)
    const download = await read(path + '/' + listing.files[0].name)
    expect(download.status).toBe(200)
    expect(await download.text()).toBe('*** *** *** ***')
    expect(download.headers.get('content-disposition')).not.toMatch(/gemini/i)
    expect(paths.at(-1)).toBe(path.replace('/api/cpa/management', '/v8/management').replace('/api/cpa/console', '') + '/' + errorFilename)
  })

  it('filters application log queries and local API errors including Nitro URL metadata', async () => {
    const logs = await read('/api/cpa/management/observability/logs').then(response => response.json())
    expect(logs).toEqual({ lines: ['*** ***'], 'line-count': 1 })
    const failed = await read('/api/failure?model=gemini')
    expect(failed.status).toBe(422)
    expect(await failed.json()).toMatchObject({ url: '***', message: '*** *** failed', data: { model: '***-sonnet' } })
  })
})
