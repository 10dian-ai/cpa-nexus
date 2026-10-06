type JsonObject = Record<string, unknown>

export const BILLING_USAGE_POLICY_HEADER = 'x-nexus-usage-policy'
export const BILLING_USAGE_POLICY = 'upstream'

/**
 * Request the provider's usage for the final, preset-expanded prompt. Relays
 * such as New API can then bill the same input the provider actually received,
 * instead of estimating only the client's original messages. Never synthesize
 * token counts: Messages and Responses already carry their own usage fields.
 */
export function normalizeBillingRequest(body: JsonObject, protocol: string): JsonObject {
  if (protocol !== 'chat/completions' || body.stream !== true) return { ...body }
  const value = body.stream_options
  const options = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : {}
  return { ...body, stream_options: { ...options, include_usage: true } }
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

/** Observes provider usage while a response is piped byte-for-byte to the client. */
export class BillingUsageObserver {
  private frame = ''
  private decoder = new TextDecoder()
  private current: JsonObject | null = null

  private observe(value: unknown) {
    const data = object(value)
    if (!data) return
    const usage = object(data.usage)
    if (usage && Object.keys(usage).length) this.current = { ...(this.current || {}), ...usage }
    for (const nested of [data.response, data.message]) this.observe(nested)
  }

  private consume(frame: string) {
    const lines = frame.split(/\r?\n/)
    const payload = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    const raw = payload || frame.trim()
    if (!raw || raw === '[DONE]') return
    try { this.observe(JSON.parse(raw)) } catch { /* Unknown provider frames stay opaque. */ }
  }

  push(chunk: Uint8Array) {
    this.frame += this.decoder.decode(chunk, { stream: true })
    while (true) {
      const boundary = /\r?\n\r?\n/.exec(this.frame)
      if (!boundary) break
      this.consume(this.frame.slice(0, boundary.index))
      this.frame = this.frame.slice(boundary.index + boundary[0].length)
    }
    // A malformed or unusually large frame must not turn billing observation
    // into an unbounded response buffer.
    if (this.frame.length > 2 * 1024 * 1024) this.frame = this.frame.slice(-2 * 1024 * 1024)
  }

  end() {
    this.frame += this.decoder.decode()
    if (this.frame.trim()) this.consume(this.frame)
    this.frame = ''
  }

  value() { return this.current }
}
