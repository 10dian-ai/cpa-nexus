import { POOL_MODULE_ALIASES, isPoolModuleId, type PoolModuleId } from '../../../shared/modules'
import { isModuleEnabled } from '../modules'
import { groupModels as logiccGroupModels } from '../../modules/logicc/store'

/** A requested model may name a pool module explicitly (`logicc/gpt-4`) or be a bare name. */
export function parsePoolModel(model: string): { moduleId: PoolModuleId; nativeModel: string } | { moduleId: null; nativeModel: string } {
  const slash = model.indexOf('/')
  if (slash > 0) {
    const alias = model.slice(0, slash)
    const moduleId = (Object.keys(POOL_MODULE_ALIASES) as PoolModuleId[]).find(id => POOL_MODULE_ALIASES[id] === alias)
    if (moduleId) return { moduleId, nativeModel: model.slice(slash + 1) }
  }
  return { moduleId: null, nativeModel: model }
}

/** Models each of the given call groups can serve through one pool module. */
export async function poolGroupModels(moduleId: PoolModuleId, groupIds: string[]): Promise<Map<string, string[]>> {
  if (moduleId === 'logicc') return logiccGroupModels(groupIds)
  return new Map()
}

/** Pool modules that are switched on. */
export async function enabledPoolModules(): Promise<PoolModuleId[]> {
  const ids = Object.keys(POOL_MODULE_ALIASES) as PoolModuleId[]
  const enabled = await Promise.all(ids.map(id => isModuleEnabled(id).catch(() => false)))
  return ids.filter((_, index) => enabled[index])
}

/**
 * For each enabled pool module the request may use, the groups (among the
 * key's) that serve the model, mapped to the native model id to request.
 * `restrictTo` limits this to one module when the client named it by alias.
 */
export async function resolvePoolGroups(model: string, groupIds: string[], restrictTo?: PoolModuleId | null): Promise<Map<PoolModuleId, Map<string, string>>> {
  const result = new Map<PoolModuleId, Map<string, string>>()
  if (!groupIds.length) return result
  const parsed = parsePoolModel(model)
  const moduleIds = restrictTo ? [restrictTo] : parsed.moduleId ? [parsed.moduleId] : (Object.keys(POOL_MODULE_ALIASES) as PoolModuleId[])
  const native = parsed.moduleId ? parsed.nativeModel : model
  for (const moduleId of moduleIds) {
    if (!isPoolModuleId(moduleId) || !await isModuleEnabled(moduleId)) continue
    const served = await poolGroupModels(moduleId, groupIds).catch(() => new Map<string, string[]>())
    const groups = new Map<string, string>()
    for (const groupId of groupIds) if (served.get(groupId)?.includes(native)) groups.set(groupId, native)
    if (groups.size) result.set(moduleId, groups)
  }
  return result
}
