/**
 * Whether a failed attempt may be retried on the next source or group. Only
 * failures that say "this source cannot serve the request right now" qualify:
 * credentials, access, missing model, rate limits and upstream/server errors.
 * Client mistakes (bad JSON, unsupported parameters) are returned as-is.
 */
// 413: another source (behind a different proxy) may accept a larger body.
const ALWAYS = new Set([401, 402, 403, 404, 408, 413, 429, 500, 502, 503, 504, 520, 521, 522, 524, 529])

export function isFailoverStatus(status: number): boolean {
  return ALWAYS.has(status)
}

/** A 400 is retried elsewhere only when it means "this source does not have the model"; a module may also decline explicitly. */
export function isFailoverResponse(status: number, body: string): boolean {
  if (isFailoverStatus(status)) return true
  // A pool module declining this kind of request (images, structured output, tools by policy).
  if (body.includes('nexus_source_unsupported')) return true
  return status === 400 && /model_not_found|unknown provider for model|model .*not (?:found|supported)|unsupported model/i.test(body)
}

export function errorMessageFrom(body: string): string {
  try {
    const value = JSON.parse(body) as Record<string, any>
    const message = value?.error?.message ?? value?.message ?? (typeof value?.error === 'string' ? value.error : null)
    if (typeof message === 'string' && message) return message.slice(0, 500)
  } catch { /* Plain-text error body. */ }
  return body.trim().slice(0, 500) || 'Upstream request failed'
}
