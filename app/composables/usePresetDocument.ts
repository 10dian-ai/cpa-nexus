export interface PresetPromptRow {
  index: number
  identifier: string
  name: string
  role: string
  content: string
  enabled: boolean
  marker: boolean
}

export const presetSamplingFields = [
  { key: 'temperature', aliases: ['temp_openai'], name: '温度', min: 0, max: 5, step: 0.05 },
  { key: 'top_p', aliases: ['top_p_openai'], name: 'Top P', min: 0, max: 1, step: 0.01 },
  { key: 'top_k', aliases: [], name: 'Top K', min: 0, max: undefined, step: 1 },
  { key: 'min_p', aliases: [], name: 'Min P', min: 0, max: 1, step: 0.01 },
  { key: 'frequency_penalty', aliases: ['freq_pen_openai'], name: '频率惩罚', min: -2, max: 2, step: 0.05 },
  { key: 'presence_penalty', aliases: ['pres_pen_openai'], name: '存在惩罚', min: -2, max: 2, step: 0.05 },
  { key: 'repetition_penalty', aliases: [], name: '重复惩罚', min: 0, max: 10, step: 0.05 },
  { key: 'openai_max_tokens', aliases: ['max_tokens'], name: '最大回复 Token', min: 1, max: undefined, step: 1 },
  { key: 'seed', aliases: [], name: '随机种子', min: undefined, max: undefined, step: 1 },
] as const

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function presetDocumentSettings(source: Record<string, unknown>): Record<string, unknown> {
  const nested = record(source.data)
  return nested && Array.isArray(nested.prompts) ? nested : source
}

export function presetSamplingKey(source: Record<string, unknown>, field: { key: string; aliases: readonly string[] }): string {
  const settings = presetDocumentSettings(source)
  return [field.key, ...field.aliases].find(key => settings[key] !== undefined) || field.key
}

function promptOrder(source: Record<string, unknown>): Record<string, unknown> | null {
  source = presetDocumentSettings(source)
  if (!Array.isArray(source.prompt_order)) return null
  if (source.prompt_order.every(value => typeof record(value)?.identifier === 'string')) return { order: source.prompt_order }
  const orders = source.prompt_order.map(record).filter((value): value is Record<string, unknown> => !!value)
  return orders.find(value => Number(value.character_id) === 100000) || (orders.length === 1 ? orders[0]! : null)
}

export function presetPromptOrderAmbiguous(source: Record<string, unknown>): boolean {
  source = presetDocumentSettings(source)
  return Array.isArray(source.prompt_order) && source.prompt_order.length > 1 && !promptOrder(source)
}

export function presetPromptRows(source: Record<string, unknown>): PresetPromptRow[] {
  source = presetDocumentSettings(source)
  if (!Array.isArray(source.prompts)) return []
  const order = promptOrder(source)
  const entries = Array.isArray(order?.order) ? order.order.map(record).filter((value): value is Record<string, unknown> => !!value) : []
  const rows = source.prompts.flatMap((value, index) => {
    const prompt = record(value)
    if (!prompt) return []
    const identifier = typeof prompt.identifier === 'string' ? prompt.identifier : String(index)
    const entry = entries.find(item => item.identifier === identifier)
    return [{ index, identifier, name: String(prompt.name || identifier), role: String(prompt.role || 'system'), content: typeof prompt.content === 'string' ? prompt.content : '',
      enabled: entry ? entry.enabled !== false : entries.length ? false : prompt.enabled !== false, marker: prompt.marker === true }]
  })
  const history = entries.find(item => item.identifier === 'chatHistory')
  if (!rows.some(row => row.identifier === 'chatHistory') && (history || source.prompt_order === undefined)) {
    const historyRow = { index: -1, identifier: 'chatHistory', name: '聊天历史', role: 'system', content: '', enabled: history ? history.enabled !== false : true, marker: true }
    const tail = rows.findIndex(row => row.identifier === 'jailbreak')
    if (!history && tail >= 0) rows.splice(tail, 0, historyRow)
    else rows.push(historyRow)
  }
  const position = new Map(entries.map((entry, index) => [String(entry.identifier), index]))
  return entries.length ? rows.sort((a, b) => (position.get(a.identifier) ?? 100000 + a.index) - (position.get(b.identifier) ?? 100000 + b.index)) : rows
}

export function updatePresetPrompt(source: Record<string, unknown>, row: PresetPromptRow, field: 'name' | 'role' | 'content' | 'enabled', value: string | boolean): void {
  source = presetDocumentSettings(source)
  const prompt = Array.isArray(source.prompts) ? record(source.prompts[row.index]) : null
  if (prompt) prompt[field] = value
  else if (row.index !== -1 || field !== 'enabled') return
  if (field !== 'enabled') return
  let order = promptOrder(source)
  if (!order && row.index === -1) {
    order = { character_id: 100000, order: presetPromptRows(source).map(item => ({ identifier: item.identifier, enabled: item.enabled })) }
    source.prompt_order = [order]
  }
  if (!order || !Array.isArray(order.order)) return
  const entry = order.order.map(record).find(item => item?.identifier === row.identifier)
  if (entry) entry.enabled = value
  else order.order.push({ identifier: row.identifier, enabled: value })
}

export function movePresetPrompt(source: Record<string, unknown>, identifier: string, direction: -1 | 1): void {
  source = presetDocumentSettings(source)
  if (presetPromptOrderAmbiguous(source)) return
  const rows = presetPromptRows(source)
  const index = rows.findIndex(row => row.identifier === identifier)
  const next = index + direction
  if (index < 0 || next < 0 || next >= rows.length) return
  const moving = rows[index]!
  rows[index] = rows[next]!
  rows[next] = moving
  let order = promptOrder(source)
  if (!order) {
    order = { character_id: 100000, order: [] }
    source.prompt_order = [order]
  }
  const previous = Array.isArray(order.order) ? order.order : []
  const nextOrder = [...rows.map(row => ({ ...(record(previous.find(item => record(item)?.identifier === row.identifier)) || {}), identifier: row.identifier, enabled: row.enabled })), ...previous.filter(item => !rows.some(row => row.identifier === record(item)?.identifier))]
  if (Array.isArray(source.prompt_order) && source.prompt_order.every(value => typeof record(value)?.identifier === 'string')) source.prompt_order = nextOrder
  else order.order = nextOrder
}

export function parsePresetObject(text: string): Record<string, unknown> {
  const value = JSON.parse(text)
  const object = record(value)
  if (!object) throw new Error('预设内容必须是 JSON 对象。')
  return object
}

export function parsePresetVariables(text: string): Record<string, string> {
  const value = parsePresetObject(text)
  if (Object.values(value).some(item => typeof item !== 'string')) throw new Error('上下文变量的值必须是字符串。')
  return value as Record<string, string>
}
