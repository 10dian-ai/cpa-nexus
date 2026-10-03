import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, toNodeListener } from 'h3'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { migrate } from '../server/lib/migrations'

const fixture = vi.hoisted(() => ({ sql: undefined as Sql | undefined }))
vi.mock('../server/lib/db', () => ({ getDb: () => fixture.sql }))
import listLogs from '../server/api/logs/index.get'
import { insertRequestLog, type RequestLogInput } from '../server/lib/logs'
const databaseUrl = process.env.TEST_DATABASE_URL
const schema = 'ccm_logs_test_' + randomUUID().replaceAll('-', '')

describe.skipIf(!databaseUrl)('log list over HTTP and PostgreSQL', () => {
  let admin: Sql | undefined
  let sql: Sql | undefined
  let server: Server | undefined
  let baseUrl: string
  let created = false
  beforeAll(async () => {
    admin = postgres(databaseUrl!, { max: 1, connect_timeout: 5, onnotice: () => {} })
    await admin`CREATE SCHEMA ${admin(schema)}`
    created = true
    sql = postgres(databaseUrl!, { max: 1, connect_timeout: 5, onnotice: () => {},
      connection: { search_path: schema, application_name: 'ccm-log-integration-test' } })
    fixture.sql = sql
    expect((await sql`SELECT current_schema() AS schema`)[0]?.schema).toBe(schema)
    await migrate(sql)
    const app = createApp().use('/api/logs', listLogs)
    server = createServer(toNodeListener(app))
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    baseUrl = 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  }, 30000)
  afterAll(async () => {
    if (server) await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections() })
    if (sql) await sql.end({ timeout: 5 })
    if (admin) {
      try {
        if (created && /^ccm_logs_test_[a-f0-9]{32}$/.test(schema)) await admin`DROP SCHEMA ${admin(schema)} CASCADE`
      } finally { await admin.end({ timeout: 5 }) }
    }
  }, 30000)
  const request = async (query: Record<string, string>) => {
    const response = await fetch(baseUrl + '/api/logs?' + new URLSearchParams(query), { signal: AbortSignal.timeout(3000) })
    expect(response.status).toBe(200)
    return response.json()
  }
  it('matches literal model IDs containing SQL wildcard characters', async () => {
    const id = randomUUID(), prefix = randomUUID(), model = prefix + '%_memo'
    await sql!`INSERT INTO request_logs(id,model,protocol,status,duration_ms)
      VALUES(${id},${model},'chat/completions','success',1),
      (${randomUUID()},${prefix + 'XXmemo'},'chat/completions','success',1)`
    const result = await request({ model })
    expect(result.total).toBe(1)
    expect(result.items.map((item: { id: string }) => item.id)).toEqual([id])
  })
  it('keeps simultaneous requests in stable order across pagination', async () => {
    const model = randomUUID(), ids = Array.from({ length: 4 }, () => randomUUID()).sort()
    for (const id of ids) await sql!`INSERT INTO request_logs(id,model,protocol,status,duration_ms,created_at)
      VALUES(${id},${model},'chat/completions','success',1,'2026-09-12T00:00:00Z')`
    const first = await request({ model, page: '1', pageSize: '2' })
    const second = await request({ model, page: '2', pageSize: '2' })
    expect(first.total).toBe(4)
    expect(second.total).toBe(4)
    expect([...first.items, ...second.items].map((item: { id: string }) => item.id)).toEqual(ids.reverse())
  })
  it('stores redacted JSON payloads and preserves completed requests after references are deleted', async () => {
    const accountId = randomUUID(), keyId = randomUUID(), id = randomUUID()
    await sql!`INSERT INTO managed_accounts(id,credential_fingerprint,cookie_ciphertext,label)
      VALUES(${accountId},${randomUUID()},'encrypted-test-cookie','log account')`
    await sql!`INSERT INTO gateway_keys(id,name,prefix,secret_hash)
      VALUES(${keyId},'log client','test-prefix',${randomUUID()})`
    const input: RequestLogInput = {
      id, keyId, accountId, model: 'test/log-payload', protocol: 'chat/completions', sessionId: 'test-session',
      status: 'success', httpStatus: 200, durationMs: 15, streaming: false, usage: { total_tokens: 12 },
      errorMessage: null, requestBody: { messages: [{ role: 'user', content: 'hello' }], apiKey: 'test-secret' },
      responseBody: { choices: [{ message: { content: 'world' } }] }, responseTruncated: false,
    }
    await insertRequestLog(input)
    const row = (await sql!`SELECT * FROM request_logs WHERE id=${id}`)[0]!
    expect(row.request_body).toEqual({ messages: [{ role: 'user', content: 'hello' }], apiKey: '[redacted]' })
    expect(row.response_body).toEqual(input.responseBody)
    expect(row.usage).toEqual({ total_tokens: 12 })
    expect(row.account_id).toBe(accountId)
    expect(row.key_id).toBe(keyId)
    await sql!`DELETE FROM managed_accounts WHERE id=${accountId}`
    await sql!`DELETE FROM gateway_keys WHERE id=${keyId}`
    const lateId = randomUUID()
    await expect(insertRequestLog({ ...input, id: lateId })).resolves.toEqual({ id: lateId })
    const late = (await sql!`SELECT * FROM request_logs WHERE id=${lateId}`)[0]!
    expect(late.account_id).toBeNull()
    expect(late.key_id).toBeNull()
    expect(late.response_body).toEqual(input.responseBody)
    expect(late.request_body.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect((await request({ model: input.model })).total).toBe(2)
  })

  it.each([
    { name: 'NUL value', value: { messages: [{ content: 'before\u0000after' }] } },
    { name: 'isolated high surrogate', value: { content: 'before\ud800after' } },
    { name: 'isolated low surrogate', value: { content: 'before\udfffafter' } },
    { name: 'NUL object key', value: { nested: { ['key\u0000']: 'value' } } },
    { name: 'isolated surrogate object key', value: { ['key\ud800']: 'value' } },
  ])('preserves $name in an explicit lossless JSON-text wrapper after redaction', async ({ value }) => {
    const requestBody = { ...value, authorization: 'private-test-key' }
    const redacted = { ...value, authorization: '[redacted]' }
    const input: RequestLogInput = {
      keyId: null, accountId: null, model: 'test/unicode-log', protocol: 'chat/completions', sessionId: null,
      status: 'success', httpStatus: 200, durationMs: 1, streaming: false, usage: { total_tokens: 3 },
      errorMessage: null, requestBody, responseBody: value, responseTruncated: false,
    }
    const { id } = await insertRequestLog(input)
    const row = (await sql!`SELECT request_body,response_body,usage FROM request_logs WHERE id=${id}`)[0]!
    for (const [field, expected] of [[row.request_body, redacted], [row.response_body, value]]) {
      expect(field).toMatchObject({ format: 'json-text', reason: 'unsupported_jsonb_unicode' })
      expect(JSON.parse(field.raw)).toEqual(expected)
      expect(field.raw).not.toContain('private-test-key')
    }
    expect(row.usage).toEqual({ total_tokens: 3 })
  })

  it('keeps valid Unicode pairs and literal JSON escape text as ordinary structured JSON', async () => {
    const value = { content: 'Emoji \ud83d\ude00 and literal \\u0000', ['key\ud83d\ude00']: 'value' }
    const { id } = await insertRequestLog({
      keyId: null, accountId: null, model: 'test/unicode-log', protocol: 'chat/completions', sessionId: null,
      status: 'success', httpStatus: 200, durationMs: 1, streaming: false, usage: { total_tokens: 1 },
      errorMessage: null, requestBody: value, responseBody: value, responseTruncated: false,
    })
    const row = (await sql!`SELECT request_body,response_body FROM request_logs WHERE id=${id}`)[0]!
    expect(row.request_body).toEqual(value)
    expect(row.response_body).toEqual(value)
  })

  it('repairs legacy double-encoded JSON without changing plain text, scalars, nulls or structured values', async () => {
    const object = { messages: [{ role: 'user', content: 'legacy request' }], total_tokens: 12 }
    const array = [{ content: 'legacy response' }]
    const samples = [
      { value: JSON.stringify(object), expected: object },
      { value: JSON.stringify(array), expected: array },
      { value: object, expected: object },
      { value: array, expected: array },
      { value: 'plain text response', expected: 'plain text response' },
      { value: JSON.stringify('plain text response'), expected: JSON.stringify('plain text response') },
      { value: '{invalid json', expected: '{invalid json' },
      { value: JSON.stringify({ content: '\u0000' }), expected: JSON.stringify({ content: '\u0000' }) },
      { value: JSON.stringify({ content: '\ud800' }), expected: JSON.stringify({ content: '\ud800' }) },
      { value: '{"value":1e1000000}', expected: '{"value":1e1000000}' },
      { value: 12, expected: 12 },
      { value: '12', expected: '12' },
      { value: true, expected: true },
      { value: null, expected: null },
      { value: undefined, expected: null },
    ].map(sample => ({ ...sample, id: randomUUID() }))
    for (const sample of samples) {
      const value = sample.value === undefined ? null : sample.value === null ? sql!`'null'::jsonb` : sql!.json(sample.value as any)
      await sql!`INSERT INTO request_logs(id,model,protocol,status,duration_ms,request_body,response_body,usage)
        VALUES(${sample.id},'test/legacy-json','chat/completions','success',1,${value},${value},${value})`
    }
    // Re-run only this migration in this test's isolated schema after inserting old-format records.
    await sql!`DELETE FROM schema_migrations WHERE name='003_log_json_values.sql'`
    await migrate(sql!)
    const read = () => sql!`SELECT id,request_body,response_body,usage,request_body IS NULL AS sql_null
      FROM request_logs WHERE model='test/legacy-json' ORDER BY id`
    const repaired = await read()
    for (const sample of samples) {
      const row = repaired.find(row => row.id === sample.id)!
      expect(row.request_body).toEqual(sample.expected)
      expect(row.response_body).toEqual(sample.expected)
      expect(row.usage).toEqual(sample.expected)
      expect(row.sql_null).toBe(sample.value === undefined)
    }
    await migrate(sql!)
    expect([...await read()]).toEqual([...repaired])
    expect(await sql!`SELECT name FROM schema_migrations WHERE name='003_log_json_values.sql'`).toHaveLength(1)
  })

})
