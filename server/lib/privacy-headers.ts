import { createHmac } from 'node:crypto'

export const PRIVATE_CLIENT_NAME = 'opencode'
type HeaderBag = Record<string, string | string[] | undefined>
const SESSION_HEADERS = ['x-session-id', 'session_id', 'x-claude-code-session-id', 'x-codex-session-id']
const PRIVATE_HEADERS = new Set([
  ...SESSION_HEADERS, 'cookie', 'origin', 'referer', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
  'traceparent', 'tracestate', 'baggage', 'x-request-id', 'client-request-id', 'x-client-request-id',
  'x-agent-id', 'x-subagent-id', 'x-app', 'x-goog-api-client', 'anthropic-dangerous-direct-browser-access',
  'x-device-id', 'x-client-device-id', 'x-client-id', 'x-project-id', 'x-workspace-id',
  'x-originator', 'x-openai-originator', 'x-requested-with', 'sec-ch-ua', 'sec-ch-ua-platform', 'sec-ch-ua-mobile',
  'cf-connecting-ip', 'true-client-ip', 'x-client-ip', 'x-original-forwarded-for', 'x-envoy-external-address', 'sentry-trace',
])
function privateHeader(name: string) {
  return PRIVATE_HEADERS.has(name) || /^(?:x-stainless-|x-claude-code-|x-opencode-|x-client-|x-device-|x-openai-client-|x-sentry-|x-datadog-)/.test(name)
    || (/^x-codex-/.test(name) && name !== 'x-codex-turn-state')
}
export function privateSessionId(value: string, secret: string): string {
  return 'session-' + createHmac('sha256', secret).update('cpa-nexus:private-session:v1\0').update(value).digest('hex')
}
/** Software identity is normalized; authentication and required protocol fields stay intact. */
export function privacyHeaders(input: HeaderBag, sessionSecret?: string): HeaderBag {
  const headers: HeaderBag = {}
  const normalized = Object.fromEntries(Object.entries(input).map(([name, value]) => [name.toLowerCase(), value]))
  for (const [name, value] of Object.entries(normalized)) if (!privateHeader(name)) headers[name] = value
  headers['user-agent'] = PRIVATE_CLIENT_NAME
  headers.originator = PRIVATE_CLIENT_NAME
  const beta = normalized['anthropic-beta']
  if (typeof beta === 'string') {
    const features = beta.split(',').map(feature => feature.trim()).filter(feature => feature && !/^claude-code-/i.test(feature))
    if (features.length) headers['anthropic-beta'] = features.join(',')
    else delete headers['anthropic-beta']
  }
  const session = SESSION_HEADERS.map(name => normalized[name]).find((value): value is string => typeof value === 'string' && !!value)
  if (session && sessionSecret) {
    const value = privateSessionId(session, sessionSecret)
    headers['x-session-id'] = value
    if (normalized.session_id) headers.session_id = value
  }
  for (const name of ['x-agent-id', 'x-subagent-id']) {
    const value = normalized[name]
    if (typeof value === 'string' && value && sessionSecret) headers[name] = privateSessionId(name + '\0' + value, sessionSecret)
  }
  return headers
}
