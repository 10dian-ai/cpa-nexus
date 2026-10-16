import { describe, expect, it, vi } from 'vitest'
vi.mock('../server/lib/db', () => ({ getDb: () => { throw new Error('no database in parser tests') } }))
import { logiccIntake } from '../server/modules/logicc/intake'
import { cpaIntake } from '../server/lib/cpa/intake'
import { configKeySourceId } from '../server/lib/cpa/preset-config-routing'

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
const jwt = (claims: object) => `eyJhbGciOiJSUzI1NiJ9.${b64(claims)}.c2lnbmF0dXJl`
const future = Math.floor(Date.now() / 1000) + 3600
const CLIENT = 'a'.repeat(40)
const SESSION = 'sess_2abcDEF123456'

describe('Logicc intake formats', () => {
  it('accepts logicc2api JSON, cookie headers, separated lines, JWTs and browser cookie exports', () => {
    const text = [
      JSON.stringify([{ name: 'Work', clientCookie: CLIENT, sessionId: SESSION, enabled: false }]),
    ].join('\n')
    const json = logiccIntake.parse({ text })
    expect(json.errors).toEqual([])
    expect(json.items[0]!.payload).toMatchObject({ label: 'Work', clientCookie: CLIENT, sessionId: SESSION, enabled: false })

    const lines = logiccIntake.parse({ text: [
      `Cookie: __client=${'b'.repeat(40)}; __session=${jwt({ sid: 'sess_fromcookie1', exp: future })}`,
      `${'c'.repeat(40)}----sess_dashsep01`,
      `My account|${'d'.repeat(40)}|sess_pipesep01`,
      jwt({ sid: 'sess_jwtonly001', exp: future }),
      '# comment lines are ignored',
    ].join('\n') })
    expect(lines.errors).toEqual([])
    expect(lines.items.map(item => item.payload.sessionId)).toEqual(['sess_fromcookie1', 'sess_dashsep01', 'sess_pipesep01', 'sess_jwtonly001'])
    expect(lines.items[2]!.payload.label).toBe('My account')

    const exported = logiccIntake.parse({ files: [{ name: 'cookies.json', content: JSON.stringify([{ name: '__client', value: 'e'.repeat(40), domain: 'clerk.logicc.com' }, { name: 'other', value: 'x' }]) }] })
    expect(exported.items).toHaveLength(1)
    expect(exported.items[0]!.payload).toMatchObject({ clientCookie: 'e'.repeat(40), sessionId: null })
  })

  it('rejects unusable credentials with line numbers and drops duplicates within a submission', () => {
    const result = logiccIntake.parse({ text: [
      `${CLIENT}----${SESSION}`,
      `${CLIENT}----${SESSION}`,
      jwt({ sid: 'sess_expired001', exp: 1 }),
      jwt({ exp: future }),
      'short',
      `${CLIENT}----sess_otherone1|${jwt({ sid: 'sess_mismatch01', exp: future })}`,
    ].join('\n') })
    // A JWT without `sid` is Clerk's own __client token: kept, its session is looked up on import.
    expect(result.items.map(item => item.payload.sessionId)).toEqual([SESSION, null])
    expect(result.errors.map(error => error.line)).toEqual([3, 5, 6])
    expect(result.errors[0]!.message).toContain('过期')
  })

  it('never echoes credentials in error messages', () => {
    const secret = jwt({ sid: 'sess_expired002', exp: 1, email: 'private@example.com' })
    const result = logiccIntake.parse({ text: secret })
    expect(JSON.stringify(result.errors)).not.toContain(secret)
  })
})

describe('CPA kernel intake formats', () => {
  it('detects provider keys, explicit families, credential files and service accounts', () => {
    const parsed = cpaIntake.parse({
      text: [
        'AIza' + 'A'.repeat(35),
        'sk-ant-api03-' + 'b'.repeat(40),
        'xai-' + 'c'.repeat(40),
        'sk-proj-' + 'd'.repeat(40),
        'claude|sk-ant-relay-' + 'e'.repeat(30) + '|https://relay.example.com/',
        'openai-compatibility|my-relay|sk-' + 'f'.repeat(30) + '|https://api.relay.example/v1',
      ].join('\n'),
      files: [
        { name: 'codex.json', content: JSON.stringify({ type: 'codex', email: 'a@example.com', access_token: 'token', refresh_token: 'refresh' }) },
        { name: 'sa.json', content: JSON.stringify({ type: 'service_account', client_email: 'x@p.iam.gserviceaccount.com', private_key: '-----BEGIN-----', private_key_id: 'k1' }) },
      ],
      items: [{ provider: 'gemini', apiKey: 'AIza' + 'Z'.repeat(35), prefix: 'team' }],
    })
    expect(parsed.errors).toEqual([])
    const payloads = parsed.items.map(item => item.payload as Record<string, unknown>)
    expect(payloads.map(item => item.kind === 'key' ? `${item.family}:${item.baseUrl}` : item.kind)).toEqual([
      'gemini:', 'claude:', 'xai:https://api.x.ai/v1', 'codex:https://api.openai.com/v1',
      'claude:https://relay.example.com', 'openai-compatibility:https://api.relay.example/v1', 'file', 'vertex', 'gemini:',
    ])
    expect(payloads[5]).toMatchObject({ name: 'my-relay' })
    expect(payloads[8]).toMatchObject({ prefix: 'team' })
    expect(String(payloads[6]!.name)).toMatch(/^codex-a@example\.com-[0-9a-f]{8}\.json$/)
  })

  it('rejects unknown keys, reserved channel names and unsafe addresses', () => {
    const parsed = cpaIntake.parse({ text: ['not-a-key', 'openai-compatibility|nexus-logicc|sk-' + 'a'.repeat(30) + '|https://x.example', 'claude|sk-ant-' + 'a'.repeat(30) + '|ftp://x.example', 'claude|sk-ant-' + 'b'.repeat(30) + '|https://user:pass@x.example'].join('\n'), items: [{}] })
    expect(parsed.items).toEqual([])
    expect(parsed.errors.map(error => error.line)).toEqual([1, 2, 3, 4, 5])
  })

  it('predicts the source ID CPA gives an API-key entry', () => {
    expect(configKeySourceId('claude', '', 'sk-ant-x')).toMatch(/^config:[0-9a-f]{16}$/)
    expect(configKeySourceId('claude', '', 'sk-ant-x')).not.toBe(configKeySourceId('codex', '', 'sk-ant-x'))
  })
})
