import { platformError as createError } from './platform-error'
import { getDb } from './db'
import { MODULE_MANIFESTS, findModule, isPoolModuleId, type ModuleView } from '../../shared/modules'
import { createCpaClient } from './cpa/client'

const stateCache = new Map<string, { enabled: boolean; until: number }>()
export function resetModuleCache() { stateCache.clear() }
export async function isModuleEnabled(id: string): Promise<boolean> {
  const manifest = findModule(id)
  if (!manifest) throw createError({ statusCode: 404, message: '模块不存在' })
  if (manifest.required) return true
  const cached = stateCache.get(id)
  if (cached && cached.until > Date.now()) return cached.enabled
  const rows = await getDb()`SELECT enabled FROM platform_modules WHERE id=${id}`
  const enabled = rows[0] ? rows[0].enabled === true : manifest.defaultEnabled !== false
  stateCache.set(id, { enabled, until: Date.now() + 2000 })
  return enabled
}
export async function requireModule(id: string) {
  if (!await isModuleEnabled(id)) throw createError({ statusCode: 503, message: '此模块已停用，请在模块管理中启用', data: { moduleId: id } })
}
export async function setModuleEnabled(id: string, enabled: boolean) {
  const manifest = findModule(id)
  if (!manifest) throw createError({ statusCode: 404, message: '模块不存在' })
  if (manifest.required && !enabled) throw createError({ statusCode: 409, message: '核心模块是平台运行的依赖，不能停用' })
  await getDb()`INSERT INTO platform_modules(id,enabled) VALUES(${id},${enabled})
    ON CONFLICT(id) DO UPDATE SET enabled=EXCLUDED.enabled,updated_at=now()`
  stateCache.delete(id)
  return { id, enabled }
}
export async function listModules(): Promise<ModuleView[]> {
  // Loaded lazily: pool modules import platform services that import this file.
  const { poolModule } = await import('../modules/registry')
  const [states, cpa] = await Promise.all([getDb()`SELECT id,enabled FROM platform_modules`, createCpaClient().status()])
  return Promise.all(MODULE_MANIFESTS.map(async (manifest): Promise<ModuleView> => {
    const state = states.find(state => state.id === manifest.id)
    const enabled = manifest.required || (state ? state.enabled === true : manifest.defaultEnabled !== false)
    if (!enabled) return { ...manifest, enabled, status: 'disabled', message: '新调用和新同步任务已暂停；进行中的任务会正常结束，账号与配置保留。' }
    if (manifest.id === 'cpa') return {
      ...manifest, enabled, status: cpa.connected ? 'ready' : cpa.configured ? 'unavailable' : 'unconfigured',
      runtimeVersion: cpa.version,
      message: cpa.error?.message || '已连接 CPA 管理接口。',
    }
    if (isPoolModuleId(manifest.id)) {
      try { return { ...manifest, enabled, ...await poolModule(manifest.id).health() } }
      catch { return { ...manifest, enabled, status: 'unavailable', message: '模块状态暂时无法读取，请检查数据库与 Redis。' } }
    }
    if (manifest.id === 'platform') return { ...manifest, enabled, status: 'ready', message: '平台管理服务可访问。' }
    if (manifest.id === 'presets') return { ...manifest, enabled, status: 'ready', message: '已启用；每个调用分组按自己的设置叠加预设，没有开启预设的分组按原样调用。' }
    return { ...manifest, enabled, status: 'unconfigured', message: '此扩展尚未提供运行状态检查，请完成模块接入。' }
  }))
}
