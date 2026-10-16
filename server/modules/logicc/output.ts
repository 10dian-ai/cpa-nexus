import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { ToolCall } from './prompt'
import type { ComputedUsage } from './tokens'

/**
 * Writes one OpenAI Chat Completions response, streamed or complete. The
 * caller decides when to commit: until then nothing has reached the client
 * and the request can still move to another account.
 */
export class ChatOutput {
  readonly id = 'chatcmpl-' + randomUUID().replaceAll('-', '')
  readonly created = Math.floor(Date.now() / 1000)
  private heartbeat: ReturnType<typeof setInterval> | undefined
  committed = false

  constructor(private readonly res: ServerResponse, private readonly model: string, private readonly stream: boolean) {}

  private send(data: unknown) {
    if (this.res.destroyed || this.res.writableEnded) return
    this.res.write(`data: ${JSON.stringify(data)}\n\n`)
  }
  private chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
    return { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason: finishReason }] }
  }

  /** Send headers. After this, failures are reported in-band instead of moving to another account. */
  commit() {
    // A complete (non-stream) response sends nothing early, so it stays retryable until finish.
    if (this.committed || !this.stream) return
    this.committed = true
    this.res.statusCode = 200
    this.res.setHeader('content-type', 'text/event-stream; charset=utf-8')
    this.res.setHeader('cache-control', 'no-cache')
    this.res.setHeader('x-accel-buffering', 'no')
    this.send(this.chunk({ role: 'assistant', content: '' }))
    this.heartbeat = setInterval(() => { if (!this.res.destroyed && !this.res.writableEnded) this.res.write(': keep-alive\n\n') }, 15_000)
    this.heartbeat.unref()
  }

  content(delta: string) {
    if (delta && this.stream) this.send(this.chunk({ content: delta }))
  }
  reasoningDelta(delta: string) {
    if (delta && this.stream) this.send(this.chunk({ reasoning_content: delta }))
  }

  finish(result: { text: string; reasoning: string; calls: ToolCall[]; finishReason: string; usage: ComputedUsage['usage'] }, bufferedText: boolean) {
    this.dispose()
    const calls = result.calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }))
    const finishReason = calls.length ? 'tool_calls' : result.finishReason
    if (this.stream) {
      // Tool mode buffers the model output; its text is sent once parsed.
      if (bufferedText && result.text) this.send(this.chunk({ content: result.text }))
      calls.forEach((call, index) => {
        this.send(this.chunk({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] }))
        this.send(this.chunk({ tool_calls: [{ index, function: { arguments: call.function.arguments } }] }))
      })
      this.send(this.chunk({}, finishReason))
      // Always report usage, even unrequested: the billing relay depends on it.
      this.send({ id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [], usage: result.usage })
      this.res.end('data: [DONE]\n\n')
      return
    }
    // Only the successful attempt's output: earlier accounts may have produced partial text.
    const text = result.text
    this.res.statusCode = 200
    this.res.setHeader('content-type', 'application/json; charset=utf-8')
    this.res.setHeader('cache-control', 'no-store')
    this.res.end(JSON.stringify({
      id: this.id, object: 'chat.completion', created: this.created, model: this.model,
      choices: [{ index: 0, finish_reason: finishReason, message: {
        role: 'assistant', content: text || (calls.length ? null : ''),
        ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
        ...(calls.length ? { tool_calls: calls } : {}),
      } }],
      usage: result.usage,
    }))
  }

  /** In-band failure after commit (streaming only). */
  fail(message: string, code: string) {
    this.dispose()
    if (this.res.destroyed || this.res.writableEnded) return
    if (this.stream) {
      this.send({ error: { message, type: 'api_error', code } })
      this.res.end('data: [DONE]\n\n')
    } else this.res.destroy()
  }

  dispose() { if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = undefined }
}

/** An error response before anything was committed. */
export function sendChatError(res: ServerResponse, status: number, message: string, code: string, retryAfter?: number) {
  if (res.headersSent || res.destroyed || res.writableEnded) return
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  if (retryAfter) res.setHeader('retry-after', String(retryAfter))
  const type = status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 429 ? 'rate_limit_error' : status < 500 ? 'invalid_request_error' : 'api_error'
  res.end(JSON.stringify({ error: { message, type, code } }))
}
