/**
 * What actually happened inside a response, for request logs. An HTTP 200
 * stream can still carry an error event or stop without a completion marker;
 * those used to be logged as successes.
 */
const decoder = () => new TextDecoder()
const COMPLETION_EVENTS = /^(?:message_stop|response\.completed|response\.done)$/
const ERROR_EVENTS = /^(?:error|response\.failed|response\.incomplete|.*[._-]error)$/i

export class StreamOutcome {
  private buffer = ''
  private text = decoder()
  private body = ''
  /** An error event or error payload was seen. */
  errorMessage: string | null = null
  /** A protocol completion marker was seen (stream) or a full body arrived (non-stream). */
  completed = false
  /** The client disconnected before the end. */
  cancelled = false

  constructor(private readonly status: number, private readonly streaming: boolean) {}

  push(chunk: Uint8Array) {
    const value = this.text.decode(chunk, { stream: true })
    if (!this.streaming) { if (this.body.length < 256 * 1024) this.body += value; return }
    this.buffer += value
    let boundary: RegExpExecArray | null
    while ((boundary = /\r?\n\r?\n/.exec(this.buffer))) {
      this.frame(this.buffer.slice(0, boundary.index))
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length)
    }
    if (this.buffer.length > 1024 * 1024) this.buffer = this.buffer.slice(-1024 * 1024)
  }

  end() {
    const tail = this.text.decode()
    if (!this.streaming) {
      this.body += tail
      this.completed = this.status < 400
      if (this.status >= 400 || /^\s*\{\s*"(?:error|type"\s*:\s*"error)/.test(this.body)) this.errorMessage = this.messageFrom(this.body) || 'Upstream returned an error'
      return
    }
    this.buffer += tail
    if (this.buffer.trim()) this.frame(this.buffer)
    this.buffer = ''
  }

  private frame(frame: string) {
    const lines = frame.split(/\r?\n/)
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim() || ''
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    if (data === '[DONE]') { this.completed = true; return }
    if (COMPLETION_EVENTS.test(event)) this.completed = true
    let payload: Record<string, unknown> | null = null
    try { const parsed = JSON.parse(data); payload = parsed && typeof parsed === 'object' ? parsed : null } catch { /* Opaque frame. */ }
    const type = typeof payload?.type === 'string' ? payload.type : ''
    if (COMPLETION_EVENTS.test(type)) this.completed = true
    const choices = Array.isArray(payload?.choices) ? payload!.choices as Array<Record<string, unknown>> : []
    if (choices.some(choice => typeof choice?.finish_reason === 'string' && choice.finish_reason)) this.completed = true
    if (ERROR_EVENTS.test(event) || ERROR_EVENTS.test(type) || (payload && payload.error)) {
      this.errorMessage ??= this.messageFrom(data) || 'Upstream stream reported an error'
    }
  }

  private messageFrom(raw: string): string | null {
    try {
      const value = JSON.parse(raw) as Record<string, any>
      const message = value?.error?.message ?? value?.response?.error?.message ?? value?.message ?? (typeof value?.error === 'string' ? value.error : null)
      return typeof message === 'string' && message ? message.slice(0, 1000) : null
    } catch { return raw.trim() ? raw.trim().slice(0, 1000) : null }
  }

  /** Log status: success, error (HTTP or in-stream), cancelled or incomplete. */
  logStatus(httpStatus: number): 'success' | 'error' | 'cancelled' | 'incomplete' {
    if (httpStatus >= 400 || this.errorMessage) return 'error'
    if (this.cancelled) return 'cancelled'
    if (this.streaming && !this.completed) return 'incomplete'
    return 'success'
  }
}
