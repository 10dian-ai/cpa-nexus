import { randomUUID } from 'node:crypto'
import type { TransactionSql } from 'postgres'
import { getDb } from './db'
import { isModuleEnabled } from './modules'
import { findModule } from '../../shared/modules'
import { ensureCpaPresetAccountRoute } from './cpa/preset-routing'
import { platformError } from './platform-error'
import { inspectPreset, parsePresetJson, validatePresetVariables } from './presets/engine'
import type { KeyPresetBinding, KeyPresetRouteInput, PresetBinding, PresetRouteInput, PresetView, PresetSummary } from '../../shared/presets'

type PresetRow = Record<string, any>
export interface PresetWriteInput { name: string; description?: string; sourceJson: unknown; variables?: unknown; enabled?: boolean; sortOrder?: number }
const idValid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
const missing = () => platformError({ statusCode: 404, message: '预设不存在' })
const iso = (value: unknown) => new Date(value as string).toISOString()
const summary = (row: PresetRow): PresetSummary => ({ id: row.id, name: row.name, enabled: row.enabled === true, sortOrder: Number(row.sort_order || 0), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })
const view = (row: PresetRow): PresetView => ({ ...summary(row), description: row.description, sourceJson: row.source_json, variables: row.variables, compatibility: inspectPreset(row.source_json, row.variables) })
const bindingView = (row: PresetRow): PresetBinding => ({ moduleId: row.module_id, accountId: row.account_id || null, mode: row.mode, presetId: row.preset_id || null, updatedAt: iso(row.updated_at) })
const keyBindingView = (row: PresetRow): KeyPresetBinding => ({ keyId: row.key_id, moduleId: row.module_id, mode: row.mode, presetId: row.preset_id || null, updatedAt: iso(row.updated_at) })
const routeCache = new Map<string, { value: PresetView | null; until: number }>()
const stackKeyCache = new Map<string, { mode: 'stack' | 'preset' | 'bypass' | null; presetId: string | null; until: number }>()
let enabledStackCache: { value: PresetView[]; until: number } | undefined
let enabledStackLoading: { generation: number; promise: Promise<PresetView[]> } | undefined
let routeCacheGeneration = 0
export function resetPresetRouteCache() { routeCache.clear(); stackKeyCache.clear(); enabledStackCache = undefined; enabledStackLoading = undefined; routeCacheGeneration++ }
function writeInput(input: PresetWriteInput) {
  const name = input.name?.trim()
  if (!name) throw platformError({ statusCode: 400, message: '请填写预设名称' })
  const description = input.description ?? ''
  if (typeof description !== 'string') throw platformError({ statusCode: 400, message: '预设说明必须是文本' })
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw platformError({ statusCode: 400, message: '预设启用状态无效' })
  if (input.sortOrder !== undefined && (!Number.isSafeInteger(input.sortOrder) || input.sortOrder < 0)) throw platformError({ statusCode: 400, message: '预设顺序必须是非负整数' })
  const sourceJson = parsePresetJson(input.sourceJson), variables = validatePresetVariables(input.variables)
  return { name, description, sourceJson, variables, compatibility: inspectPreset(sourceJson, variables) }
}
export const validatePreset = writeInput
async function presetIsBound(sql: TransactionSql, id: string) {
  if ((await sql`SELECT 1 FROM nexus_preset_bindings WHERE preset_id=${id} LIMIT 1`).length) return true
  return (await sql`SELECT 1 FROM nexus_key_preset_bindings WHERE preset_id=${id} LIMIT 1`).length > 0
}
export async function listPresets(): Promise<PresetView[]> {
  return (await getDb()`SELECT * FROM nexus_presets ORDER BY sort_order,id`).map(view)
}
export async function listPresetSummaries(): Promise<PresetSummary[]> {
  const rows = await getDb()`SELECT id,name,enabled,sort_order,created_at,updated_at FROM nexus_presets ORDER BY sort_order,id`
  return rows.map(summary)
}
export async function getPreset(id: string): Promise<PresetView> {
  if (!idValid(id)) throw missing()
  const rows = await getDb()`SELECT * FROM nexus_presets WHERE id=${id}`
  if (!rows[0]) throw missing()
  return view(rows[0])
}
export async function createPreset(input: PresetWriteInput): Promise<PresetView> {
  const value = writeInput(input), sql = getDb()
  if (input.enabled && !value.compatibility.supported) throw platformError({ statusCode: 422, message: '预设尚未兼容，请修复提示词或填写变量后再启用', data: { issues: value.compatibility.issues } })
  const result = await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('nexus:presets:write',0))`
    const order = input.sortOrder ?? Number((await tx`SELECT COALESCE(MAX(sort_order),-1)+1 AS next_order FROM nexus_presets`)[0]!.next_order)
    const rows = await tx`INSERT INTO nexus_presets(id,name,description,source_json,variables,enabled,sort_order) VALUES(${randomUUID()},${value.name},${value.description},${tx.json(value.sourceJson as any)},${tx.json(value.variables)},${input.enabled ?? false},${order}) RETURNING *`
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
    const enabled = input.enabled ?? current.enabled === true, sortOrder = input.sortOrder ?? Number(current.sort_order || 0)
    const value = writeInput({ name: input.name ?? current.name, description: input.description ?? current.description, sourceJson: input.sourceJson ?? current.source_json, variables: input.variables ?? current.variables, enabled, sortOrder })
    if (!value.compatibility.supported && (enabled || await presetIsBound(tx, id))) throw platformError({ statusCode: 409, message: '这个预设正在启用或被旧路由使用，不能保存会导致调用失败的内容；请先关闭预设或解除旧绑定', data: { issues: value.compatibility.issues } })
    const rows = await tx`UPDATE nexus_presets SET name=${value.name},description=${value.description},source_json=${tx.json(value.sourceJson as any)},variables=${tx.json(value.variables)},enabled=${enabled},sort_order=${sortOrder},updated_at=now() WHERE id=${id} RETURNING *`
    return view(rows[0]!)
  }) as unknown as PresetView
  resetPresetRouteCache()
  return result
}
/** Reorder a complete library under the same lock as create/delete and enable. */
export async function reorderPresets(ids: string[]): Promise<PresetSummary[]> {
  if (!Array.isArray(ids) || ids.some(id => !idValid(id)) || new Set(ids).size !== ids.length) throw platformError({ statusCode: 400, message: '预设顺序包含无效或重复项目' })
  const result = await getDb().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('nexus:presets:write',0))`
    const rows = await tx`SELECT id,name,enabled,sort_order,created_at,updated_at FROM nexus_presets ORDER BY sort_order,id FOR UPDATE`
    const existing = new Set(rows.map(row => row.id))
    if (rows.length !== ids.length || ids.some(id => !existing.has(id))) throw platformError({ statusCode: 409, message: '预设列表已经变化，请刷新后重新排序' })
    const updated: PresetSummary[] = []
    for (let order = 0; order < ids.length; order++) {
      const row = (await tx`UPDATE nexus_presets SET sort_order=${order},updated_at=now() WHERE id=${ids[order]!} RETURNING id,name,enabled,sort_order,created_at,updated_at`)[0]!
      updated.push(summary(row))
    }
    return updated
  }) as unknown as PresetSummary[]
  resetPresetRouteCache()
  return result
}
export async function deletePreset(id: string) {
  if (!idValid(id)) throw missing()
  const result = await getDb().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('nexus:presets:write',0))`
    if (await presetIsBound(tx, id)) throw platformError({ statusCode: 409, message: '预设仍被 API key 或旧路由使用，请先解除绑定' })
    if (!(await tx`DELETE FROM nexus_presets WHERE id=${id} RETURNING id`).length) throw missing()
    return { deleted: true }
  })
  resetPresetRouteCache()
  return result
}
export async function listPresetBindings(): Promise<PresetBinding[]> {
  return (await getDb()`SELECT * FROM nexus_preset_bindings ORDER BY module_id,account_id LIMIT 10000`).map(bindingView)
}
export async function listKeyPresetBindings(): Promise<KeyPresetBinding[]> {
  return (await getDb()`SELECT b.*,k.module_id FROM nexus_key_preset_bindings b JOIN gateway_keys k ON k.id=b.key_id WHERE left(k.prefix,10)<>'ccm_nexus_' AND k.module_id IN ('commandcode','cpa') ORDER BY b.updated_at DESC,b.key_id LIMIT 10000`).map(keyBindingView)
}
export async function setKeyPresetBinding(input: KeyPresetRouteInput): Promise<KeyPresetBinding | null> {
  if (!idValid(input.keyId)) throw platformError({ statusCode: 400, message: '请选择有效的模型 API key' })
  if (!['inherit', 'bypass', 'preset', 'stack'].includes(input.mode)) throw platformError({ statusCode: 400, message: '路由模式无效' })
  if (input.mode === 'preset' && (!input.presetId || !idValid(input.presetId))) throw platformError({ statusCode: 400, message: '请选择有效预设' })
  if (input.mode !== 'preset' && input.presetId) throw platformError({ statusCode: 400, message: '默认或直连模式不能指定预设' })
  const result = await getDb().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('nexus:presets:write',0))`
    // Removing an obsolete binding also works after a key has been revoked.
    if (input.mode === 'inherit') { await tx`DELETE FROM nexus_key_preset_bindings WHERE key_id=${input.keyId}`; return null }
    const key = (await tx`SELECT id,module_id FROM gateway_keys WHERE id=${input.keyId} AND left(prefix,10)<>'ccm_nexus_' AND module_id IN ('commandcode','cpa') FOR KEY SHARE`)[0]
    if (!key) throw platformError({ statusCode: 404, message: '模型 API key 不存在，内部桥接密钥和外调服务密钥不能绑定预设' })
    if (input.mode === 'preset') {
      const row = (await tx`SELECT * FROM nexus_presets WHERE id=${input.presetId!}`)[0]
      if (!row) throw missing()
      const compatibility = inspectPreset(row.source_json, row.variables)
      if (!compatibility.supported) throw platformError({ statusCode: 422, message: '预设尚未兼容，请修复提示词或填写变量后再绑定', data: { issues: compatibility.issues } })
    }
    const rows = await tx`INSERT INTO nexus_key_preset_bindings(key_id,mode,preset_id) VALUES(${input.keyId},${input.mode},${input.mode === 'preset' ? input.presetId! : null}) ON CONFLICT(key_id) DO UPDATE SET mode=EXCLUDED.mode,preset_id=EXCLUDED.preset_id,updated_at=now() RETURNING *`
    return keyBindingView({ ...rows[0], module_id: key.module_id })
  }) as unknown as KeyPresetBinding | null
  resetPresetRouteCache()
  return result
}

