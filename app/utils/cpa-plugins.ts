export interface PluginConfigField {
  name: string
  type: string
  enumValues: string[]
  description: string
}
export const pluginObject = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function pluginConfigFields(plugin: Record<string, unknown>): PluginConfigField[] {
  const direct = Array.isArray(plugin.config_fields) ? plugin.config_fields : []
  const metadata = pluginObject(plugin.metadata)
  const rows = direct.length ? direct : Array.isArray(metadata.config_fields) ? metadata.config_fields : []
  const fields = new Map<string, PluginConfigField>()
  for (const row of rows) {
    const field = pluginObject(row)
    if (typeof field.name !== 'string' || !field.name || fields.has(field.name)) continue
    fields.set(field.name, {
      name: field.name,
      type: typeof field.type === 'string' ? field.type : 'unknown',
      enumValues: Array.isArray(field.enum_values) ? [...new Set(field.enum_values.filter((value): value is string => typeof value === 'string'))] : [],
      description: typeof field.description === 'string' ? field.description : '',
    })
  }
  return [...fields.values()]
}

export function pluginFieldText(value: unknown, field: PluginConfigField): string {
  if (value === undefined) return ''
  if (['string', 'enum'].includes(field.type)) return String(value)
  return JSON.stringify(value, null, ['array', 'object', 'unknown'].includes(field.type) ? 2 : undefined)
}

export function parsePluginField(field: PluginConfigField, value: string): unknown {
  if (field.type === 'string') return value
  if (field.type === 'enum') {
    if (!field.enumValues.includes(value)) throw new Error('请选择插件声明的选项。')
    return value
  }
  if (field.type === 'boolean') {
    if (value !== 'true' && value !== 'false') throw new Error('请选择开启或关闭。')
    return value === 'true'
  }
  if (field.type === 'number' || field.type === 'integer') {
    const numeric = Number(value)
    if (!value.trim() || !Number.isFinite(numeric) || (field.type === 'integer' && !Number.isInteger(numeric))) throw new Error(field.type === 'integer' ? '请输入有效整数。' : '请输入有效数字。')
    return numeric
  }
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error('请输入有效 JSON。') }
  if (field.type === 'array' && !Array.isArray(parsed)) throw new Error('此字段需要 JSON 数组。')
  if (field.type === 'object' && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error('此字段需要 JSON 对象。')
  return parsed
}

export function pluginExternalLink(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return ''
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''
  } catch { return '' }
}

export function pluginMenuHref(id: string, menu: Record<string, unknown>): string {
  const path = typeof menu.path === 'string' ? menu.path : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || !path.startsWith(`/v0/resource/plugins/${id}/`) || /[\\\u0000-\u001f]/.test(path)) return ''
  try {
    const url = new URL(path, 'http://nexus.invalid')
    if (url.origin !== 'http://nexus.invalid' || !url.pathname.startsWith(`/v0/resource/plugins/${id}/`)) return ''
    return '/api/cpa/console' + url.pathname + url.search + url.hash
  } catch { return '' }
}
