import { logiccApiBase } from './config'
import { accountToken } from './credentials'
import { LogiccError, classifyLogiccStatus, networkFailure } from './errors'
import { normalizeModels } from './store'
import type { LogiccModel } from '../../../shared/logicc'

/**
 * Logicc's web API, as used by its own web app:
 *   GET  /api/models?language=en         model catalog of the signed-in account
 *   POST /api/chats                       create a chat → id
 *   POST /api/chats/{id}                  generate; `Stream-Response-Protocol: ai-sdk-v6`
 *                                         streams Vercel AI SDK v6 UI-message events (SSE)
 * Every call carries `Authorization: Bearer <session JWT>`. A 401 is retried
 * once with a freshly minted JWT before it counts as a credential failure.
 */
async function call(accountId: string, path: string, init: { method?: string; body?: unknown; stream?: boolean; signal?: AbortSignal }, operation: string): Promise<Response> {
  const base = logiccApiBase()
  for (let attempt = 0; ; attempt++) {
    const token = await accountToken(accountId, { force: attempt > 0 })
    let response: Response
    try {
      response = await fetch(`${base}/${path}`, {
        method: init.method || 'GET', redirect: 'manual', signal: init.signal,
        headers: {
          authorization: `Bearer ${token}`,
          accept: init.stream ? 'text/event-stream' : 'application/json',
          ...(init.stream ? { 'stream-response-protocol': 'ai-sdk-v6' } : {}),
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      })
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason ?? error
      throw networkFailure(error, new URL(base).hostname)
    }
    if (response.status === 401 && attempt === 0) { await response.body?.cancel().catch(() => {}); continue }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw classifyLogiccStatus(response.status, text, operation)
    }
    return response
  }
}

export async function fetchModels(accountId: string, signal?: AbortSignal): Promise<LogiccModel[]> {
  const response = await call(accountId, 'models?language=en', { signal }, '模型目录')
  let payload: unknown
  try { payload = await response.json() } catch { throw new LogiccError('upstream', 502, 'Logicc 模型目录格式不正确') }
  const list = Array.isArray(payload) ? payload : (payload as { models?: unknown; data?: unknown })?.models ?? (payload as { data?: unknown })?.data
  if (!Array.isArray(list)) throw new LogiccError('upstream', 502, 'Logicc 模型目录格式不正确')
  return normalizeModels(list.map(item => {
    const model = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const provider = model.provider
    return { id: model.id ?? model.modelId, name: model.name, isDefault: model.isDefault,
      provider: typeof provider === 'string' ? provider : provider && typeof provider === 'object' ? (provider as { name?: unknown }).name : undefined }
  }))
}

export async function createChat(accountId: string, signal?: AbortSignal): Promise<string> {
  const response = await call(accountId, 'chats', { method: 'POST', body: {}, signal }, '创建会话')
  const value = await response.json().catch(() => null) as unknown
  const id = typeof value === 'string' ? value : (value as { id?: unknown } | null)?.id
  if (typeof id !== 'string' || !id || id.length > 200) throw new LogiccError('upstream', 502, 'Logicc 创建会话没有返回 ID')
  return id
}

export interface GenerateInput { modelId: string; prompt: string; reasoningEffort?: string; forcedTool?: string }
export async function generate(accountId: string, chatId: string, input: GenerateInput, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const response = await call(accountId, `chats/${encodeURIComponent(chatId)}`, {
    method: 'POST', stream: true, signal,
    body: { modelId: input.modelId, prompt: input.prompt, isVoicePrompt: false,
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
      ...(input.forcedTool ? { forcedTool: input.forcedTool } : {}) },
  }, '生成')
  if (!response.body) throw new LogiccError('upstream', 502, 'Logicc 没有返回数据流')
  return response.body
}

/** Vercel AI SDK v6 UI-message stream event. Only fields this module reads are typed. */
export interface AiSdkEvent {
  type: string
  delta?: string; id?: string; toolCallId?: string; toolName?: string; input?: unknown; inputTextDelta?: string
  output?: unknown; errorText?: string; providerExecuted?: boolean; finishReason?: string
  messageMetadata?: Record<string, unknown>; usage?: unknown; totalUsage?: unknown
}

/** Parse the SSE event stream into AI SDK events. Malformed frames fail the generation. */
export async function* parseAiSdkStream(body: ReadableStream<Uint8Array>, limitBytes = 64 * 1024 * 1024): AsyncGenerator<AiSdkEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  let total = 0
  const parse = (frame: string): AiSdkEvent | null => {
    const text = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim()
    if (!text || text === '[DONE]') return null
    let value: unknown
    try { value = JSON.parse(text) } catch { throw new LogiccError('upstream', 502, 'Logicc 返回了无法解析的数据流') }
    return value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string' ? value as AiSdkEvent : null
  }
  const reader = body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limitBytes) throw new LogiccError('upstream', 502, 'Logicc 输出超过单次响应上限')
      buffer += decoder.decode(value, { stream: true })
      let separator: RegExpExecArray | null
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const event = parse(buffer.slice(0, separator.index))
        buffer = buffer.slice(separator.index + separator[0].length)
        if (event) yield event
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) { const event = parse(buffer); if (event) yield event }
  } finally {
    reader.releaseLock()
    await body.cancel().catch(() => {})
  }
}

/** Token usage when Logicc reports it (rare); token counts in either AI SDK or OpenAI shape. */
export function reportedUsage(event: AiSdkEvent): { input: number; output: number } | null {
  const usage = (event.totalUsage ?? event.usage ?? event.messageMetadata?.usage ?? event.messageMetadata?.totalUsage) as Record<string, unknown> | undefined
  if (!usage || typeof usage !== 'object') return null
  const number = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    const total = (value as { total?: unknown } | null)?.total
    return typeof total === 'number' && Number.isFinite(total) ? total : undefined
  }
  const input = number(usage.inputTokens) ?? number(usage.prompt_tokens) ?? number(usage.input_tokens)
  const output = number(usage.outputTokens) ?? number(usage.completion_tokens) ?? number(usage.output_tokens)
  return input !== undefined && output !== undefined && input >= 0 && output >= 0 ? { input, output } : null
}
