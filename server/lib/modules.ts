import { platformError as createError } from './platform-error'
import { getDb } from './db'
import { MODULE_MANIFESTS, findModule, type ModuleView } from '../../shared/modules'
import { commandcodeProviderHealthy } from './commandcode-health'
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
  const enabled = rows[0]?.enabled !== false
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
  const [states, cpa, commandcodeHealthy] = await Promise.all([
    getDb()`SELECT id,enabled FROM platform_modules`,
    createCpaClient().status(),
    commandcodeProviderHealthy(),
  ])
  return MODULE_MANIFESTS.map(manifest => {
    const enabled = manifest.required || states.find(state => state.id === manifest.id)?.enabled !== false
    if (!enabled) return { ...manifest, enabled, status: 'disabled', message: '新调用和新同步任务已暂停；进行中的任务会正常结束。' }
    if (manifest.id === 'cpa') return {
      ...manifest, enabled, status: cpa.connected ? 'ready' : cpa.configured ? 'unavailable' : 'unconfigured',
      runtimeVersion: cpa.version,
      message: cpa.error?.message || '已连接 CPA 管理接口。',
    }
    if (manifest.id === 'commandcode') return {
      ...manifest, enabled, status: commandcodeHealthy ? 'ready' : 'unavailable',
      message: commandcodeHealthy ? '官方 Provider 模型目录已同步，账号池使用官方 API。' : '官方 Provider 目录尚未同步或更新失败，请刷新官方目录。',
    }
    if (manifest.id === 'platform') return { ...manifest, enabled, status: 'ready', message: '平台管理服务可访问。' }
    return { ...manifest, enabled, status: 'unconfigured', message: '此扩展尚未提供运行状态检查，请完成模块接入。' }
  })
}
