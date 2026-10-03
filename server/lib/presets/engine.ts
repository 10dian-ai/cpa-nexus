import { platformError } from '../platform-error'
import { PRESET_CONTEXT_KEYS, type PresetApplyOptions, type PresetCompatibility, type PresetIssue, type PresetView } from '../../../shared/presets'

type JsonObject = Record<string, unknown>
interface Prompt { id: string; role: string; content: string; marker: boolean; position: number; depth: number; order: number; triggers: string[] }
interface Compiled { prompts: Prompt[]; parameters: JsonObject; settings: JsonObject; issues: PresetIssue[] }
const isObject = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value)
const error = (message: string, data?: Record<string, unknown>) => platformError({ statusCode: 422, message, data })
const markers: Record<string, string> = { worldInfoBefore: 'wiBefore', worldInfoAfter: 'wiAfter', charDescription: 'description', charPersonality: 'personality', scenario: 'scenario', personaDescription: 'persona', dialogueExamples: 'mesExamples' }
const dynamicMacros = new Set(['lastMessage', 'lastUserMessage', 'lastCharMessage', 'newline'])
const allowedMacros = new Set<string>([...PRESET_CONTEXT_KEYS, ...dynamicMacros])
const generationTypes = new Set(['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'])
function replaceTemplate(template: string, token: string, value: string): string {
  return template.split(token).join(value)
}

/** Import/export retain the entire document; only the compiled allowlist reaches model APIs. */
export function parsePresetJson(input: unknown): JsonObject {
  let value = input
  if (typeof input === 'string') {
    try { value = JSON.parse(input) } catch { throw platformError({ statusCode: 400, message: '预设不是有效的 JSON' }) }
  }
  if (!isObject(value)) throw platformError({ statusCode: 400, message: '预设必须是 JSON 对象' })
  const pending: unknown[] = [value]
  while (pending.length) {
    const node = pending.pop()
    if (Array.isArray(node)) { for (const child of node) pending.push(child); continue }
    if (isObject(node)) {
      for (const [key, child] of Object.entries(node)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw platformError({ statusCode: 400, message: '预设包含无效对象字段' })
        pending.push(child)
      }
    } else if (node !== null && !['string', 'boolean', 'number'].includes(typeof node)) throw platformError({ statusCode: 400, message: '预设只能包含 JSON 值' })
    else if (typeof node === 'number' && !Number.isFinite(node)) throw platformError({ statusCode: 400, message: '预设包含无效数值' })
  }
  const json = JSON.stringify(value)
  return JSON.parse(json)
}

export function validatePresetVariables(input: unknown = {}): Record<string, string> {
  if (!isObject(input)) throw platformError({ statusCode: 400, message: '预设变量必须是字符串键值对象' })
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!PRESET_CONTEXT_KEYS.includes(key as typeof PRESET_CONTEXT_KEYS[number]) || typeof value !== 'string') throw platformError({ statusCode: 400, message: `预设变量 ${key} 无效` })
    result[key] = value
  }
  return result
}

