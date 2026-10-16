import { describe, expect, it } from 'vitest'
import { publicErrorBody, publicErrorCode, publicErrorMessage, publicErrorPayload } from '../server/lib/public-errors'
import { modelErrorBody } from '../server/lib/model-errors'
import { modelVendor } from '../server/lib/routing/catalog'

const leaks = /logicc|clerk|nexus|https?:|\d+\.\d+\.\d+\.\d+|[一-鿿]/i

describe('errors shown to model API callers', () => {
  it('replaces Chinese text with an English message for the status', () => {
    expect(publicErrorMessage('Logicc 会话刷新 拒绝了账号凭据（HTTP 403）', 503)).toBe('Service temporarily unavailable, please retry later')
    expect(publicErrorMessage('当前 Key 的分组中没有可调用的这个模型', 404)).toBe('The requested model is not available for this API key')
  })

  it('hides addresses and channel names but keeps useful English', () => {
    const message = publicErrorMessage('upstream https://clerk.logicc.com/v1/client failed at 10.0.0.5:8317 via nexus-logicc for logicc/claude-x (ops@example.com)', 502)
    expect(message).not.toMatch(leaks)
    expect(message).toContain('claude-x')
    expect(publicErrorMessage('context length exceeded: 210000 > 200000 tokens', 400)).toBe('context length exceeded: 210000 > 200000 tokens')
  })

  it('never passes a code that names a channel', () => {
    expect(publicErrorCode('logicc_unavailable', 503)).toBe('service_unavailable')
    expect(publicErrorCode('nexus_source_unsupported', 422)).toBe('invalid_request')
    expect(publicErrorCode('context_length_exceeded', 400)).toBe('context_length_exceeded')
  })

  it('cleans OpenAI, Anthropic, Gemini and Responses error shapes', () => {
    const shapes = [
      { error: { message: 'Logicc 账号冷却', type: 'api_error', code: 'logicc_unavailable' } },
      { type: 'error', error: { type: 'overloaded_error', message: 'nexus-logicc channel unavailable' } },
      { error: { code: 503, status: 'UNAVAILABLE', message: 'see https://app.logicc.com', details: [{ reason: 'x', metadata: { host: 'clerk.logicc.com' } }] } },
      { type: 'response.failed', response: { error: { code: 'logicc_unavailable', message: '号池为空' } } },
    ]
    for (const shape of shapes) expect(JSON.stringify(publicErrorPayload(shape, 503))).not.toMatch(leaks)
    expect(publicErrorBody('<html>Logicc down</html>', 502)).not.toMatch(leaks)
  })

  it('applies to every platform-side rejection', () => {
    expect(JSON.stringify(modelErrorBody('chat/completions', 503, 'Logicc 请求失败', 'logicc_unavailable'))).not.toMatch(leaks)
    expect(JSON.stringify(modelErrorBody('messages', 404, '没有模型'))).not.toMatch(leaks)
  })

  it('names the vendor, not the channel, as owner of a model', () => {
    expect(modelVendor('claude-sonnet-4-5')).toBe('anthropic')
    expect(modelVendor('gpt-5')).toBe('openai')
    expect(modelVendor('gemini-2.5-pro')).toBe('google')
    expect(modelVendor('some-model')).toBe('system')
  })
})
