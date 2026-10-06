import { defineEventHandler, getQuery } from 'h3'
import { z } from 'zod'
import { validate } from '../../lib/account-validation'
import { getDb } from '../../lib/db'
import { accountGroupBindings } from '../../lib/groups'
import { listCpaGroupSources } from '../../lib/cpa/group-routing'
import type { GroupAccountView } from '../../../shared/groups'
export default defineEventHandler(async event => {
  const { moduleId } = validate(z.object({ moduleId: z.enum(['commandcode','cpa','devin2api']).optional() }), getQuery(event))
  const items: GroupAccountView[] = []
  const issues: { moduleId: 'cpa' | 'commandcode' | 'devin2api'; message: string }[] = []
  if (!moduleId || moduleId === 'commandcode') {
    try {
      const rows = await getDb()`SELECT id,label,email,upstream_user_id,enabled FROM managed_accounts ORDER BY created_at DESC,id`
      const bindings = await accountGroupBindings('commandcode', rows.map(row => row.id))
      items.push(...rows.map(row => ({ id: row.id, sourceId: row.id, moduleId: 'commandcode' as const, sourceType: 'commandcode',
        name: row.label || row.email || row.upstream_user_id || row.id, provider: 'CommandCode', enabled: row.enabled,
        ...(bindings.get(row.id) ?? { groupIds: [], groupNames: [] }), routingSupported: true })))
    } catch { issues.push({ moduleId: 'commandcode', message: 'CommandCode 来源暂时读取失败，请重试；尚未读取的账号不计为零，也不会更改其分组。' }) }
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
  if (!moduleId || moduleId === 'devin2api') {
    try {
      const rows = await getDb()`SELECT id,label,base_url,model,enabled,status,sync_error FROM devin2api_accounts ORDER BY created_at DESC,id`
      const bindings = await accountGroupBindings('devin2api', rows.map(row => row.id))
      items.push(...rows.map(row => ({ id: row.id, sourceId: row.id, moduleId: 'devin2api' as const, sourceType: 'devin2api',
        name: row.label || row.model || row.id, provider: 'Devin 2API', enabled: row.enabled === true && row.status !== 'disabled',
        ...(bindings.get(row.id) ?? { groupIds: [], groupNames: [] }), routingSupported: true,
        ...(row.sync_error ? { message: row.sync_error } : {}),
      })))
    } catch { issues.push({ moduleId: 'devin2api', message: 'Devin 2API 来源暂时读取失败，请检查模块数据库迁移；原分组授权保留。' }) }
  }
  return { items, issues }
})
