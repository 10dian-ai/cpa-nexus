import { createError } from 'h3'
import { requireModule } from '../modules'
import { getDb } from '../db'
import { createDevin2ApiClient, getDevin2ApiRuntimeConfig } from './client'
import { listDevin2ApiModels } from './catalog'
import {
  createDevin2ApiAccount, deleteDevin2ApiAccount, getDevin2ApiAccount,
  listDevin2ApiAccounts, patchDevin2ApiAccount,
  type Devin2ApiAccount, type Devin2ApiAccountInput,
} from './accounts'

export type DevinAccountView = Devin2ApiAccount & { snapshot: unknown; lastUsedAt: string | null }
function view(account: Devin2ApiAccount): DevinAccountView {
  return { ...account, snapshot: account.snapshot, lastUsedAt: account.lastUsedAt }
}
export async function listDevinAccounts() { await requireModule('devin2api'); return (await listDevin2ApiAccounts()).map(view) }
export async function getDevinAccount(id: string) { await requireModule('devin2api'); const account = await getDevin2ApiAccount(id); return account ? view(account) : null }
export async function createDevinAccount(input: Devin2ApiAccountInput) { await requireModule('devin2api'); return view(await createDevin2ApiAccount(input)) }
export async function patchDevinAccount(id: string, input: Partial<Devin2ApiAccountInput>) { await requireModule('devin2api'); const account = await patchDevin2ApiAccount(id, input); return account ? view(account) : null }
export async function deleteDevinAccount(id: string) { await requireModule('devin2api'); return deleteDevin2ApiAccount(id) }

interface SidecarResult { ok: boolean; status: number; response?: Response; error?: string }
async function check(path: '/healthz', timeoutMs = 8000): Promise<SidecarResult> {
  try {
    const response = await createDevin2ApiClient({ timeoutMs }).request({ path, timeoutMs })
    return { ok: response.ok, status: response.status, response, error: response.ok ? undefined : `上游返回 HTTP ${response.status}` }
  } catch (error) { return { ok:false, status:502, error: error instanceof Error ? error.message : '无法连接 Devin 服务' } }
}
export async function getDevinStatus() {
  await requireModule('devin2api')
  const configured = Boolean(process.env.DEVIN2API_URL?.trim() || process.env.DEVIN_2API_URL?.trim())
  if (!configured) return { configured: false, url: null, reachable: false, status: 'unconfigured', message: '未配置 DEVIN2API_URL；请连接 devin-2api 适配服务', modelCount: 0, checkedAt: new Date().toISOString() }
  let runtime: ReturnType<typeof getDevin2ApiRuntimeConfig>
  try { runtime = getDevin2ApiRuntimeConfig() } catch (error) {
    return { configured: false, url: null, reachable: false, status: 'unavailable', message: error instanceof Error ? error.message : 'Devin 地址配置无效', modelCount: 0, checkedAt: new Date().toISOString() }
  }
  const health = await check('/healthz')
  let modelCount = 0
  if (health.ok) { try { modelCount = (await listDevin2ApiModels()).length } catch { /* health is still useful if catalog is unavailable */ } }
  return { configured, url: runtime.baseUrl, reachable: health.ok, status: health.ok ? 'ready' : 'unavailable', message: health.error || 'Devin 适配服务已连接', modelCount, checkedAt: new Date().toISOString() }
}
export async function listDevinModels() {
  await requireModule('devin2api')
  try { const items = await listDevin2ApiModels(); return { items: items.map(item => ({ id:item.id, name:item.display_name || item.id, ownedBy:item.owned_by || 'devin2api' })), updatedAt:new Date().toISOString() } }
  catch (error) { throw createError({ statusCode:502, message:error instanceof Error ? error.message : '读取 Devin 模型目录失败' }) }
}

export async function listDevinLogs(query: { page:number; pageSize:number; model?:string; status?:string }) {
  await requireModule('devin2api')
  const db = getDb(); const offset = (query.page - 1) * query.pageSize
  const model = (query.model || '').slice(0,200); const status = query.status || ''
  const pattern = `%${model.replace(/[\\%_]/g, '\\$&')}%`
  const condition = db`WHERE l.module_id='devin2api' AND (${model}='' OR l.model ILIKE ${pattern}) AND (${status}='' OR l.status=${status})`
  const [rows, count] = await Promise.all([
    db`SELECT l.id,l.account_id,l.source_id,a.label AS account_label,k.name AS key_name,l.model,l.protocol,l.status,l.http_status,l.duration_ms,l.streaming,l.usage,l.error_message,l.response_truncated,l.created_at FROM request_logs l LEFT JOIN devin2api_accounts a ON a.id::text=l.source_id LEFT JOIN gateway_keys k ON k.id=l.key_id ${condition} ORDER BY l.created_at DESC,l.id DESC LIMIT ${query.pageSize} OFFSET ${offset}`,
    db`SELECT count(*)::int AS total FROM request_logs l ${condition}`,
  ])
  return { items: rows.map((r: any) => ({ id:r.id, accountId:r.account_id || r.source_id || null, accountLabel:r.account_label, keyName:r.key_name, model:r.model, protocol:r.protocol, status:r.status, httpStatus:r.http_status, durationMs:r.duration_ms, streaming:r.streaming, usage:r.usage, errorMessage:r.error_message, responseTruncated:r.response_truncated, createdAt:new Date(r.created_at).toISOString() })), total:Number(count[0]?.total || 0), page:query.page, pageSize:query.pageSize }
}
