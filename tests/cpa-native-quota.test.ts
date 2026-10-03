import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseNativeQuotaWindows, queryNativeQuota, resetNativeQuotaCache, sanitizeQuotaPayload, type CpaNativeQuotaClient } from '../server/lib/cpa/quota'
import type { CpaRequest } from '../server/lib/cpa/client'

const AUTH_INDEX = '0123456789abcdef'
const response = (body: unknown, status = 200) => ({ status, statusText: 'OK', headers: new Headers(), body: Buffer.from(JSON.stringify(body)) })
function fixture(provider: string, payload: unknown, document: Record<string, unknown> = { type: provider }) {
  const calls: Record<string, any>[] = []
  const request = vi.fn(async (input: CpaRequest) => {
    if (input.path === 'credentials') return response({ files: [{ name: provider + '.json', provider, auth_index: AUTH_INDEX, project_id: provider === 'antigravity' ? 'test-project' : undefined }] })
    if (input.path === 'credentials/download') return response(document)
    expect(input.path).toBe('requests/api-call')
    const operation = JSON.parse(String(input.body))
    calls.push(operation)
    return response({ status_code: 200, header: { authorization: ['private-upstream-header'] }, body: JSON.stringify(payload) })
  })
  return { client: { request } satisfies CpaNativeQuotaClient, request, calls }
}
beforeEach(() => resetNativeQuotaCache())

