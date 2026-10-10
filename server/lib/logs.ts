import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import { redactSensitiveText } from '../../shared/log-privacy'
export interface RequestLogInput {
  id?: string; keyId: string | null; accountId: string | null; model: string
  moduleId?: string | null; sourceId?: string | null
  protocol: 'chat/completions' | 'messages' | 'responses' | 'systemone'; sessionId: string | null
  status: 'success' | 'error' | 'cancelled' | 'incomplete'; httpStatus: number | null
  durationMs: number; streaming: boolean; usage: Record<string, unknown> | null
  errorMessage: string | null; requestBody: unknown; responseBody: unknown; responseTruncated: boolean
}
export function redactLogFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactLogFields)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [redactSensitiveText(key), /^(authorization|proxy-authorization|cookie|set-cookie|(?:x-)?api[_-]?key|password|(?:access|refresh|session)[_-]?token)$/i.test(key) ? '[redacted]' : redactLogFields(item)]))
  return typeof value === 'string' ? redactSensitiveText(value) : value
}
// Unicode-mode matching excludes valid surrogate pairs (for example emoji).
// PostgreSQL JSONB rejects NUL and isolated surrogates in both keys and values.
function hasUnsupportedJsonbUnicode(value: unknown): boolean {
  const unsupported = /[\u0000\uD800-\uDFFF]/u
  if (typeof value === 'string') return unsupported.test(value)
  if (Array.isArray(value)) return value.some(hasUnsupportedJsonbUnicode)
  if (value && typeof value === 'object') return Object.entries(value).some(([key, item]) =>
    unsupported.test(key) || hasUnsupportedJsonbUnicode(item))
  return false
}
export async function insertRequestLog(input: RequestLogInput) {
  const db = getDb()
  const json = (value: unknown) => {
    if (value === null || value === undefined) return null
    const redacted = redactLogFields(value)
    return db.json((hasUnsupportedJsonbUnicode(redacted) ? {
      format: 'json-text', raw: JSON.stringify(redacted), reason: 'unsupported_jsonb_unicode',
    } : redacted) as any)
  }
  const id = input.id ?? randomUUID()
  const write = async (keyId: string | null, accountId: string | null) => {
    await db`INSERT INTO request_logs(id,key_id,account_id,module_id,source_id,model,protocol,session_id,status,http_status,duration_ms,streaming,usage,error_message,request_body,response_body,response_truncated)
      VALUES(${id},(SELECT id FROM gateway_keys WHERE id=${keyId}),(SELECT id FROM managed_accounts WHERE id=${accountId}),
      ${input.moduleId ?? null},${input.sourceId ?? null},${redactSensitiveText(input.model)},${input.protocol},${input.sessionId ? redactSensitiveText(input.sessionId) : input.sessionId},${input.status},${input.httpStatus},${input.durationMs},${input.streaming},
      ${json(input.usage)}::jsonb,${input.errorMessage ? redactSensitiveText(input.errorMessage) : input.errorMessage},${json(input.requestBody)}::jsonb,${json(input.responseBody)}::jsonb,${input.responseTruncated})
      ON CONFLICT(id) DO NOTHING`
  }
  try { await write(input.keyId, input.accountId) }
  catch (error) {
    // A referenced account/key can disappear while a request finishes. Keep the payload.
    if ((error as { code?: string }).code !== '23503') throw error
    await write(null, null)
  }
  return { id }
}
