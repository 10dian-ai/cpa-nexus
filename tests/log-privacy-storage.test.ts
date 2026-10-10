import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { createApp, createRouter, toNodeListener } from 'h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ queries: [] as Array<{ text: string; values: unknown[] }>, rows: [] as Record<string, unknown>[] }))
vi.mock('../server/lib/db', () => {
  const db = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    fixture.queries.push({ text, values })
    return text.includes('count(*)') ? [{ total: fixture.rows.length }] : text.includes('SELECT l.') ? fixture.rows : []
  }, { json: (value: unknown) => value })
  return { getDb: () => db }
})
import { insertRequestLog } from '../server/lib/logs'
import listLogs from '../server/api/logs/index.get'
import getLog from '../server/api/logs/[id].get'
import { listDevinLogs } from '../server/lib/devin2api/admin'

describe('request log persistence and historical reads', () => {
  let server: Server | undefined
  beforeEach(() => { fixture.queries.length = 0; fixture.rows.length = 0 })
  afterEach(async () => { if (server) await new Promise<void>(resolve => { server!.close(resolve); server!.closeAllConnections() }); server = undefined })

  it('stores sanitized diagnostic copies while retaining the caller model and body for actual inference', async () => {
    const input = { keyId: null, accountId: null, model: 'gemini-pro', protocol: 'messages' as const, sessionId: 'Anthropic-session',
      status: 'error' as const, httpStatus: 401, durationMs: 1, streaming: false, usage: { output_tokens: 3 },
      errorMessage: 'ChatGPT rejected https://upstream.example', requestBody: { model: 'gemini-pro', messages: [{ content: 'https://prompt.example' }], authorization: 'private-key' },
      responseBody: { error: { message: 'Anthropic rejected' } }, responseTruncated: false }
    await insertRequestLog(input)
    const insert = fixture.queries.find(query => query.text.includes('INSERT INTO request_logs'))!
    expect(insert.values).toContain('***-pro')
    expect(insert.values).toContain('***-session')
    expect(insert.values).toContain('*** rejected ***')
    expect(insert.values).toContainEqual({ model: '***-pro', messages: [{ content: '***' }], authorization: '[redacted]' })
    expect(insert.values).toContainEqual({ error: { message: '*** rejected' } })
    expect(insert.values).toContainEqual({ output_tokens: 3 })
    expect(JSON.stringify(insert.values)).not.toMatch(/gemini|anthropic|chatgpt|https?:|private-key/i)
    expect(input.model).toBe('gemini-pro')
    expect(input.requestBody.messages[0]!.content).toBe('https://prompt.example')
  })

  it('filters old rows on list/detail reads, protects old credentials and searches both original and masked model names', async () => {
    const id = randomUUID()
    const sourceId = randomUUID()
    const old = { id, account_id: null, module_id: 'devin2api', source_id: sourceId, account_label: 'Gemini source', key_name: 'Anthropic https://key.example', model: 'gemini-pro', protocol: 'messages', status: 'error',
      http_status: 401, duration_ms: 1, streaming: false, usage: { output_tokens: 3 }, error_message: 'ChatGPT HTTP://upstream.example', response_truncated: false,
      created_at: new Date().toISOString(), request_body: { model: 'gemini-pro', authorization: 'old-private-key', messages: [{ content: 'https://prompt.example' }] },
      response_body: { format: 'sse', raw: String.raw`data: {"error":{"message":"Anthropic https:\/\/upstream.example"}}` }, session_id: 'Anthropic-session' }
    fixture.rows.push(old)
    const app = createApp().use(createRouter().get('/api/logs', listLogs).get('/api/logs/:id', getLog))
    server = createServer(toNodeListener(app))
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
    const page = await fetch(base + '/api/logs?model=gemini-pro').then(response => response.json())
    const detail = await fetch(base + '/api/logs/' + id).then(response => response.json())
    expect(page.items[0]).toMatchObject({ model: '***-pro', accountLabel: '*** source', keyName: '*** ***', errorMessage: '*** ***', usage: { output_tokens: 3 } })
    expect(page.items[0]).toMatchObject({ accountId: sourceId, moduleId: '***2api', sourceId })
    expect(detail).toMatchObject({ accountId: sourceId, moduleId: '***2api', sourceId })
    expect(detail.requestBody.authorization).toBe('[redacted]')
    expect(detail.responseBody.raw).toContain('"message":"*** ***"')
    expect(JSON.stringify({ page, detail })).not.toMatch(/gemini|anthropic|chatgpt|https?:|old-private-key/i)
    expect(old.model).toBe('gemini-pro')
    expect(old.module_id).toBe('devin2api')
    const moduleLogs = await listDevinLogs({ page: 1, pageSize: 50, model: 'gemini-pro' })
    expect(JSON.stringify(moduleLogs)).not.toMatch(/gemini|anthropic|chatgpt|https?:|old-private-key/i)
    expect(moduleLogs.items[0]).toMatchObject({ accountId: sourceId, model: '***-pro', errorMessage: '*** ***' })
    const conditions = fixture.queries.filter(query => query.text.includes('l.model ILIKE'))
    expect(conditions.some(query => query.values.includes('%gemini-pro%') && query.values.includes('%***-pro%'))).toBe(true)
  })

  it('keeps real module/source IDs in database routing columns and filters billing log metadata copies', async () => {
    const sourceId = randomUUID()
    await insertRequestLog({ keyId: null, accountId: null, moduleId: 'devin2api', sourceId, model: 'devin/glm-5', protocol: 'messages', sessionId: null,
      status: 'success', httpStatus: 200, durationMs: 1, streaming: false, usage: { total_tokens: 10, nexus: { moduleId: 'devin2api', groupIds: ['group-a'] } },
      errorMessage: null, requestBody: null, responseBody: null, responseTruncated: false })
    const insert = fixture.queries.find(query => query.text.includes('INSERT INTO request_logs'))!
    expect(insert.text).toContain('module_id,source_id')
    expect(insert.values[3]).toBe('devin2api')
    expect(insert.values[4]).toBe(sourceId)
    expect(insert.values[5]).toBe('***/***-5')
    expect(insert.values).toContainEqual({ total_tokens: 10, nexus: { moduleId: '***2api', groupIds: ['group-a'] } })
  })
})