/** Called by model-key mutations inside their transaction. */
export async function saveKeyPresetMode(tx: TransactionSql, keyId: string, enabled: boolean): Promise<void> {
  await tx`INSERT INTO nexus_key_preset_bindings(key_id,mode,preset_id) VALUES(${keyId},${enabled ? 'stack' : 'bypass'},${null}) ON CONFLICT(key_id) DO UPDATE SET mode=EXCLUDED.mode,preset_id=NULL,updated_at=now()`
}

/** Stack-enabled keys share all enabled presets, ordered by the library. */
export async function resolveKeyPresetStack(keyId: string): Promise<PresetView[]> {
  if (!await isModuleEnabled('presets')) return []
  const generation = routeCacheGeneration
  let choice = stackKeyCache.get(keyId)
  if (!choice || choice.until <= Date.now()) {
    const row = (await getDb()`SELECT b.mode,b.preset_id FROM nexus_key_preset_bindings b JOIN gateway_keys k ON k.id=b.key_id WHERE b.key_id=${keyId} AND left(k.prefix,10)<>'ccm_nexus_' AND k.module_id IN ('commandcode','cpa') LIMIT 1`)[0]
    choice = { mode: row?.mode || null, presetId: row?.preset_id || null, until: Date.now() + 2000 }
    if (generation === routeCacheGeneration) {
      if (stackKeyCache.size >= 128) stackKeyCache.delete(stackKeyCache.keys().next().value!)
      stackKeyCache.set(keyId, choice)
    }
  }
  if (!choice.mode || choice.mode === 'bypass') return []
  if (choice.mode === 'preset') {
    const cacheKey = `legacy\0${choice.presetId}`, cached = routeCache.get(cacheKey)
    if (cached?.value && cached.until > Date.now()) return [cached.value]
    if (!choice.presetId) throw platformError({ statusCode: 503, message: 'API key 绑定的预设不可用' })
    let preset: PresetView
    try { preset = await getPreset(choice.presetId) } catch (error) {
      if (Number((error as { statusCode?: number }).statusCode) === 404) throw platformError({ statusCode: 503, message: 'API key 绑定的预设不可用' })
      throw error
    }
    if (generation === routeCacheGeneration) {
      if (routeCache.size >= 128) routeCache.delete(routeCache.keys().next().value!)
      routeCache.set(cacheKey, { value: preset, until: Date.now() + 2000 })
    }
    return [preset]
  }
  if (enabledStackCache && enabledStackCache.until > Date.now()) return enabledStackCache.value
  if (enabledStackLoading?.generation === generation) return enabledStackLoading.promise
  const promise = (async () => {
    const value = (await getDb()`SELECT * FROM nexus_presets WHERE enabled=true ORDER BY sort_order,id`).map(view)
    if (generation === routeCacheGeneration) enabledStackCache = { value, until: Date.now() + 2000 }
    return value
  })()
  enabledStackLoading = { generation, promise }
  try { return await promise } finally {
    if (enabledStackLoading?.promise === promise) enabledStackLoading = undefined
  }
}

