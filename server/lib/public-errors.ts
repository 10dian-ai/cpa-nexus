import { modelErrorShape } from './model-errors'

/**
 * What callers of the public model API may read in an error.
 *
 * CPAN resells capacity from several channels. Whatever produced an error —
 * the platform, CPA, a module or an upstream provider — the caller sees
 * English text that does not reveal where the request went: no URLs, hosts,
 * IP addresses or e-mail addresses, and no channel names (Logicc, Clerk, CPA,
 * bridge channels, provider integrations). Text that cannot be cleaned
 * (anything in Chinese) is replaced by a generic message for the status.
 * Administrators keep the full detail in request logs.
 */
export const HIDDEN = '***'

const CJK = /[⺀-鿿豈-﫿︰-﹏＀-￯]/
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi
const IP = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{2,5})?\b/g
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
const HOST = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|net|org|io|ai|top|dev|app|cn|co|xyz|cloud|services|sh|me|us|so|gg|tech|site|online|info|biz|link|run|page|pro|vip|cc|tv|in|jp|hk|tw|uk|de|eu|live|world|work|fun|icu|club|space|store|network|systems|internal|local|lan)\b(?::\d{2,5})?(?:\/[^\s"'<>`]*)?/gi
/** Channel and integration names, wherever they appear (also inside codes such as `logicc_unavailable`). */
const CHANNELS = /logicc|clerk|cliproxyapi|cli-proxy-api|windsurf|codeium|antigravity|iflow|kiro|devin|vertex|aistudio|ai-studio|gemini-cli|openai-compatibility|claude-code-api|nexus-[\w-]*|ccm_[\w-]*|x-nexus-[\w-]*|nexus_[\w]*/gi

const CHANNEL_TEST = new RegExp(CHANNELS.source, 'i')
const HOST_TEST = new RegExp(HOST.source, 'i')

const FALLBACK: Record<number, string> = {
  400: 'Invalid request',
  401: 'Authentication failed',
  402: 'Insufficient quota',
  403: 'Permission denied',
  404: 'The requested model is not available for this API key',
  408: 'Request timed out',
  409: 'Request conflict',
  413: 'Request too large',
  415: 'Unsupported request encoding',
  422: 'The request could not be processed',
  429: 'Rate limit reached, please retry later',
  499: 'Request cancelled',
  500: 'Internal server error',
  502: 'Upstream service error, please retry',
  503: 'Service temporarily unavailable, please retry later',
  504: 'Upstream service timed out, please retry',
}
export function fallbackMessage(status: number): string {
  return FALLBACK[status] || (status >= 500 ? 'Service temporarily unavailable, please retry later' : 'Request failed')
}

/** Remove addresses and channel names from free text. */
export function scrubPublicText(value: string): string {
  return value
    .replace(/\blogicc\//gi, '')
    .replace(URL, HIDDEN).replace(EMAIL, HIDDEN).replace(IP, HIDDEN).replace(HOST, HIDDEN)
    .replace(CHANNELS, HIDDEN)
    .replace(/\bCPA\b/g, 'gateway')
    .replace(/\*{3}(?:[/._:-]*\*{3})+/g, HIDDEN)
}

/** An error message fit for API callers. */
export function publicErrorMessage(message: unknown, status: number): string {
  const text = typeof message === 'string' ? scrubPublicText(message).trim() : ''
  if (!text || CJK.test(text) || text.replace(/[\s*.:,;()[\]{}-]/g, '') === '') return fallbackMessage(status)
  return text.length > 300 ? text.slice(0, 297) + '...' : text
}

/** An error code fit for API callers: plain identifiers only, never a channel name. */
export function publicErrorCode(code: unknown, status: number): string | number | null {
  if (typeof code === 'number') return code
  if (typeof code !== 'string') return code == null ? null : modelErrorShape(status).code
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(code) || CHANNEL_TEST.test(code) || HOST_TEST.test(code)) return modelErrorShape(status).code
  return code
}

const MESSAGE_KEYS = new Set(['message', 'long_message', 'detail', 'details_message', 'error_description', 'reason_message'])
const CODE_KEYS = new Set(['code', 'type', 'status', 'reason', 'domain'])

function clean(value: unknown, status: number, key: string, depth: number): unknown {
  if (depth > 12) return undefined
  if (typeof value === 'string') {
    if (MESSAGE_KEYS.has(key) || key === 'error') return publicErrorMessage(value, status)
    if (CODE_KEYS.has(key)) return publicErrorCode(value, status)
    const text = scrubPublicText(value)
    return CJK.test(text) ? HIDDEN : text
  }
  if (Array.isArray(value)) return value.map(item => clean(item, status, key, depth + 1))
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [name, item] of Object.entries(value)) {
      // Provider metadata (Gemini `details`, `metadata`, request IDs of upstreams) adds nothing for callers.
      if (name === 'metadata' || name === 'request_id' && depth > 0 || name === 'upstream' || name === 'provider') continue
      const next = clean(item, status, name, depth + 1)
      if (next !== undefined) result[scrubPublicText(name)] = next
    }
    return result
  }
  return value
}

/** Clean every string in an error payload (OpenAI, Anthropic, Gemini and Responses shapes). */
export function publicErrorPayload<T>(value: T, status: number): T {
  return clean(value, status, '', 0) as T
}

/** A complete error body as received from upstream, cleaned for callers. */
export function publicErrorBody(text: string, status: number): string {
  try {
    const value = JSON.parse(text) as unknown
    if (value && typeof value === 'object') return JSON.stringify(publicErrorPayload(value, status))
    if (typeof value === 'string') return JSON.stringify(publicErrorMessage(value, status))
  } catch { /* Plain-text body. */ }
  return publicErrorMessage(text, status)
}
