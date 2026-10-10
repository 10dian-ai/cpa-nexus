import { describe, expect, it } from 'vitest'
import { isModelErrorPayload, redactDiagnosticFields, redactLogValue, redactSensitiveText } from '../shared/log-privacy'
import { DiagnosticResponseFilter, redactManagementResponse, redactModelResponseBody, resolveDiagnosticDownloadPath } from '../server/lib/diagnostic-response'
import { redactLogFields } from '../server/lib/logs'
import { apiErrorMessage } from '../app/composables/useApiAction'

const encode = (value: string) => new TextEncoder().encode(value)
const decode = (value: Uint8Array) => new TextDecoder().decode(value)

describe('user-visible diagnostic privacy', () => {
  it('hides provider aliases, model-name prefixes and ordinary/escaped HTTP URLs case-insensitively', () => {
    const input = String.raw`ChatGPT cHaT-gPt open_ai Gemini/gemini-pro ANTHROPIC claude-sonnet https://api.example/path?q=1 HTTP://other.example HTTPS:\/\/third.example/path https:\u002f\u002ffourth.example/path`
    expect(redactSensitiveText(input)).toBe('*** *** *** ***/***-pro *** ***-sonnet *** *** *** ***')
    expect(redactSensitiveText('metadata, llama model, GLM-5, Google, 阿里巴巴')).toBe('metadata, *** model, ***-5, ***, ***')
    expect(redactSensitiveText('Devin upstream_host=server.codeium.com, Windsurf, GOAT')).toBe('*** upstream_host=server.***.com, ***, ***')
    expect(redactSensitiveText(String.raw`{"url":"https:\/\/api.example","next":"keep"}\nAnthropic`)).toBe(String.raw`{"url":"***","next":"keep"}\n***`)
  })

  it('redacts log copies recursively without mutating the original request/response or losing usage and credentials protection', () => {
    const original = { model: 'gemini-model', headers: { authorization: 'private-key' }, messages: [{ content: 'ChatGPT at https://upstream.example' }], usage: { input_tokens: 3 }, ['anthropic-detail']: 'keep' }
    expect(redactLogFields(original)).toEqual({ model: '***-model', headers: { authorization: '[redacted]' }, messages: [{ content: '*** at ***' }], usage: { input_tokens: 3 }, ['***-detail']: 'keep' })
    expect(original.model).toBe('gemini-model')
    expect(original.messages[0]!.content).toContain('https://upstream.example')
    expect(redactLogValue({ body: ['OpenAI', { error: 'Gemini: HTTPS://upstream.example' }] })).toEqual({ body: ['***', { error: '***: ***' }] })
  })

  it('hides nested stored errors while retaining usable configuration, providers, OAuth URLs and model lists', () => {
    const config = { provider: 'Anthropic', models: ['claude-sonnet'], url: 'https://oauth.example', credentials: [{ type: 'gemini', status_message: 'Gemini failed https://api.example', syncError: 'OpenAI rejected' }] }
    expect(redactDiagnosticFields(config)).toEqual({ provider: 'Anthropic', models: ['claude-sonnet'], url: 'https://oauth.example', credentials: [{ type: 'gemini', status_message: '*** failed ***', syncError: '*** rejected' }] })
    expect(apiErrorMessage({ message: 'ChatGPT HTTP://upstream.example failed' })).toBe('*** *** failed')
  })

  it('rewrites non-JSON and JSON HTTP errors and HTTP-200 error envelopes but preserves normal model output bytes', () => {
    const normal = encode('{ "model":"gemini-pro", "choices":[{"message":{"content":"Anthropic https://example.test"}}] }')
    expect(redactModelResponseBody(normal, 200)).toBe(normal)
    for (const status of [200, 401, 502]) {
      const raw = encode('{"error":{"type":"authentication_error","message":"Anthropic failed HTTPS:\\/\\/upstream.example"},"model":"gemini-pro"}')
      expect(JSON.parse(decode(redactModelResponseBody(raw, status)))).toEqual({ error: { type: 'authentication_error', message: '*** failed ***' }, model: '***-pro' })
    }
    expect(decode(redactModelResponseBody(encode('ChatGPT proxy error https://example.test'), 502))).toBe('*** proxy error ***')
    expect(isModelErrorPayload({ choices: [{ message: { content: '{"error":"a user quote"}' } }] })).toBe(false)
  })

  it('filters error SSE frames across every byte and UTF-8 boundary while retaining normal deltas and completion events', () => {
    const normal = 'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"Gemini https://answer.example 中文😀"}\r\n\r\n'
    const error = 'event: response.failed\r\ndata: {"type":"response.failed",\r\ndata: "response":{"error":{"message":"Anthropic HTTPS:\\/\\/private.example 中文😀"}}}\r\n\r\n'
    const done = 'data: [DONE]\n\n'
    const filter = new DiagnosticResponseFilter(200, 'text/event-stream; charset=utf-8')
    const chunks: Uint8Array[] = []
    for (const byte of encode(normal + error + done)) chunks.push(...filter.push(Uint8Array.of(byte)))
    chunks.push(...filter.end())
    const safe = Buffer.concat(chunks).toString('utf8')
    expect(safe.startsWith(normal)).toBe(true)
    expect(safe.endsWith(done)).toBe(true)
    expect(safe).toContain('"message":"*** *** 中文😀"')
    expect(safe).not.toContain('private.example')
    expect(safe).not.toContain('Anthropic')
  })

  it('filters plain-text error events and final events without a blank-line terminator', () => {
    const filter = new DiagnosticResponseFilter(200, 'text/event-stream')
    const output = [...filter.push(encode('event: error\ndata: ChatGPT https://private.example')), ...filter.end()]
    expect(Buffer.concat(output).toString()).toBe('event: error\ndata: *** ***')
  })

  it('uses stable anonymous references for historical error-log filenames and resolves them before downloading', async () => {
    for (const path of ['observability/logs/errors', 'v0/management/request-error-logs']) {
      const listing = { files: [{ name: 'error-gemini-model.log', size: 8 }] }
      const response = { status: 200, body: encode(JSON.stringify(listing)), headers: new Headers({ 'content-length': '100', etag: 'old' }) }
      redactManagementResponse(path, response)
      const safe = JSON.parse(decode(response.body))
      expect(safe.files[0].name).toMatch(/^request-log-[a-f0-9]{64}\.log$/)
      expect(decode(response.body)).not.toMatch(/gemini/i)
      expect(response.headers.has('content-length')).toBe(false)
      expect(response.headers.has('etag')).toBe(false)
      const resolved = await resolveDiagnosticDownloadPath(path + '/' + safe.files[0].name, async index => {
        expect(index).toBe(path)
        return { status: 200, body: encode(JSON.stringify(listing)) }
      })
      expect(resolved).toBe(path + '/error-gemini-model.log')
      await expect(resolveDiagnosticDownloadPath(path + '/' + safe.files[0].name, async () => ({ status: 200, body: encode('{"files":[]}') }))).rejects.toMatchObject({ statusCode: 404 })
    }
  })

  it('filters CPA logs, download headers and upstream probe failures without rewriting successful assets/configuration', () => {
    const response = { status: 200, body: encode('Gemini HTTPS://private.example'), headers: new Headers({ 'content-disposition': 'attachment; filename="gemini.log"' }) }
    redactManagementResponse('observability/logs/requests/local-request', response)
    expect(decode(response.body)).toBe('*** ***')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="***.log"')
    const probe = { status: 200, body: encode('{"status_code":401,"body":"Anthropic rejected https://private.example"}'), headers: new Headers() }
    redactManagementResponse('requests/api-call', probe)
    expect(JSON.parse(decode(probe.body))).toEqual({ status_code: 401, body: '*** rejected ***' })
    const semanticError = { status: 200, body: encode(JSON.stringify({ status_code: 200, body: JSON.stringify({ error: { message: 'Anthropic rejected https://private.example' } }) })), headers: new Headers() }
    redactManagementResponse('requests/api-call', semanticError)
    expect(JSON.parse(JSON.parse(decode(semanticError.body)).body)).toEqual({ error: { message: '*** rejected ***' } })
    const oauthError = { status: 200, body: encode('{"status":"error","message":"Anthropic https://private.example failed"}'), headers: new Headers() }
    redactManagementResponse('oauth/status', oauthError)
    expect(JSON.parse(decode(oauthError.body))).toEqual({ status: 'error', message: '*** *** failed' })
    const config = { status: 200, body: encode('{ "base-url":"https://upstream.example", "model":"gemini-pro" }'), headers: new Headers() }
    const raw = config.body
    redactManagementResponse('config', config)
    expect(config.body).toBe(raw)
  })
})
