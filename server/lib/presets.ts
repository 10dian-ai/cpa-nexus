import { randomUUID } from 'node:crypto'
import type { TransactionSql } from 'postgres'
import { getDb } from './db'
import { isModuleEnabled } from './modules'
import { findModule } from '../../shared/modules'
import { ensureCpaPresetAccountRoute } from './cpa/preset-routing'
import { platformError } from './platform-error'
import { inspectPreset, parsePresetJson, validatePresetVariables } from './presets/engine'
import type { GroupPresetBinding, GroupPresetSummary, GroupPresetView, KeyPresetBinding, KeyPresetRouteInput, PresetBinding, PresetRouteInput, PresetView, PresetSummary } from '../../shared/presets'

type PresetRow = Record<string, any>
export interface PresetWriteInput { name: string; description?: string; sourceJson: unknown; variables?: unknown; enabled?: boolean; sortOrder?: number }
const idValid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
const missing = () => platformError({ statusCode: 404, message: '预设不存在' })
const iso = (value: unknown) => new Date(value as string).toISOString()
const summary = (row: PresetRow): PresetSummary => ({ id: row.id, name: row.name, enabled: row.enabled === true, sortOrder: Number(row.sort_order || 0), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })
const view = (row: PresetRow): PresetView => ({ ...summary(row), description: row.description, sourceJson: row.source_json, variables: row.variables, compatibility: inspectPreset(row.source_json, row.variables) })
const groupBindingView = (row: PresetRow): GroupPresetBinding => ({
  groupId: row.group_id, presetId: row.preset_id,
  enabled: row.enabled === null || row.enabled === undefined ? null : row.enabled === true,
  sortOrder: row.sort_order === null || row.sort_order === undefined ? null : Number(row.sort_order),
  sourceJson: row.source_json ?? null, variables: row.variables ?? null, updatedAt: iso(row.updated_at),
})
const groupView = (row: PresetRow): GroupPresetView => {
  const inherited = row.group_binding_id === null || row.group_binding_id === undefined
  const sourceJson = row.group_source_json ?? row.source_json
  const variables = row.group_variables ?? row.variables
  const enabled = row.group_enabled === null || row.group_enabled === undefined ? row.enabled : row.group_enabled
  const sortOrder = row.group_sort_order === null || row.group_sort_order === undefined ? row.sort_order : row.group_sort_order
  return {
    ...view({ ...row, enabled, sort_order: sortOrder, source_json: sourceJson, variables }),
    groupId: row.group_context_id ?? row.group_id ?? row.group_binding_id,
    inherited,
    overrides: {
      enabled: row.group_enabled === null || row.group_enabled === undefined ? null : row.group_enabled === true,
      sortOrder: row.group_sort_order === null || row.group_sort_order === undefined ? null : Number(row.group_sort_order),
      sourceJson: row.group_source_json ?? null,
      variables: row.group_variables ?? null,
    },
  }
}
const bindingView = (row: PresetRow): PresetBinding => ({ moduleId: row.module_id, accountId: row.account_id || null, mode: row.mode, presetId: row.preset_id || null, updatedAt: iso(row.updated_at) })
const keyBindingView = (row: PresetRow): KeyPresetBinding => ({ keyId: row.key_id, moduleId: row.module_id, mode: row.mode, presetId: row.preset_id || null, updatedAt: iso(row.updated_at) })
const routeCache = new Map<string, { value: PresetView | null; until: number }>()
const stackKeyCache = new Map<string, { mode: 'stack' | 'preset' | 'bypass' | null; presetId: string | null; groupIds: string[]; hasGroupOverride: boolean; until: number }>()
const groupStackCache = new Map<string, { value: PresetView[]; until: number }>()
let enabledStackCache: { value: PresetView[]; until: number } | undefined
let enabledStackLoading: { generation: number; promise: Promise<PresetView[]> } | undefined
let routeCacheGeneration = 0
export function resetPresetRouteCache() { routeCache.clear(); stackKeyCache.clear(); groupStackCache.clear(); enabledStackCache = undefined; enabledStackLoading = undefined; routeCacheGeneration++ }
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
  const rows = await sql`SELECT 1 FROM nexus_key_preset_bindings WHERE preset_id=${id}
    UNION ALL SELECT 1 FROM nexus_group_preset_bindings WHERE preset_id=${id} LIMIT 1`
  return rows.length > 0
}
export async function listPresets(groupId?: string): Promise<Array<PresetView | GroupPresetView>> {
  if (!groupId) return (await getDb()`SELECT * FROM nexus_presets ORDER BY sort_order,id`).map(view)
  if (!idValid(groupId)) throw platformError({ statusCode: 400, message: '请选择有效分组' })
  const group = (await getDb()`SELECT id FROM nexus_groups WHERE id=${groupId}`)[0]
  if (!group) throw platformError({ statusCode: 404, message: '分组不存在' })
  const rows = await getDb()`SELECT p.*,${groupId} AS group_context_id,b.group_id AS group_binding_id,b.enabled AS group_enabled,b.sort_order AS group_sort_order,
      b.source_json AS group_source_json,b.variables AS group_variables
    FROM nexus_presets p LEFT JOIN nexus_group_preset_bindings b ON b.preset_id=p.id AND b.group_id=${groupId}
    ORDER BY COALESCE(b.sort_order,p.sort_order),p.id`
  return rows.map(groupView)
}
export async function listPresetSummaries(groupId?: string): Promise<Array<PresetSummary | GroupPresetSummary>> {
  if (groupId) {
    if (!idValid(groupId)) throw platformError({ statusCode: 400, message: '请选择有效分组' })
    if (!(await getDb()`SELECT id FROM nexus_groups WHERE id=${groupId}`)[0]) throw platformError({ statusCode: 404, message: '分组不存在' })
    const rows = await getDb()`SELECT p.id,p.name,p.enabled,p.sort_order,p.created_at,p.updated_at,${groupId} AS group_context_id,
        b.group_id AS group_binding_id,b.enabled AS group_enabled,b.sort_order AS group_sort_order
      FROM nexus_presets p LEFT JOIN nexus_group_preset_bindings b ON b.preset_id=p.id AND b.group_id=${groupId}
      ORDER BY COALESCE(b.sort_order,p.sort_order),p.id`
    return rows.map(row => ({
      ...summary({ ...row, enabled: row.group_enabled === null || row.group_enabled === undefined ? row.enabled : row.group_enabled,
        sort_order: row.group_sort_order === null || row.group_sort_order === undefined ? row.sort_order : row.group_sort_order }),
      groupId, inherited: row.group_binding_id === null || row.group_binding_id === undefined,
      overrides: { enabled: row.group_enabled === null || row.group_enabled === undefined ? null : row.group_enabled === true,
        sortOrder: row.group_sort_order === null || row.group_sort_order === undefined ? null : Number(row.group_sort_order) },
    }))
  }
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
    if (!value.compatibility.supported && (enabled || await presetIsBound(tx, id))) throw platformError({ statusCode: 409, message: '这个预设正在启用、被分组使用或被旧路由使用，不能保存会导致调用失败的内容；请先关闭预设或解除绑定', data: { issues: value.compatibility.issues } })
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

export interface GroupPresetWriteInput {
  groupId: string
  presetId: string
  enabled?: boolean | null
  sortOrder?: number | null
  sourceJson?: unknown | null
  variables?: unknown | null
  reset?: boolean
}

function validateGroupPresetIds(groupId: string, presetId: string) {
  if (!idValid(groupId)) throw platformError({ statusCode: 400, message: '请选择有效分组' })
  if (!idValid(presetId)) throw missing()
}

/** Return one preset's effective configuration for a routing group. */
export async function getGroupPreset(groupId: string, presetId: string): Promise<GroupPresetView> {
  validateGroupPresetIds(groupId, presetId)
  const rows = await getDb()`SELECT p.*,${groupId} AS group_context_id,b.group_id AS group_binding_id,b.enabled AS group_enabled,b.sort_order AS group_sort_order,
      b.source_json AS group_source_json,b.variables AS group_variables
    FROM nexus_presets p LEFT JOIN nexus_group_preset_bindings b ON b.preset_id=p.id AND b.group_id=${groupId}
    WHERE p.id=${presetId}`
  if (!rows[0]) throw missing()
  if (!(await getDb()`SELECT id FROM nexus_groups WHERE id=${groupId}`)[0]) throw platformError({ statusCode: 404, message: '分组不存在' })
  return groupView(rows[0])
}

/** List persisted overrides only; useful to distinguish inherited values in management UIs. */
export async function listGroupPresetBindings(groupId: string): Promise<GroupPresetBinding[]> {
  if (!idValid(groupId)) throw platformError({ statusCode: 400, message: '请选择有效分组' })
  if (!(await getDb()`SELECT id FROM nexus_groups WHERE id=${groupId}`)[0]) throw platformError({ statusCode: 404, message: '分组不存在' })
  return (await getDb()`SELECT group_id,preset_id,enabled,sort_order,source_json,variables,updated_at
    FROM nexus_group_preset_bindings WHERE group_id=${groupId} ORDER BY sort_order NULLS LAST,preset_id`).map(groupBindingView)
}

/**
 * Upsert partial group overrides. Null fields explicitly reset that field to
 * the global library value; omitted fields retain their current override.
 */
export async function setGroupPresetBinding(input: GroupPresetWriteInput): Promise<GroupPresetView> {
  validateGroupPresetIds(input.groupId, input.presetId)
  if (input.enabled !== undefined && input.enabled !== null && typeof input.enabled !== 'boolean') throw platformError({ statusCode: 400, message: '预设启用状态无效' })
  if (input.sortOrder !== undefined && input.sortOrder !== null && (!Number.isSafeInteger(input.sortOrder) || input.sortOrder < 0)) throw platformError({ statusCode: 400, message: '预设顺序必须是非负整数' })
  const sql = getDb()
  const result = await sql.begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('nexus:presets:write',0))`
    const group = (await tx`SELECT id FROM nexus_groups WHERE id=${input.groupId} FOR KEY SHARE`)[0]
    if (!group) throw platformError({ statusCode: 404, message: '分组不存在' })
    const preset = (await tx`SELECT * FROM nexus_presets WHERE id=${input.presetId} FOR KEY SHARE`)[0]
    if (!preset) throw missing()
    if (input.reset) {
      await tx`DELETE FROM nexus_group_preset_bindings WHERE group_id=${input.groupId} AND preset_id=${input.presetId}`
    } else {
      const current = (await tx`SELECT enabled,sort_order,source_json,variables FROM nexus_group_preset_bindings WHERE group_id=${input.groupId} AND preset_id=${input.presetId} FOR UPDATE`)[0]
      const sourceOverride = input.sourceJson !== undefined
        ? (input.sourceJson === null ? null : parsePresetJson(input.sourceJson))
        : current?.source_json ?? null
      const variablesOverride = input.variables !== undefined
        ? (input.variables === null ? null : validatePresetVariables(input.variables))
        : current?.variables ?? null
      const effectiveSource = sourceOverride ?? preset.source_json
      const effectiveVariables = variablesOverride ?? preset.variables
      const enabled = input.enabled !== undefined ? input.enabled : current?.enabled ?? null
      const effectiveEnabled = enabled === null ? preset.enabled === true : enabled === true
      const compatibility = inspectPreset(effectiveSource, effectiveVariables)
      if (effectiveEnabled && !compatibility.supported) throw platformError({ statusCode: 422, message: '预设尚未兼容，请修复提示词或填写变量后再启用', data: { issues: compatibility.issues } })
      const sortOrder = input.sortOrder !== undefined ? input.sortOrder : current?.sort_order ?? null
      // A completely empty row has exactly the inherited semantics; remove it
      // so that runtime can keep using the global stack fast path.
      if (enabled === null && sortOrder === null && sourceOverride === null && variablesOverride === null) {
        await tx`DELETE FROM nexus_group_preset_bindings WHERE group_id=${input.groupId} AND preset_id=${input.presetId}`
      } else {
        await tx`INSERT INTO nexus_group_preset_bindings(group_id,preset_id,enabled,sort_order,source_json,variables,updated_at)
          VALUES(${input.groupId},${input.presetId},${enabled},${sortOrder},${sourceOverride === null ? null : tx.json(sourceOverride as any)},${variablesOverride === null ? null : tx.json(variablesOverride)},now())
          ON CONFLICT(group_id,preset_id) DO UPDATE SET enabled=EXCLUDED.enabled,sort_order=EXCLUDED.sort_order,
            source_json=EXCLUDED.source_json,variables=EXCLUDED.variables,updated_at=now()`
      }
    }
    return true
  })
  void result
  resetPresetRouteCache()
  return getGroupPreset(input.groupId, input.presetId)
}

/** Reorder every preset for one group, preserving inherited enabled/content values. */
export async function reorderGroupPresets(groupId: string, ids: string[]): Promise<GroupPresetView[]> {
  if (!idValid(groupId)) throw platformError({ statusCode: 400, message: '请选择有效分组' })
  if (!Array.isArray(ids) || ids.some(id => !idValid(id)) || new Set(ids).size !== ids.length) throw platformError({ statusCode: 400, message: '预设顺序包含无效或重复项目' })
  await getDb().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('nexus:presets:write',0))`
    if (!(await tx`SELECT id FROM nexus_groups WHERE id=${groupId} FOR KEY SHARE`).length) throw platformError({ statusCode: 404, message: '分组不存在' })
    const rows = await tx`SELECT id FROM nexus_presets ORDER BY sort_order,id FOR UPDATE`
    const existing = new Set(rows.map(row => row.id))
    if (rows.length !== ids.length || ids.some(id => !existing.has(id))) throw platformError({ statusCode: 409, message: '预设列表已经变化，请刷新后重新排序' })
    for (let order = 0; order < ids.length; order++) {
      await tx`INSERT INTO nexus_group_preset_bindings(group_id,preset_id,sort_order)
        VALUES(${groupId},${ids[order]!},${order})
        ON CONFLICT(group_id,preset_id) DO UPDATE SET sort_order=EXCLUDED.sort_order,updated_at=now()`
    }
  })
  resetPresetRouteCache()
  return (await listPresets(groupId)) as GroupPresetView[]
}
export async function deletePreset(id: string) {
  if (!idValid(id)) throw missing()
  const result = await getDb().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended('nexus:presets:write',0))`
    if (await presetIsBound(tx, id)) throw platformError({ statusCode: 409, message: '预设仍被 API key、分组或旧路由使用，请先解除绑定' })
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
  return (await getDb()`SELECT b.*,k.module_id FROM nexus_key_preset_bindings b JOIN gateway_keys k ON k.id=b.key_id WHERE left(k.prefix,10)<>'ccm_nexus_' AND k.module_id IN ('commandcode','cpa','devin2api','auto') ORDER BY b.updated_at DESC,b.key_id LIMIT 10000`).map(keyBindingView)
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
    const key = (await tx`SELECT id,module_id FROM gateway_keys WHERE id=${input.keyId} AND left(prefix,10)<>'ccm_nexus_' AND module_id IN ('commandcode','cpa','devin2api','auto') FOR KEY SHARE`)[0]
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
export async function resolveKeyPresetStack(keyId: string, enabledGroupIds?: string[]): Promise<PresetView[]> {
  if (!await isModuleEnabled('presets')) return []
  const generation = routeCacheGeneration
  let choice = stackKeyCache.get(keyId)
  if (!choice || choice.until <= Date.now()) {
    // Keep this query's leading columns stable for older integrations while
    // exposing the enabled routing groups used by group-specific stacks.
    const row = (await getDb()`SELECT b.mode,b.preset_id,
      COALESCE((SELECT array_agg(g2.id ORDER BY g2.created_at,g2.id)
        FROM nexus_key_groups kg2 JOIN nexus_groups g2 ON g2.id=kg2.group_id
        WHERE kg2.key_id=b.key_id AND g2.enabled=true), ARRAY[]::uuid[]) AS group_ids,
      EXISTS(SELECT 1 FROM nexus_key_groups kg3 JOIN nexus_groups g3 ON g3.id=kg3.group_id
        JOIN nexus_group_preset_bindings gp3 ON gp3.group_id=g3.id
        WHERE kg3.key_id=b.key_id AND g3.enabled=true) AS has_group_override
      FROM nexus_key_preset_bindings b JOIN gateway_keys k ON k.id=b.key_id
      WHERE b.key_id=${keyId} AND left(k.prefix,10)<>'ccm_nexus_' AND k.module_id IN ('commandcode','cpa','devin2api','auto') LIMIT 1`)[0]
    choice = { mode: row?.mode || null, presetId: row?.preset_id || null,
      // Cache the database-derived groups only. A caller-provided scope is a
      // per-request view and must never poison the key cache for later calls.
      groupIds: Array.isArray(row?.group_ids) ? row.group_ids.map(String) : [],
      hasGroupOverride: row?.has_group_override === true, until: Date.now() + 2000 }
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
  const groupIds = enabledGroupIds ?? choice.groupIds
  const hasGroupOverride = enabledGroupIds
    ? (groupIds.length > 0 && (await getDb()`SELECT 1 FROM nexus_group_preset_bindings WHERE group_id IN ${getDb()(groupIds)} LIMIT 1`).length > 0)
    : choice.hasGroupOverride
  if (hasGroupOverride && groupIds.length) {
    const cacheKey = `group-stack\0${groupIds.join(',')}`
    const cached = groupStackCache.get(cacheKey)
    if (cached && cached.until > Date.now()) return cached.value
    const promiseRows = await Promise.all(groupIds.map(groupId => getDb()`SELECT p.*,${groupId} AS group_context_id,b.group_id AS group_binding_id,b.enabled AS group_enabled,
        b.sort_order AS group_sort_order,b.source_json AS group_source_json,b.variables AS group_variables
      FROM nexus_presets p LEFT JOIN nexus_group_preset_bindings b ON b.group_id=${groupId} AND b.preset_id=p.id
      WHERE COALESCE(b.enabled,p.enabled)=true ORDER BY COALESCE(b.sort_order,p.sort_order),p.id`))
    // A key may span several groups.  Each group's query is ordered by its
    // effective order, but concatenating those result sets would make the
    // final stack depend on the UUID/creation order of the groups.  Keep the
    // first group's effective content for duplicate presets, then merge with
    // a deterministic order: group override order, global library order, ID.
    const merged: Array<{ preset: PresetView; order: number; globalOrder: number }> = [], seen = new Set<string>()
    for (const rows of promiseRows) for (const row of rows) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      merged.push({
        preset: groupView(row),
        order: Number(row.group_sort_order ?? row.sort_order ?? 0),
        globalOrder: Number(row.sort_order ?? 0),
      })
    }
    merged.sort((a, b) => a.order - b.order || a.globalOrder - b.globalOrder || a.preset.id.localeCompare(b.preset.id))
    const ordered = merged.map(item => item.preset)
    if (generation === routeCacheGeneration) {
      if (groupStackCache.size >= 128) groupStackCache.delete(groupStackCache.keys().next().value!)
      groupStackCache.set(cacheKey, { value: ordered, until: Date.now() + 2000 })
    }
    return ordered
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
  const rows = await getDb()`SELECT b.mode,p.* FROM nexus_key_preset_bindings b JOIN gateway_keys k ON k.id=b.key_id LEFT JOIN nexus_presets p ON p.id=b.preset_id WHERE b.key_id=${keyId} AND left(k.prefix,10)<>'ccm_nexus_' AND k.module_id IN ('commandcode','cpa','devin2api','auto') LIMIT 1`
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
  if (moduleId === 'devin2api') {
    if (!idValid(accountId) || !(await getDb()`SELECT id FROM devin2api_accounts WHERE id=${accountId}`).length) throw platformError({ statusCode: 404, message: 'Devin 2API 账号不存在' })
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
