import { randomUUID } from 'node:crypto'
import { LogiccError } from './errors'

/**
 * Logicc generates from a single prompt per chat. CPA hands this module an
 * OpenAI Chat Completions request (it converts Messages/Responses/Gemini
 * first), which is flattened here into one prompt. Client function tools are
 * described in the prompt as a JSON envelope contract and the model's answer
 * is parsed back into standard `tool_calls`; nothing is executed here.
 * Ported from logicc2api (MIT) and reduced to the Chat input path.
 */
type Json = Record<string, unknown>
const object = (value: unknown): value is Json => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = (message: string): never => { throw new LogiccError('client', 400, message) }
const unsupported = (message: string): never => { throw new LogiccError('unsupported', 422, message) }

export interface ChatMessage { role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string; tool_calls?: HistoryCall[] }
export interface HistoryCall { id: string; name: string; arguments: Json }
export interface ToolDefinition { name: string; description: string; parameters: Json }
export interface ToolCall { id: string; name: string; arguments: Json }
export interface NormalizedChat {
  model: string; stream: boolean; includeUsage: boolean
  messages: ChatMessage[]; maxTokens?: number; reasoning?: string
  tools: ToolDefinition[]; activeTools: ToolDefinition[]; choice: string; required: boolean; parallel: boolean
  /** Logicc built-in tool forced by the request (`web-search`, `image-generation`). */
  forcedTool?: string
}

function textContent(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) invalid('content 必须为文本或内容块数组')
  return (content as unknown[]).map(part => {
    const item = object(part) ? part : {}
    if (['text', 'input_text', 'output_text'].includes(String(item.type)) && typeof item.text === 'string') return item.text
    if (item.type === 'refusal' && typeof item.refusal === 'string') return item.refusal
    if (['thinking', 'redacted_thinking', 'reasoning'].includes(String(item.type))) return ''
    // Images, audio and files cannot be forwarded to Logicc's single text prompt.
    return unsupported(`Logicc 不支持 ${String(item.type || 'unknown')} 类型的内容，已交给其他来源处理`)
  }).filter(Boolean).join('\n')
}

function argumentsObject(value: unknown): Json {
  let parsed = value
  if (typeof value === 'string') {
    if (!value.trim()) return {}
    try { parsed = JSON.parse(value) } catch { invalid('历史工具调用的 arguments 不是有效 JSON') }
  }
  if (!object(parsed)) invalid('历史工具调用的 arguments 必须为 JSON 对象')
  return parsed as Json
}

function historyCall(call: unknown): HistoryCall {
  if (!object(call)) invalid('工具调用必须为对象')
  const value = call as Json
  const fn = object(value.function) ? value.function : value
  const id = typeof value.id === 'string' && value.id.trim() ? value.id : invalid('tool call id 不能为空')
  const name = typeof fn.name === 'string' && fn.name.trim() ? fn.name : invalid('tool name 不能为空')
  return { id: id as string, name: name as string, arguments: argumentsObject(fn.arguments ?? fn.input ?? {}) }
}

function messagesFrom(input: unknown): ChatMessage[] {
  if (!Array.isArray(input) || !input.length) invalid('messages 需要非空数组')
  return (input as unknown[]).map(raw => {
    if (!object(raw) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(String(raw.role))) invalid('消息 role 不正确')
    const message = raw as Json
    const normalized: ChatMessage = { role: message.role as ChatMessage['role'], content: textContent(message.content) }
    if (message.role === 'tool') normalized.tool_call_id = typeof message.tool_call_id === 'string' && message.tool_call_id ? message.tool_call_id : invalid('tool 消息缺少 tool_call_id')
    if (message.tool_calls !== undefined && message.tool_calls !== null) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) invalid('tool_calls 必须位于 assistant 消息中')
      if ((message.tool_calls as unknown[]).length) normalized.tool_calls = (message.tool_calls as unknown[]).map(historyCall)
    }
    return normalized
  })
}

const BUILTIN_TOOLS: Record<string, string> = { web_search: 'web-search', 'web-search': 'web-search', web_search_preview: 'web-search', image_generation: 'image-generation', 'image-generation': 'image-generation' }

