export const MAX_RESPONSE_LOG_BYTES = 8 * 1024 * 1024

/** Bounded copy of a model response for request logs. */
export class ResponseCapture {
  private parts: Buffer[] = []
  private bytes = 0
  truncated = false
  constructor(private limit = MAX_RESPONSE_LOG_BYTES) {}
  push(chunk: Uint8Array) {
    const remaining = this.limit - this.bytes
    if (chunk.byteLength > remaining) this.truncated = true
    if (remaining > 0) {
      const part = Buffer.from(chunk.subarray(0, remaining))
      this.parts.push(part)
      this.bytes += part.byteLength
    }
  }
  text() { return Buffer.concat(this.parts).toString('utf8') }
  value(streaming: boolean): unknown {
    const raw = this.text()
    if (!streaming && !this.truncated) {
      try { return JSON.parse(raw) } catch { /* Non-JSON upstream errors remain readable. */ }
    }
    return { format: streaming ? 'sse' : 'text', raw, truncated: this.truncated }
  }
}