describe('explicit native supplier quota queries', () => {
  it.each([
    ['claude', { five_hour: { utilization: 21, resets_at: '2026-10-04T00:00:00Z' }, extra_usage: { used_credits: 3, monthly_limit: 100 } }, 'api.anthropic.com', { usedPercent: 21 }],
    ['codex', { rate_limit: { primary_window: { used_percent: 12, reset_at: 1791072000 }, secondary_window: { reset_at: 1791072000 } } }, 'chatgpt.com', { usedPercent: 12 }],
    ['antigravity', { groups: [{ displayName: 'Google', buckets: [{ window: '5h', remainingFraction: 0.7, resetTime: '2026-10-04T00:00:00Z' }] }] }, 'daily-cloudcode-pa.googleapis.com', { remainingPercent: 70 }],
    ['kimi', { usage: { used: 9, limit: 100, remaining: 91 }, limits: [{ name: '5h', detail: { remaining: 8, limit: 10 } }] }, 'api.kimi.com', { used: 9, limit: 100, remaining: 91 }],
    ['devin', { userStatus: { planStatus: { dailyQuotaRemainingPercent: 87, weeklyQuotaRemainingPercent: 65, dailyQuotaResetAtUnix: 1791072000 } } }, 'server.codeium.com', { remainingPercent: 87 }],
    ['meta', { api_key: 'fresh-private-key', user_email: 'private@example.invalid', subs_usage: { window: { used_percent: 17, resets_at: 1791072000 }, weekly: { used_percent: 44 } } }, 'api.meta.ai', { usedPercent: 17 }],
    ['xai', { config: { currentPeriod: { type: 'weekly', end: '2026-10-04T00:00:00Z' }, creditUsagePercent: 35, used: { val: 5 }, monthlyLimit: { val: 100 } } }, 'cli-chat-proxy.grok.com', { usedPercent: 35, used: 5, limit: 100 }],
  ])('queries %s only through the registered credential and fixed official quota URL', async (provider, payload, host, fields) => {
    const { client, calls } = fixture(String(provider), payload, { type: provider, dca_token: 'dca:fake-test-only-credential' })
    const result = await queryNativeQuota({ provider: String(provider), auth_index: AUTH_INDEX }, client)
    expect(result).toMatchObject({ provider, authIndex: AUTH_INDEX, source: 'core-api-call' })
    expect(result.windows[0]).toMatchObject(fields)
    expect(new URL(calls[0]!.url).hostname).toBe(host)
    expect(calls.every(call => call.auth_index === AUTH_INDEX)).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/fresh-private-key|private@example|dca:|private-upstream-header/)
    expect(calls.every(call => !call.url.includes('chat/completions'))).toBe(true)
    if (provider === 'devin') expect(JSON.parse(calls[0]!.data).metadata.apiKey).toBe('$TOKEN$')
    else if (provider === 'meta') expect(calls[0]!.header.Authorization).toBe('Bearer dca:fake-test-only-credential')
    else expect(calls[0]!.header.Authorization).toBe('Bearer $TOKEN$')
  })

  it('selects Kimi region from the persisted domain without forwarding its arbitrary URL', async () => {
    const { client, calls } = fixture('kimi', { usage: { used: 1, limit: 10 } }, { type: 'kimi', domain: 'kimi.ai', base_url: 'https://untrusted.example/token', access_token: 'server-only' })
    await queryNativeQuota({ provider: 'kimi', auth_index: AUTH_INDEX }, client)
    expect(calls[0]!.url).toBe('https://api.kimi.ai/coding/v1/usages')
    expect(JSON.stringify(calls)).not.toContain('server-only')
    expect(JSON.stringify(calls)).not.toContain('untrusted.example')
  })

  it('honors an explicitly empty canonical Kimi base URL over the legacy alias', async () => {
    const { client, calls } = fixture('kimi', { usage: { used: 1 } }, { type: 'kimi', base_url: null, 'base-url': 'https://api.kimi.ai' })
    await queryNativeQuota({ provider: 'kimi', auth_index: AUTH_INDEX }, client)
    expect(calls[0]!.url).toBe('https://api.kimi.com/coding/v1/usages')
  })

  it('never fills unknown numbers with zero or derives usage from remaining and limit', () => {
    const windows = parseNativeQuotaWindows('kimi', { limits: [{ detail: { remaining: 4, limit: 10 } }] })
    expect(windows[0]).toMatchObject({ remaining: 4, limit: 10 })
    expect(windows[0]).not.toHaveProperty('used')
    expect(windows[0]).not.toHaveProperty('usedPercent')
    const codex = parseNativeQuotaWindows('codex', { rate_limit: { limit_reached: true, primary_window: { reset_at: 1791072000 } } })
    expect(codex[0]).not.toHaveProperty('usedPercent')
    expect(parseNativeQuotaWindows('claude', { five_hour: { utilization: null } })[0]).not.toHaveProperty('usedPercent')
  })

  it('preserves zero when it was actually returned, including numeric strings and ratio units', () => {
    expect(parseNativeQuotaWindows('claude', { five_hour: { utilization: 0 } })[0]).toMatchObject({ usedPercent: 0 })
    expect(parseNativeQuotaWindows('kimi', { usages: { limit_month_total: { used_ratio: '0.4' } } })[0]).toMatchObject({ usedPercent: 40 })
    expect(parseNativeQuotaWindows('antigravity', { groups: [{ buckets: [{ remainingFraction: 0 }] }] })[0]).toMatchObject({ remainingPercent: 0 })
  })

  it('rejects missing, mismatched and ambiguous credentials before making supplier requests', async () => {
    for (const rows of [[], [{ auth_index: AUTH_INDEX, provider: 'meta' }], [{ auth_index: AUTH_INDEX, provider: 'codex' }, { auth_index: AUTH_INDEX, provider: 'codex' }]]) {
      const { client, request, calls } = fixture('codex', {})
      request.mockImplementationOnce(async () => response({ files: rows }))
      await expect(queryNativeQuota({ provider: 'codex', auth_index: AUTH_INDEX }, client)).rejects.toMatchObject({ statusCode: expect.any(Number) })
      expect(calls).toHaveLength(0)
    }
  })

  it('keeps upstream failures bounded and applies a five-second retry cooldown without returning secret payloads', async () => {
    const { client, request } = fixture('kimi', {})
    const original = request.getMockImplementation()!
    let supplierCalls = 0
    request.mockImplementation(async input => {
      if (input.path === 'requests/api-call') { supplierCalls++; return response({ status_code: 401, body: 'private-upstream-token' }) }
      return original(input)
    })
    for (let index = 0; index < 2; index++) {
      await expect(queryNativeQuota({ provider: 'kimi', auth_index: AUTH_INDEX }, client)).rejects.toMatchObject({ code: 'quota_upstream_error', statusCode: 502, message: '供应商拒绝配额查询（HTTP 401）' })
    }
    expect(supplierCalls).toBe(1)
  })

  it('coalesces concurrent refreshes and limits active supplier accounts to four', async () => {
    const { client, request } = fixture('devin', { userStatus: { planStatus: { dailyQuotaRemainingPercent: 90 } } })
    let active = 0, peak = 0, supplierCalls = 0
    request.mockImplementation(async input => {
      if (input.path === 'credentials') return response({ files: [{ name: 'devin.json', provider: 'devin', auth_index: String((input.query as Record<string, unknown>).auth_index) }] })
      active++; peak = Math.max(peak, active); supplierCalls++
      await new Promise(resolve => setTimeout(resolve, 20)); active--
      return response({ status_code: 200, body: JSON.stringify({ userStatus: { planStatus: { dailyQuotaRemainingPercent: 90 } } }) })
    })
    const inputs = ['a', 'a', 'b', 'c', 'd', 'e', 'f'].map(auth_index => ({ auth_index, provider: 'devin' }))
    const results = await Promise.all(inputs.map(input => queryNativeQuota(input, client)))
    expect(peak).toBeLessThanOrEqual(4); expect(supplierCalls).toBe(6)
    expect(results[0]).toEqual(results[1])
    await queryNativeQuota(inputs[0]!, client)
    expect(supplierCalls).toBe(6)
  })

  it('sanitizes supplier PII and fresh credentials while retaining real quota structure', () => {
    expect(sanitizeQuotaPayload({ api_key: 'private', access_token: 'private', user_email: 'private', subs_usage: { window: { used_percent: 25 }, api_key: 'private' }, is_subs_active: true })).toEqual({ subs_usage: { window: { used_percent: 25 } }, is_subs_active: true })
  })
})