function toolsFrom(body: Json) {
  if (body.tools !== undefined && body.tools !== null && !Array.isArray(body.tools)) invalid('tools 必须为数组')
  const list = (body.tools as unknown[] | undefined) || []
  if (list.length > 256) invalid('最多支持 256 个工具')
  const tools: ToolDefinition[] = []
  const builtins: string[] = []
  for (const raw of list) {
    if (!object(raw)) invalid('工具定义必须为对象')
    const tool = raw as Json
    const fn = (tool.type === 'function' || tool.type === undefined) && object(tool.function) ? tool.function : tool
    const name = typeof fn.name === 'string' ? fn.name : ''
    if (BUILTIN_TOOLS[String(tool.type)] || BUILTIN_TOOLS[name]) { builtins.push(BUILTIN_TOOLS[String(tool.type)] || BUILTIN_TOOLS[name]!); continue }
    if (tool.type !== undefined && tool.type !== 'function') invalid(`不支持的工具类型：${String(tool.type)}`)
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(name)) invalid('工具名称格式不正确')
    if (tools.some(item => item.name === name)) invalid('工具名称不能重复')
    if (fn.parameters !== undefined && !object(fn.parameters)) invalid('工具 parameters 必须为对象')
    tools.push({ name, description: typeof fn.description === 'string' ? fn.description : '', parameters: (fn.parameters as Json) || { type: 'object', properties: {} } })
  }
  let choice: unknown = body.tool_choice ?? 'auto'
  if (object(choice)) choice = object(choice.function) ? choice.function.name : choice.name ?? choice.type
  if (typeof choice !== 'string') invalid('tool_choice 不正确')
  const name = choice as string
  if (!['auto', 'none', 'required', ...tools.map(tool => tool.name)].includes(name) && !BUILTIN_TOOLS[name]) invalid('tool_choice 引用了未定义的工具')
  if (name === 'required' && !tools.length && !builtins.length) invalid('tool_choice=required 需要至少一个工具')
  let active = name === 'none' ? [] : tools
  if (tools.some(tool => tool.name === name)) active = tools.filter(tool => tool.name === name)
  const forcedBuiltin = BUILTIN_TOOLS[name]
  if (forcedBuiltin) active = []
  const forcedTool = name === 'none' || tools.some(tool => tool.name === name) ? undefined : forcedBuiltin || builtins[0]
  return {
    tools, activeTools: active, choice: name, forcedTool,
    required: (name === 'required' && active.length > 0) || tools.some(tool => tool.name === name),
    parallel: body.parallel_tool_calls !== false,
  }
}

const EFFORTS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh'])
export function normalizeChatRequest(input: unknown): NormalizedChat {
  if (!object(input)) invalid('请求体必须为 JSON 对象')
  const body = input as Json
  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) invalid('model 不能为空')
  if (body.stream !== undefined && body.stream !== null && typeof body.stream !== 'boolean') invalid('stream 必须为布尔值')
  if (body.n !== undefined && body.n !== null && body.n !== 1) invalid('仅支持 n=1')
  const format = object(body.response_format) ? body.response_format.type : undefined
  if (format && format !== 'text') unsupported('Logicc 不支持结构化输出 response_format，已交给其他来源处理')
  const max = body.max_completion_tokens ?? body.max_tokens
  if (max !== undefined && max !== null && (!Number.isInteger(max) || Number(max) <= 0)) invalid('输出 token 上限必须为正整数')
  const messages = messagesFrom(body.messages)
  if (!messages.some(message => message.content || message.tool_calls?.length)) invalid('请求没有有效消息')
  const callIds = new Set<string>()
  for (const message of messages) {
    for (const call of message.tool_calls || []) callIds.add(call.id)
    if (message.role === 'tool' && !callIds.has(message.tool_call_id!)) invalid('工具结果没有对应的历史工具调用')
  }
  const effort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort.toLowerCase()
    : object(body.reasoning) && typeof body.reasoning.effort === 'string' ? body.reasoning.effort.toLowerCase() : undefined
  const options = object(body.stream_options) ? body.stream_options : {}
  return {
    model, stream: body.stream === true, includeUsage: options.include_usage === true, messages,
    ...(max ? { maxTokens: Number(max) } : {}),
    ...(effort && EFFORTS.has(effort) ? { reasoning: effort === 'xhigh' ? 'high' : effort } : {}),
    ...toolsFrom(body),
  }
}