function compile(source: JsonObject): Compiled {
  const settings = isObject(source.data) && Array.isArray(source.data.prompts) ? source.data : source
  const issues: PresetIssue[] = []
  const add = (code: string, message: string, path?: string, severity: 'warning' | 'error' = 'error') => issues.push({ code, message, severity, ...(path ? { path } : {}) })
  const definitions = new Map<string, JsonObject>()
  if (settings.prompts !== undefined && !Array.isArray(settings.prompts)) add('invalid_prompts', 'prompts 必须是数组', 'prompts')
  if (Array.isArray(settings.prompts)) for (let index = 0; index < settings.prompts.length; index++) {
    const item = settings.prompts[index]
    if (!isObject(item) || typeof item.identifier !== 'string' || !item.identifier) { add('invalid_prompt', '提示词必须具有有效 identifier', `prompts.${index}`); continue }
    if (definitions.has(item.identifier)) add('duplicate_prompt', '提示词 identifier 重复', `prompts.${index}.identifier`)
    definitions.set(item.identifier, item)
  }
  // Legacy Chat Completion fields are mapped to their actual Prompt Manager counterparts.
  for (const [field, id] of Object.entries({ main_prompt: 'main', nsfw_prompt: 'nsfw', jailbreak_prompt: 'jailbreak', post_history_instructions: 'jailbreak' })) {
    if (typeof settings[field] === 'string' && !definitions.has(id)) definitions.set(id, { identifier: id, role: 'system', content: settings[field] })
  }
  let ordered: unknown[] | undefined
  if (settings.prompt_order !== undefined) {
    if (!Array.isArray(settings.prompt_order)) add('invalid_order', 'prompt_order 必须是数组', 'prompt_order')
    else if (settings.prompt_order.every(isObject) && settings.prompt_order.every(item => typeof item.identifier === 'string')) ordered = settings.prompt_order
    else {
      const groups = settings.prompt_order.filter(isObject)
      const global = groups.find(item => String(item.character_id) === '100000')
      if (global && Array.isArray(global.order)) ordered = global.order
      else if (groups.length === 1 && Array.isArray(groups[0]!.order)) ordered = groups[0]!.order
      else add('ambiguous_order', '多个角色顺序需要一个 character_id=100000 的全局顺序；不能猜测当前角色', 'prompt_order')
      if (groups.length > 1 && global) add('character_orders', '当前使用全局 100000 顺序；其他角色顺序保留在 JSON 中', 'prompt_order', 'warning')
    }
  } else {
    ordered = [...definitions.values()].map(item => ({ identifier: item.identifier, enabled: item.enabled !== false }))
    if (!definitions.has('chatHistory')) {
      const tail = ordered.findIndex(item => isObject(item) && item.identifier === 'jailbreak')
      ordered.splice(tail < 0 ? ordered.length : tail, 0, { identifier: 'chatHistory', enabled: true })
    }
  }
  const prompts: Prompt[] = [], seen = new Set<string>()
  for (const [index, entry] of (ordered || []).entries()) {
    const path = `prompt_order.${index}`
    if (!isObject(entry) || typeof entry.identifier !== 'string' || typeof entry.enabled !== 'boolean') { add('invalid_order_entry', '顺序项需要 identifier 和布尔 enabled', path); continue }
    if (seen.has(entry.identifier)) { add('duplicate_order', '提示词顺序包含重复 identifier', path); continue }
    seen.add(entry.identifier)
    if (!entry.enabled) continue
    const item = definitions.get(entry.identifier) || (entry.identifier === 'chatHistory' ? { marker: true } : undefined)
    if (!item) { add('missing_prompt', `已启用的提示词 ${entry.identifier} 没有定义`, path); continue }
    const marker = item.marker === true || entry.identifier === 'chatHistory'
    const role = typeof item.role === 'string' ? item.role : 'system'
    if (!['system', 'user', 'assistant'].includes(role)) add('invalid_role', '预设提示词角色只支持 system、user、assistant', path)
    if (item.content !== undefined && typeof item.content !== 'string') add('invalid_content', '提示词 content 必须是字符串', path)
    const position = item.injection_position ?? 0, depth = item.injection_depth ?? 4, order = item.injection_order ?? 100
    if (position !== 0 && position !== 1) add('invalid_position', 'injection_position 只支持 Relative=0 和 In-Chat=1', path)
    if (!Number.isInteger(depth) || Number(depth) < 0) add('invalid_depth', 'injection_depth 必须是非负整数', path)
    if (!Number.isInteger(order)) add('invalid_injection_order', 'injection_order 必须是整数', path)
    let triggers: string[] = []
    if (item.injection_trigger !== undefined) {
      if (!Array.isArray(item.injection_trigger) || item.injection_trigger.some(value => typeof value !== 'string' || !generationTypes.has(value))) add('invalid_trigger', '提示词包含不支持的生成触发类型', path)
      else triggers = item.injection_trigger as string[]
    }
    if (marker && entry.identifier !== 'chatHistory') {
      if (!markers[entry.identifier]) add('unsupported_marker', `无法提供 ${entry.identifier} 标记的酒馆上下文`, path)
      else if (entry.identifier === 'dialogueExamples') add('example_marker', '聊天示例标记只支持手工文本变量 mesExamples；不执行角色卡示例解析', path, 'warning')
    }
    if (marker && position === 1) add('marker_depth', '上下文标记不支持 In-Chat 深度插入，请改成 Relative', path)
    prompts.push({ id: entry.identifier, role, content: typeof item.content === 'string' ? item.content : '', marker, position: Number(position), depth: Number(depth), order: Number(order), triggers })
  }
  if (!prompts.some(prompt => prompt.id === 'chatHistory')) add('missing_history', '必须启用 chatHistory 标记，以完整保留客户端消息、工具和图片', 'prompt_order')
  if (!prompts.length) add('empty_preset', '没有可用的 Chat Completion 提示词；Text Completion/Instruct 预设尚不支持', 'prompts')
  const historyIndex = prompts.findIndex(prompt => prompt.id === 'chatHistory')
  if (prompts.some((prompt, index) => prompt.role === 'system' && prompt.content && (prompt.position === 1 || index > historyIndex))) add('claude_system_conversion', 'Anthropic Messages 按酒馆规则：开头 system 放入独立 system 字段，历史中及末尾 system 保留位置并转为 user，再合并相邻同角色内容块', 'prompts', 'warning')
  const parameters: JsonObject = {}
  const numeric: Array<[string[], string, number, number, boolean?]> = [
    [['temperature', 'temp_openai'], 'temperature', 0, 5], [['top_p', 'top_p_openai'], 'top_p', 0, 1],
    [['frequency_penalty', 'freq_pen_openai'], 'frequency_penalty', -2, 2], [['presence_penalty', 'pres_pen_openai'], 'presence_penalty', -2, 2],
    [['openai_max_tokens', 'max_tokens'], 'max_tokens', 1, Number.POSITIVE_INFINITY, true], [['top_k'], 'top_k', 0, Number.POSITIVE_INFINITY, true],
    [['seed'], 'seed', Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, true],
  ]
  for (const [fields, target, min, max, integer] of numeric) {
    const field = fields.find(key => settings[key] !== undefined)
    if (!field) continue
    const value = settings[field]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) add('invalid_parameter', `${field} 数值无效`, field)
    else if (!(target === 'seed' && value === -1) && !(target === 'top_k' && value === 0)) parameters[target] = value
  }
  const stop = settings.stop ?? settings.stop_openai
  if (stop !== undefined && stop !== '') {
    const values = typeof stop === 'string' ? [stop] : stop
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) add('invalid_stop', 'stop 必须是字符串数组', 'stop')
    else if (values.length) parameters.stop = values
  }
  // These are browser-side behaviors, not transferable API transformations.
  for (const field of ['custom_include_body', 'custom_exclude_body', 'custom_include_headers', 'extensions']) if (settings[field] && (!isObject(settings[field]) || Object.keys(settings[field]).length)) add('unsupported_extension', `${field} 已保留，但自定义脚本/请求覆盖无法在预设模块执行`, field)
  for (const field of ['top_a', 'min_p']) if (typeof settings[field] === 'number' && settings[field] !== 0) add('unsupported_sampler', `${field} 暂无统一 API 映射`, field)
  if (typeof settings.repetition_penalty === 'number' && settings.repetition_penalty !== 1) add('unsupported_sampler', 'repetition_penalty 暂无统一 API 映射', 'repetition_penalty')
  if (settings.openai_max_context !== undefined) add('context_budget', '不执行酒馆 token 预算截断；完整保留客户端历史', 'openai_max_context', 'warning')
  if (settings.stream_openai !== undefined) add('client_stream', '流式模式由客户端请求决定', 'stream_openai', 'warning')
  for (const field of ['new_chat_prompt', 'new_group_chat_prompt', 'continue_nudge_prompt', 'impersonation_prompt', 'group_nudge_prompt', 'send_if_empty']) if (settings[field]) add('browser_generation_control', `${field} 属于酒馆交互行为，本模块不自动触发`, field, 'warning')
  if (settings.reverse_proxy || settings.custom_url || settings.proxy_password) add('network_settings', '预设内的地址和代理凭据只保留，不改变平台上游路由', 'reverse_proxy', 'warning')
  const known = new Set(['prompts', 'prompt_order', 'temperature', 'temp_openai', 'top_p', 'top_p_openai', 'frequency_penalty', 'freq_pen_openai', 'presence_penalty', 'pres_pen_openai', 'openai_max_tokens', 'max_tokens', 'top_k', 'seed', 'stop', 'stop_openai', 'main_prompt', 'nsfw_prompt', 'jailbreak_prompt', 'post_history_instructions', 'custom_include_body', 'custom_exclude_body', 'custom_include_headers', 'extensions', 'top_a', 'min_p', 'repetition_penalty', 'openai_max_context', 'stream_openai', 'new_chat_prompt', 'new_group_chat_prompt', 'continue_nudge_prompt', 'impersonation_prompt', 'group_nudge_prompt', 'send_if_empty', 'reverse_proxy', 'custom_url', 'proxy_password', 'wi_format', 'scenario_format', 'personality_format'])
  const retained = Object.keys(settings).filter(key => !known.has(key))
  if (retained.length) add('retained_settings', `这些酒馆界面/后端专用设置只保留，不应用到请求：${retained.slice(0, 24).join('、')}${retained.length > 24 ? ` 等 ${retained.length} 项` : ''}`, undefined, 'warning')
  return { prompts, parameters, settings, issues }
}

