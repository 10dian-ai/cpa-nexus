import { defineEventHandler, getQuery } from 'h3'
import { z } from 'zod'
import { validate } from '../../lib/account-validation'
import { getDb } from '../../lib/db'
import { accountGroupBindings } from '../../lib/groups'
import { listCpaGroupSources } from '../../lib/cpa/group-routing'
import { maskSession } from '../../modules/logicc/store'
import { GROUP_MODULE_IDS, type GroupAccountView, type GroupModuleId } from '../../../shared/groups'

/** Every source that can be bound to call groups: CPA kernel sources and pool-module accounts. */
export default defineEventHandler(async event => {
  const { moduleId } = validate(z.object({ moduleId: z.enum(GROUP_MODULE_IDS as [GroupModuleId, ...GroupModuleId[]]).optional() }), getQuery(event))
  const items: GroupAccountView[] = []
  const issues: { moduleId: GroupModuleId; message: string }[] = []
  if (!moduleId || moduleId === 'logicc') {
    try {
      const rows = await getDb()`SELECT id,label,session_id,enabled,status FROM logicc_accounts ORDER BY created_at DESC,id`
      const bindings = await accountGroupBindings('logicc', rows.map(row => String(row.id)))
      items.push(...rows.map(row => ({ id: String(row.id), sourceId: String(row.id), moduleId: 'logicc' as const, sourceType: 'logicc',
        name: row.label || maskSession(row.session_id) || String(row.id), provider: 'Logicc', enabled: row.enabled,
        ...(bindings.get(String(row.id)) ?? { groupIds: [], groupNames: [] }), routingSupported: true,
        ...(row.status === 'credential_expired' ? { message: '凭据已失效，请更新 __client Cookie 或 Session JWT' } : {}) })))
    } catch { issues.push({ moduleId: 'logicc', message: 'Logicc 账号暂时读取失败，请重试；尚未读取的账号不计为零，也不会更改其分组。' }) }
  }
  if (!moduleId || moduleId === 'cpa') {
    try {
      const sources = await listCpaGroupSources()
      items.push(...sources)
      const activeIds = new Set(sources.map(source => source.sourceId))
      const stored = await accountGroupBindings('cpa')
      for (const [sourceId, binding] of stored) if (!activeIds.has(sourceId)) items.push({
        id: sourceId, sourceId, moduleId: 'cpa', sourceType: 'cpa', name: sourceId, provider: 'CPA', enabled: false,
        ...binding, missing: true, routingSupported: false,
        message: '此来源当前未出现在 CPA 账号列表，分组授权仍被保留。确认来源已经删除后，可手动清理绑定；暂时未注册的来源应保留。',
      })
    } catch { issues.push({ moduleId: 'cpa', message: 'CPA 来源暂时读取失败，请检查核心连接后重试；原分组授权保留，尚未读取的来源不计为零。' }) }
  }
  return { items, issues }
})