export function buildPrompt(request: NormalizedChat): string {
  const history = request.messages.map(message => {
    if (message.tool_calls?.length) return `[Assistant]\n${message.content}\n[Tool calls]\n${JSON.stringify(message.tool_calls)}`
    if (message.role === 'tool') return `[Tool result: ${message.tool_call_id}]\n${message.content}`
    return message.role === 'user' ? message.content : `[${message.role}]\n${message.content}`
  }).join('\n\n')
  const limit = request.maxTokens ? `\nKeep the response within approximately ${request.maxTokens} output tokens.` : ''
  if (!request.activeTools.length) return history + limit
  return `Serialize the next assistant turn for a client application. The client application executes functions requested in your output; you only select a tool and produce its input. Do not execute the client functions yourself or invent their results.
Return only one JSON object, without markdown fences or explanations, using this envelope:
{"content": "text for the user or null", "tool_calls": [{"name": "a declared tool name", "arguments": {}}]}
Arguments must be a JSON object matching the tool's parameters.
If a tool is needed to fulfill the user's request, request it and stop. Use actual values from the conversation, never placeholder values. If a tool result has already been supplied, use it to continue the task and give the final answer when sufficient. For an ordinary answer, put the answer in content and set tool_calls to []. Do not say tools are unavailable: the external client executes the declared functions after receiving your JSON.
Tool choice: ${request.required ? `You MUST request ${request.choice === 'required' ? 'at least one declared client tool' : JSON.stringify(request.choice)} in this turn.` : 'Choose a tool when needed, otherwise answer the user.'}
Parallel calls: ${request.parallel ? 'allowed' : 'disabled; return at most one tool call'}.
Declared client tools:
${JSON.stringify(request.activeTools)}
Conversation (the actual task to continue):
${JSON.stringify(request.messages)}
Return the next assistant turn JSON now.${limit}`
}

const toolFailure = (message: string): never => { throw new LogiccError('generation', 502, message) }
function envelope(raw: string): Json | null {
  let text = raw.trim()
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i.exec(text)
  if (fenced) text = fenced[1]!.trim()
  try { const value = JSON.parse(text); return object(value) ? value : null } catch { return null }
}
function checkArguments(value: unknown, schema: unknown, depth = 0) {
  if (!object(schema) || depth > 32) return
  const types = schema.type ? [schema.type].flat().map(String) : []
  const matches = (type: string) => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? object(value)
    : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' : typeof value === type
  if (types.length && !types.some(matches)) toolFailure('模型生成的工具参数类型不符合 schema')
  if (Array.isArray(schema.enum) && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) toolFailure('模型生成的工具参数不在允许的枚举值中')
  if (object(value)) {
    for (const key of Array.isArray(schema.required) ? schema.required : []) if (typeof key === 'string' && !Object.hasOwn(value, key)) toolFailure('模型生成的工具参数缺少必填字段')
    for (const [key, item] of Object.entries(value)) {
      const property = object(schema.properties) && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined
      if (schema.additionalProperties === false && property === undefined) toolFailure('模型生成的工具参数包含未允许的字段')
      checkArguments(item, property ?? schema.additionalProperties, depth + 1)
    }
  } else if (Array.isArray(value)) for (const item of value) checkArguments(item, schema.items, depth + 1)
}
function validateCalls(raw: unknown, request: NormalizedChat): ToolCall[] {
  if (!Array.isArray(raw) || raw.length > 32) toolFailure('模型返回了无效的工具调用列表')
  const list = raw as unknown[]
  if (!request.parallel && list.length > 1) toolFailure('模型返回了多个工具调用，但请求禁用了并行调用')
  return list.map(item => {
    const value = object(item) ? item : {}
    const fn = object(value.function) ? value.function : value
    const tool = request.activeTools.find(entry => entry.name === fn.name)
    if (!tool) toolFailure('模型请求了未声明或不允许的工具')
    let args = fn.arguments ?? value.arguments ?? value.input ?? {}
    if (typeof args === 'string') { try { args = JSON.parse(args) } catch { toolFailure('模型生成的工具参数不是有效 JSON') } }
    if (!object(args)) toolFailure('模型生成的工具参数必须为 JSON 对象')
    checkArguments(args, tool!.parameters)
    return { id: 'call_' + randomUUID().replaceAll('-', ''), name: tool!.name, arguments: args as Json }
  })
}

/** Turn the model's answer back into text and standard tool calls. */
export function parseToolOutput(text: string, request: NormalizedChat): { text: string; calls: ToolCall[] } {
  const value = envelope(text)
  const raw = value ? value.tool_calls ?? (value.tool_call ? [value.tool_call] : undefined) : undefined
  if (raw !== undefined) {
    const calls = validateCalls(raw, request)
    if (request.required && !calls.length) toolFailure('模型没有按 tool_choice 返回工具调用')
    if (value!.content != null && typeof value!.content !== 'string') toolFailure('工具响应中的 content 必须为字符串或 null')
    return { text: typeof value!.content === 'string' ? value!.content : '', calls }
  }
  if (request.required) toolFailure('模型没有生成有效的工具调用 JSON')
  // A plain answer is valid in auto mode; JSON quoted inside prose is never executed.
  return { text, calls: [] }
}