const macroMatches = (content: string) => [...content.matchAll(/\{\{([\s\S]*?)\}\}/g)]
export function inspectPreset(source: JsonObject, variables: Record<string, string> = {}): PresetCompatibility {
  const compiled = compile(source), issues = [...compiled.issues]
  for (const prompt of compiled.prompts) {
    if (prompt.marker && prompt.id !== 'chatHistory' && !Object.hasOwn(variables, markers[prompt.id]!)) issues.push({ code: 'missing_marker_context', severity: 'warning', message: `${prompt.id} 没有提供上下文，将不注入此标记`, path: `prompts.${prompt.id}` })
    const texts = prompt.marker ? [variables[markers[prompt.id]!] || ''] : [prompt.content]
    if (prompt.marker && texts[0]) {
      const field = prompt.id === 'scenario' ? 'scenario_format' : prompt.id === 'charPersonality' ? 'personality_format' : ['worldInfoBefore', 'worldInfoAfter'].includes(prompt.id) ? 'wi_format' : ''
      if (field && typeof compiled.settings[field] === 'string') texts.push(compiled.settings[field] as string)
    }
    for (const text of texts) for (const match of macroMatches(text)) {
      const macro = match[1]!.trim()
      if (!allowedMacros.has(macro)) issues.push({ code: 'unsupported_macro', severity: 'error', message: `不支持宏 {{${macro}}}；不执行酒馆脚本、变量指令、随机或扩展宏`, path: `prompts.${prompt.id}.content` })
      else if (!dynamicMacros.has(macro) && !Object.hasOwn(variables, macro)) issues.push({ code: 'missing_variable', severity: 'error', message: `需要填写变量 ${macro}，不能猜测角色或用户信息`, path: `prompts.${prompt.id}.content` })
    }
  }
  // Deduplicate repeated macro diagnostics while preserving actionable paths.
  const unique = [...new Map(issues.map(issue => [JSON.stringify(issue), issue])).values()]
  return { supported: !unique.some(issue => issue.severity === 'error'), issues: unique }
}

