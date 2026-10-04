import { makeProviderHeaders } from './gateway/transport'

/** Public API documented at https://commandcode.ai/docs/provider. */
export const COMMANDCODE_PROVIDER_URL = 'https://api.commandcode.ai/provider/v1'
export const PROVIDER_PROTOCOLS = ['chat/completions', 'messages', 'responses', 'systemone'] as const
export type ProviderProtocol = typeof PROVIDER_PROTOCOLS[number]

export interface ProviderRequest {
  protocol: ProviderProtocol
  body: Record<string, unknown>
  apiKey: string
  headers: Record<string, string | string[] | undefined>
  signal: AbortSignal
}
export interface ProviderTransportOptions {
  /** Server-owned configuration only; never take this value from an API request. */
  baseUrl?: string
  fetch?: typeof globalThis.fetch
  privacySecret?: string
}

export function providerEndpoint(baseUrl: string, protocol: ProviderProtocol): string {
  if (!PROVIDER_PROTOCOLS.includes(protocol)) throw new Error('Unsupported CommandCode Provider endpoint')
  const url = new URL(baseUrl)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('CommandCode API URL must be an HTTP(S) base URL without credentials, query or fragment')
  }
  return url.toString().replace(/\/$/, '') + '/' + protocol
}

/**
 * Inference uses the normal account API key. Browser cookies are only for
 * account management, and must never be copied to a model provider request.
 * This transport deliberately performs one attempt: the gateway owns leases,
 * proven-safe retry decisions, streaming inspection and cancellation.
 */
export async function requestCommandCodeProvider(request: ProviderRequest, options: ProviderTransportOptions = {}): Promise<Response> {
  const headers = makeProviderHeaders(request.headers, request.apiKey, options.privacySecret)
  if (request.protocol === 'messages' && !headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01')
  return (options.fetch || globalThis.fetch)(providerEndpoint(options.baseUrl || COMMANDCODE_PROVIDER_URL, request.protocol), {
    method: 'POST', headers, body: JSON.stringify(request.body), signal: request.signal, redirect: 'error',
  })
}

/** Only routes reported by the official catalog count as supported. */
export function normalizeSupportedEndpoints(value: unknown): ProviderProtocol[] {
  if (!Array.isArray(value)) return []
  const result = new Set<ProviderProtocol>()
  for (const endpoint of value) {
    if (typeof endpoint !== 'string') continue
    const path = endpoint.replace(/^https?:\/\/[^/]+/, '').replace(/^\/?(?:provider\/)?v1\//, '').replace(/^\//, '').replace(/\/$/, '')
    if (PROVIDER_PROTOCOLS.includes(path as ProviderProtocol)) result.add(path as ProviderProtocol)
  }
  return [...result]
}
