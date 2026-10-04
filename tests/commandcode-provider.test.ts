import { describe, expect, it, vi } from 'vitest'
import { COMMANDCODE_PROVIDER_URL, normalizeSupportedEndpoints, providerEndpoint, requestCommandCodeProvider } from '../server/lib/commandcode-provider'
import { privateSessionId } from '../server/lib/privacy-headers'

describe('official CommandCode Provider transport', () => {
  it('calls the official native endpoint using the selected account API key and preserves request shape', async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
    const controller = new AbortController()
    const body = { model: 'provider/new-model', stream: true, messages: [{ role: 'user', content: 'hello' }], tools: [{ type: 'function', function: { name: 'example' } }] }
    await requestCommandCodeProvider({ protocol: 'chat/completions', body, apiKey: 'selected-account-key', headers: {
      authorization: 'Bearer client-gateway-key', cookie: 'session=browser-secret', 'x-api-key': 'client-api-key',
      'x-cmd-zdr': '1', 'openai-beta': 'responses=experimental', 'x-session-id': 'conversation',
    }, signal: controller.signal }, { fetch: upstream, privacySecret: 'test-only-privacy-secret' })
    expect(upstream).toHaveBeenCalledTimes(1)
    const [url, options] = upstream.mock.calls[0]!
    expect(url).toBe(COMMANDCODE_PROVIDER_URL + '/chat/completions')
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', signal: controller.signal })
    expect(JSON.parse(options!.body as string)).toEqual(body)
    const headers = options!.headers as Headers
    expect(headers.get('authorization')).toBe('Bearer selected-account-key')
    expect(headers.get('cookie')).toBeNull()
    expect(headers.get('x-api-key')).toBeNull()
    expect(headers.get('x-cmd-zdr')).toBe('1')
    expect(headers.get('openai-beta')).toBe('responses=experimental')
    expect(headers.get('x-session-id')).toBe(privateSessionId('conversation', 'test-only-privacy-secret'))
    expect(headers.get('user-agent')).toBe('opencode')
  })
  it('supports Messages, Responses and System One without format conversion or credentials from cookies', async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
    for (const protocol of ['messages', 'responses', 'systemone'] as const) {
      await requestCommandCodeProvider({ protocol, body: { model: 'fixture/model' }, apiKey: 'account-key', headers: {}, signal: new AbortController().signal }, {
        baseUrl: 'http://127.0.0.1:9000/provider/v1/', fetch: upstream,
      })
    }
    expect(upstream.mock.calls.map(call => call[0])).toEqual([
      'http://127.0.0.1:9000/provider/v1/messages', 'http://127.0.0.1:9000/provider/v1/responses', 'http://127.0.0.1:9000/provider/v1/systemone',
    ])
    expect((upstream.mock.calls[0]![1]!.headers as Headers).get('anthropic-version')).toBe('2023-06-01')
  })
  it('does not retry an upstream rejection or a connection failure', async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{"error":{"code":"upgrade_required"}}', { status: 403 })).mockRejectedValueOnce(new Error('connection failed'))
    const input = { protocol: 'responses' as const, body: { model: 'fixture/model' }, apiKey: 'key', headers: {}, signal: new AbortController().signal }
    expect((await requestCommandCodeProvider(input, { fetch: upstream })).status).toBe(403)
    await expect(requestCommandCodeProvider(input, { fetch: upstream })).rejects.toThrow('connection failed')
    expect(upstream).toHaveBeenCalledTimes(2)
  })
  it('rejects malformed server base URLs before transmitting credentials', () => {
    for (const url of ['file:///tmp/provider', 'https://user:password@api.commandcode.ai/provider/v1', 'https://api.commandcode.ai/provider/v1?target=other', 'https://api.commandcode.ai/provider/v1#hash']) {
      expect(() => providerEndpoint(url, 'messages')).toThrow()
    }
  })
  it('normalizes official supported endpoints without inferring routes from model names', () => {
    expect(normalizeSupportedEndpoints(['/v1/messages', '/provider/v1/responses', 'chat/completions', 'https://api.commandcode.ai/provider/v1/systemone', '/v1/messages', '/v1/unknown'])).toEqual([
      'messages', 'responses', 'chat/completions', 'systemone',
    ])
    expect(normalizeSupportedEndpoints(null)).toEqual([])
    expect(normalizeSupportedEndpoints('claude-test')).toEqual([])
  })
})