function messageText(message: JsonObject): string {
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) return message.content.filter(isObject).filter(part => typeof part.text === 'string' && ['text', 'input_text', 'output_text'].includes(String(part.type))).map(part => part.text).join('\n')
  return ''
}

/** Independent implementation of the public ST JSON format; no browser JS or extension scripts run here. */
export function applyPreset(preset: Pick<PresetView, 'sourceJson' | 'variables'>, body: JsonObject, options: PresetApplyOptions): JsonObject {
  if (!isObject(body)) throw error('模型请求必须是 JSON 对象')
  const context = { ...validatePresetVariables(preset.variables), ...validatePresetVariables(options.context || {}) }
  const compatibility = inspectPreset(preset.sourceJson, context)
  if (!compatibility.supported) throw error('预设存在不支持的内容，请编辑后再使用', { issues: compatibility.issues.filter(issue => issue.severity === 'error') })
  const compiled = compile(preset.sourceJson)
  const result = { ...body }, protocol = options.protocol
  let history: JsonObject[]
  if (protocol === 'responses') {
    if (typeof body.input === 'string') history = [{ role: 'user', content: body.input }]
    else if (Array.isArray(body.input) && body.input.every(isObject)) history = body.input as JsonObject[]
    else throw error('Responses 预设需要字符串或对象数组 input')
    if (body.previous_response_id || body.conversation) throw error('预设深度与顺序需要完整客户端历史；不能处理隐藏的 Responses 会话历史')
  } else {
    if (!Array.isArray(body.messages) || !body.messages.every(isObject)) throw error('预设需要对象数组 messages')
    history = body.messages as JsonObject[]
  }
  const last = (role?: string) => messageText([...history].reverse().find(item => !role || item.role === role) || {})
  const macros: Record<string, string> = { ...context, lastMessage: last(), lastUserMessage: last('user'), lastCharMessage: last('assistant'), newline: '\n' }
  const substitute = (text: string): string => {
    return text.replace(/\{\{([\s\S]*?)\}\}/g, (match: string, expression: string) => {
      const key = expression.trim()
      if (!allowedMacros.has(key) || !Object.hasOwn(macros, key)) throw error(`无法展开宏 {{${key}}}`)
      const value = macros[key]!
      return value
    })
  }
  const active = compiled.prompts.filter(prompt => !prompt.triggers.length || prompt.triggers.includes(options.generationType || 'normal'))
  if (!active.some(prompt => prompt.id === 'chatHistory')) throw error('当前生成触发类型未保留 chatHistory')
  const expanded = new Map<Prompt, string>()
  for (const prompt of active) {
    if (prompt.id === 'chatHistory') continue
    let text = prompt.marker ? context[markers[prompt.id]!] || '' : prompt.content
    if (!text) continue
    if (prompt.marker && prompt.id === 'scenario' && typeof compiled.settings.scenario_format === 'string' && compiled.settings.scenario_format) text = replaceTemplate(compiled.settings.scenario_format, '{{scenario}}', text)
    if (prompt.marker && prompt.id === 'charPersonality' && typeof compiled.settings.personality_format === 'string' && compiled.settings.personality_format) text = replaceTemplate(compiled.settings.personality_format, '{{personality}}', text)
    if (prompt.marker && ['worldInfoBefore', 'worldInfoAfter'].includes(prompt.id) && typeof compiled.settings.wi_format === 'string' && compiled.settings.wi_format) text = replaceTemplate(compiled.settings.wi_format, '{0}', text)
    if (text) {
      const content = substitute(text)
      expanded.set(prompt, content)
    }
  }
  // Depth counts user/assistant turns; tool call + results are indivisible history spans.
  const boundaries = [0]
  for (let i = 0; i < history.length; i++) {
    const item = history[i]!
    if (item.role !== 'user' && item.role !== 'assistant') continue
    // Tool-result-only user messages are not a new conversational turn.
    if (item.role === 'user' && Array.isArray(item.content) && item.content.length && item.content.every(part => isObject(part) && part.type === 'tool_result')) continue
    if (boundaries[boundaries.length - 1] !== i) boundaries.push(i)
  }
  boundaries.push(history.length)
  const injections = new Map<number, Prompt[]>()
  for (const prompt of active.filter(item => item.position === 1 && expanded.has(item))) {
    const offset = prompt.depth === 0 ? history.length : boundaries[Math.max(0, boundaries.length - 1 - prompt.depth)]!
    const group = injections.get(offset) || []; group.push(prompt); injections.set(offset, group)
  }
  const enriched: JsonObject[] = []
  for (let index = 0; index <= history.length; index++) {
    const group = injections.get(index) || []
    // Lower priority order goes earlier; ST reverses its internal newest-first history.
    for (const order of [...new Set(group.map(prompt => prompt.order))].sort((a, b) => a - b)) {
      for (const role of ['assistant', 'user', 'system']) {
        const contents = group.filter(prompt => prompt.order === order && prompt.role === role).map(prompt => expanded.get(prompt)).filter(Boolean)
        if (contents.length) enriched.push({ role, content: contents.join('\n') })
      }
    }
    if (index < history.length) enriched.push(history[index]!)
  }
  const outgoing: JsonObject[] = []
  for (const prompt of active.filter(item => item.position === 0)) {
    if (prompt.id === 'chatHistory') outgoing.push(...enriched)
    else if (expanded.has(prompt)) outgoing.push({ role: prompt.role, content: expanded.get(prompt)! })
  }
  if (protocol === 'messages') {
    const system: unknown[] = [], messages: JsonObject[] = []
    if (typeof body.system === 'string') { if (body.system) system.push({ type: 'text', text: body.system }) }
    else if (Array.isArray(body.system)) system.push(...body.system)
    else if (body.system !== undefined) throw error('Anthropic system 必须是字符串或内容块数组')
    for (const item of outgoing) {
      if (item.role === 'system' || item.role === 'developer') {
        if (messages.length) messages.push({ ...item, role: 'user' })
        else if (typeof item.content === 'string') system.push({ type: 'text', text: item.content })
        else if (Array.isArray(item.content)) system.push(...item.content)
        else throw error('Anthropic system 内容无效')
      } else messages.push(item)
    }
    // ST's Claude Messages converter keeps late system prompts in place as user
    // turns, then merges adjacent roles. Content blocks remain intact, including
    // image, tool_use, tool_result and cache_control; never flatten them to text.
    const blocks = (item: JsonObject): unknown[] => typeof item.content === 'string' ? [{ type: 'text', text: item.content }] : Array.isArray(item.content) ? item.content : (() => { throw error('Anthropic 消息内容必须是字符串或内容块数组') })()
    const merged: JsonObject[] = []
    for (const item of messages) {
      const previous = merged[merged.length - 1]
      if (previous && previous.role === item.role) merged[merged.length - 1] = { ...previous, content: [...blocks(previous), ...blocks(item)] }
      else merged.push(item)
    }
    result.system = system; result.messages = merged
  } else if (protocol === 'responses') result.input = outgoing
  else result.messages = outgoing
  const allowed = protocol === 'responses' ? new Set(['temperature', 'top_p', 'max_tokens']) : protocol === 'messages' ? new Set(['temperature', 'top_p', 'top_k', 'max_tokens', 'stop']) : new Set(['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'max_tokens', 'seed', 'stop'])
  for (const [key, value] of Object.entries(compiled.parameters)) {
    if (!allowed.has(key)) continue
    const target = key === 'max_tokens' && protocol === 'responses' ? 'max_output_tokens' : key === 'stop' && protocol === 'messages' ? 'stop_sequences' : key
    if (result[target] === undefined && !(key === 'max_tokens' && result.max_completion_tokens !== undefined)) result[target] = value
  }
  return result
}
