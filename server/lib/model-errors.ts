import { redactLogValue } from '../../shared/log-privacy'

/**
 * Protocol-shaped error bodies for the public model endpoints.
 *
 * OpenAI-compatible clients (chat/completions, responses, models) read
 * `error.type` / `error.code`; Anthropic clients (messages) read
 * `error.type`. Before this helper every platform-side rejection was
 * reported as `invalid_request_error` / `preset_route_error`, so a missing
 * key, a group without the model or a stopped kernel all looked like a
 * SillyTavern preset failure. The type and code now follow the HTTP status,
 * and callers may still pass an explicit code for a more specific reason.
 */
export interface ModelErrorShape { type: string; code: string }

const OPENAI_BY_STATUS: Record<number, ModelErrorShape> = {
  400: { type: 'invalid_request_error', code: 'invalid_request' },
  401: { type: 'authentication_error', code: 'invalid_api_key' },
  403: { type: 'permission_error', code: 'permission_denied' },
  404: { type: 'invalid_request_error', code: 'model_not_found' },
  409: { type: 'invalid_request_error', code: 'conflict' },
  413: { type: 'invalid_request_error', code: 'request_too_large' },
  415: { type: 'invalid_request_error', code: 'unsupported_media_type' },
  429: { type: 'rate_limit_error', code: 'rate_limit_exceeded' },
  502: { type: 'server_error', code: 'upstream_error' },
  503: { type: 'server_error', code: 'service_unavailable' },
  504: { type: 'server_error', code: 'upstream_timeout' },
}
const ANTHROPIC_BY_STATUS: Record<number, string> = {
  400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error',
  409: 'invalid_request_error', 413: 'request_too_large', 415: 'invalid_request_error', 429: 'rate_limit_error',
}

export function modelErrorShape(status: number): ModelErrorShape {
  return OPENAI_BY_STATUS[status]
    || (status >= 500 ? { type: 'server_error', code: 'server_error' } : { type: 'invalid_request_error', code: 'invalid_request' })
}

/** Anthropic-style protocols are `messages` and its sub-endpoints such as `messages/count_tokens`. */
export function isAnthropicProtocol(protocol: string): boolean {
  return protocol === 'messages' || protocol.startsWith('messages/')
}

export function modelErrorBody(protocol: string, status: number, message: string, code?: string): Record<string, unknown> {
  if (isAnthropicProtocol(protocol)) {
    const type = ANTHROPIC_BY_STATUS[status] || (status === 503 || status === 529 ? 'overloaded_error' : 'api_error')
    return redactLogValue({ type: 'error', error: { type, message } }) as Record<string, unknown>
  }
  const shape = modelErrorShape(status)
  return redactLogValue({ error: { type: shape.type, code: code || shape.code, message } }) as Record<string, unknown>
}