/** A model key uses only its own explicit preset, never an account or module default. */
export async function resolveKeyPresetRoute(keyId: string): Promise<PresetView | null> {
  if (!await isModuleEnabled('presets')) return null
  const cacheKey = `key\0${keyId}`, cached = routeCache.get(cacheKey)
  if (cached && cached.until > Date.now()) return cached.value
  const generation = routeCacheGeneration
  const rows = await getDb()`SELECT b.mode,p.* FROM nexus_key_preset_bindings b JOIN gateway_keys k ON k.id=b.key_id LEFT JOIN nexus_presets p ON p.id=b.preset_id WHERE b.key_id=${keyId} AND left(k.prefix,10)<>'ccm_nexus_' AND k.module_id IN ('commandcode','cpa') LIMIT 1`
  const row = rows[0]
  if (row && row.mode === 'preset' && !row.id) throw platformError({ statusCode: 503, message: 'API key 绑定的预设不可用' })
  const value = !row || row.mode === 'bypass' ? null : row.mode === 'stack' ? (await resolveKeyPresetStack(keyId))[0] || null : view(row)
  if (generation === routeCacheGeneration) {
    routeCache.delete(cacheKey)
    if (routeCache.size >= 128) routeCache.delete(routeCache.keys().next().value!)
    routeCache.set(cacheKey, { value, until: Date.now() + 2000 })
  }
  return value
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
