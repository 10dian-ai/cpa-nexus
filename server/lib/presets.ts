import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import { isModuleEnabled } from './modules'
import { findModule } from '../../shared/modules'
import { ensureCpaPresetAccountRoute } from './cpa/preset-routing'
import { platformError } from './platform-error'
import { inspectPreset, parsePresetJson, validatePresetVariables } from './presets/engine'
import type { PresetBinding, PresetRouteInput, PresetView } from '../../shared/presets'

type PresetRow = Record<string, any>
export interface PresetWriteInput { name: string; description?: string; sourceJson: unknown; variables?: unknown }
const idValid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
const missing = () => platformError({ statusCode: 404, message: '预设不存在' })
const iso = (value: unknown) => new Date(value as string).toISOString()
const view = (row: PresetRow): PresetView => ({ id: row.id, name: row.name, description: row.description, sourceJson: row.source_json, variables: row.variables, compatibility: inspectPreset(row.source_json, row.variables), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })
const bindingView = (row: PresetRow): PresetBinding => ({ moduleId: row.module_id, accountId: row.account_id || null, mode: row.mode, presetId: row.preset_id || null, updatedAt: iso(row.updated_at) })
const routeCache = new Map<string, { value: PresetView | null; until: number }>()
let routeCacheGeneration = 0
export function resetPresetRouteCache() { routeCache.clear(); routeCacheGeneration++ }
function writeInput(input: PresetWriteInput) {
  const name = input.name?.trim()
  if (!name || name.length > 120) throw platformError({ statusCode: 400, message: '预设名称需要 1 至 120 个字符' })
  const description = input.description ?? ''
  if (typeof description !== 'string' || description.length > 2000) throw platformError({ statusCode: 400, message: '预设说明不能超过 2000 个字符' })
  const sourceJson = parsePresetJson(input.sourceJson), variables = validatePresetVariables(input.variables)
  return { name, description, sourceJson, variables, compatibility: inspectPreset(sourceJson, variables) }
}
export const validatePreset = writeInput
export async function listPresets(): Promise<PresetView[]> {
  return (await getDb()`SELECT * FROM nexus_presets ORDER BY updated_at DESC,id LIMIT 1000`).map(view)
}
export async function getPreset(id: string): Promise<PresetView> {
  if (!idValid(id)) throw missing()
  const rows = await getDb()`SELECT * FROM nexus_presets WHERE id=${id}`
  if (!rows[0]) throw missing()
  return view(rows[0])
}
export async function createPreset(input: PresetWriteInput): Promise<PresetView> {
  const value = writeInput(input), sql = getDb()
  const result = await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('nexus:presets:write',0))`
    const count = await tx`SELECT count(*)::int AS count FROM nexus_presets`
    if (count[0]!.count >= 1000) throw platformError({ statusCode: 409, message: '最多保存 1000 个预设，请先删除不需要的预设' })
    const rows = await tx`INSERT INTO nexus_presets(id,name,description,source_json,variables) VALUES(${randomUUID()},${value.name},${value.description},${tx.json(value.sourceJson as any)},${tx.json(value.variables)}) RETURNING *`
    return view(rows[0]!)
  }) as unknown as PresetView
  resetPresetRouteCache()
  return result
}
export async function updatePreset(id: string, input: Partial<PresetWriteInput>): Promise<PresetView> {
  if (!idValid(id)) throw missing()
  const result = await getDb().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('nexus:presets:write',0))`
    const current = (await tx`SELECT * FROM nexus_presets WHERE id=${id} FOR UPDATE`)[0]
    if (!current) throw missing()
    const value = writeInput({ name: input.name ?? current.name, description: input.description ?? current.description, sourceJson: input.sourceJson ?? current.source_json, variables: input.variables ?? current.variables })
    if (!value.compatibility.supported && (await tx`SELECT 1 FROM nexus_preset_bindings WHERE preset_id=${id} LIMIT 1`).length) throw platformError({ statusCode: 409, message: '这个预设仍被路由使用，不能保存会导致调用失败的内容；请先解除绑定', data: { issues: value.compatibility.issues } })
    const rows = await tx`UPDATE nexus_presets SET name=${value.name},description=${value.description},source_json=${tx.json(value.sourceJson as any)},variables=${tx.json(value.variables)},updated_at=now() WHERE id=${id} RETURNING *`
    return view(rows[0]!)
  }) as unknown as PresetView
  resetPresetRouteCache()
  return result
}
export async function deletePreset(id: string) {
  if (!idValid(id)) throw missing()
  const result = await getDb().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('nexus:presets:write',0))`
    if ((await tx`SELECT 1 FROM nexus_preset_bindings WHERE preset_id=${id} LIMIT 1`).length) throw platformError({ statusCode: 409, message: '预设仍被模块或账号使用，请先解除绑定' })
    if (!(await tx`DELETE FROM nexus_presets WHERE id=${id} RETURNING id`).length) throw missing()
    return { deleted: true }
  })
  resetPresetRouteCache()
  return result
}
export async function listPresetBindings(): Promise<PresetBinding[]> {
  return (await getDb()`SELECT * FROM nexus_preset_bindings ORDER BY module_id,account_id LIMIT 10000`).map(bindingView)
}
async function validateAccount(moduleId: string, accountId: string) {
  if (moduleId === 'commandcode') {
    if (!idValid(accountId) || !(await getDb()`SELECT id FROM managed_accounts WHERE id=${accountId}`).length) throw platformError({ statusCode: 404, message: 'CommandCode 账号不存在' })
    return
  }
  if (moduleId === 'cpa') {
    await ensureCpaPresetAccountRoute(accountId)
    return
  }
  throw platformError({ statusCode: 409, message: '此模块尚未注册账号验证，暂时只能选择模块默认预设' })
}
export async function setPresetBinding(input: PresetRouteInput): Promise<PresetBinding | null> {
  const manifest = findModule(input.moduleId)
  if (!manifest || ['platform', 'presets'].includes(input.moduleId)) throw platformError({ statusCode: 404, message: '不存在可调用的模型模块' })
  const accountId = input.accountId || ''
  if (accountId.length > 500 || /[\u0000-\u001f\u007f]/.test(accountId)) throw platformError({ statusCode: 400, message: '账号标识无效' })
  if (!['inherit', 'bypass', 'preset'].includes(input.mode)) throw platformError({ statusCode: 400, message: '路由模式无效' })
  if (input.mode === 'preset' && (!input.presetId || !idValid(input.presetId))) throw platformError({ statusCode: 400, message: '请选择有效预设' })
  if (input.mode !== 'preset' && input.presetId) throw platformError({ statusCode: 400, message: '继承或直连模式不能指定预设' })
  // Check the preset before a native account helper may persist a model prefix.
  if (input.mode === 'preset') {
    const preset = await getPreset(input.presetId!)
    if (!preset.compatibility.supported) throw platformError({ statusCode: 422, message: '预设尚未兼容，请修复提示词或填写变量后再绑定', data: { issues: preset.compatibility.issues } })
  }
  // Removing an obsolete binding must work even after its account has been deleted.
  if (input.mode !== 'inherit' && accountId) await validateAccount(input.moduleId, accountId)
  const result = await getDb().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('nexus:presets:write',0))`
    if (input.mode === 'inherit') { await tx`DELETE FROM nexus_preset_bindings WHERE module_id=${input.moduleId} AND account_id=${accountId}`; return null }
    if (input.mode === 'preset') {
      const row = (await tx`SELECT * FROM nexus_presets WHERE id=${input.presetId!}`)[0]
      if (!row) throw missing()
      const compatibility = inspectPreset(row.source_json, row.variables)
      if (!compatibility.supported) throw platformError({ statusCode: 422, message: '预设尚未兼容，请修复提示词或填写变量后再绑定', data: { issues: compatibility.issues } })
    }
    await tx`INSERT INTO platform_modules(id,enabled) VALUES(${manifest.id},true) ON CONFLICT(id) DO NOTHING`
    const rows = await tx`INSERT INTO nexus_preset_bindings(module_id,account_id,mode,preset_id) VALUES(${input.moduleId},${accountId},${input.mode},${input.mode === 'preset' ? input.presetId! : null}) ON CONFLICT(module_id,account_id) DO UPDATE SET mode=EXCLUDED.mode,preset_id=EXCLUDED.preset_id,updated_at=now() RETURNING *`
    return bindingView(rows[0]!)
  }) as unknown as PresetBinding | null
  resetPresetRouteCache()
  return result
}

/** Missing account override inherits; explicit bypass never falls back to a module preset. */
export async function resolvePresetRoute(moduleId: string, accountId?: string | null): Promise<PresetView | null> {
  if (!await isModuleEnabled('presets')) return null
  const key = `${moduleId}\0${accountId || ''}`, cached = routeCache.get(key)
  if (cached && cached.until > Date.now()) return cached.value
  const generation = routeCacheGeneration
  const rows = await getDb()`SELECT b.mode,p.* FROM nexus_preset_bindings b LEFT JOIN nexus_presets p ON p.id=b.preset_id WHERE b.module_id=${moduleId} AND b.account_id IN ('',${accountId || ''}) ORDER BY (b.account_id<>'') DESC LIMIT 1`
  const row = rows[0]
  if (row && row.mode !== 'bypass' && !row.id) throw platformError({ statusCode: 503, message: '预设路由引用的预设不可用' })
  const value = !row || row.mode === 'bypass' ? null : view(row)
  if (generation === routeCacheGeneration) {
    routeCache.delete(key)
    if (routeCache.size >= 128) routeCache.delete(routeCache.keys().next().value!)
    routeCache.set(key, { value, until: Date.now() + 2000 })
  }
  return value
}
