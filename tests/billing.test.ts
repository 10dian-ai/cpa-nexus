import { describe, expect, it } from 'vitest'
import { BillingUsageObserver, normalizeBillingRequest } from '../server/lib/billing'

describe('provider usage for relay billing', () => {
  it('requests chat stream usage after prompt expansion without mutating client options', () => {
    const body = { stream: true, stream_options: { include_usage: false, provider_extension: 'keep' }, messages: [{ role: 'system', content: 'preset' }] }
    const normalized = normalizeBillingRequest(body, 'chat/completions')
    expect(normalized).toEqual({ ...body, stream_options: { include_usage: true, provider_extension: 'keep' } })
    expect(body.stream_options.include_usage).toBe(false)
    expect(normalized.stream_options).not.toBe(body.stream_options)
  })

  it('adds a usage request when a chat streaming client omitted stream_options', () => {
    expect(normalizeBillingRequest({ stream: true }, 'chat/completions')).toEqual({ stream: true, stream_options: { include_usage: true } })
  })

  it.each(['messages', 'responses', 'systemone'])('preserves the native %s protocol fields', protocol => {
    const body = { stream: true, stream_options: { provider_extension: 'keep' }, input: 'hello' }
    expect(normalizeBillingRequest(body, protocol)).toEqual(body)
    expect(normalizeBillingRequest({ stream: true }, protocol)).toEqual({ stream: true })
  })

  it.each([false, undefined])('preserves nonstreaming chat requests (stream=%s)', stream => {
    const body = { stream, messages: [], stream_options: { include_usage: false } }
    expect(normalizeBillingRequest(body, 'chat/completions')).toEqual(body)
  })

  it('observes only provider supplied usage from JSON and SSE payloads', () => {
    const json = new BillingUsageObserver()
    json.push(new TextEncoder().encode('{"usage":{"prompt_tokens":12,"completion_tokens":3}}'))
    json.end()
    expect(json.value()).toEqual({ prompt_tokens: 12, completion_tokens: 3 })

    const stream = new BillingUsageObserver()
    stream.push(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'))
    stream.push(new TextEncoder().encode('data: {"usage":{"prompt_tokens":17,"completion_tokens":4}}\n\n'))
    stream.push(new TextEncoder().encode('data: [DONE]\n\n'))
    stream.end()
    expect(stream.value()).toEqual({ prompt_tokens: 17, completion_tokens: 4 })
  })
})
