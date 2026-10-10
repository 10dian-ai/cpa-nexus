import { createError } from 'h3'
import { isModuleEnabled, requireModule } from '../modules'
import { getDb } from '../db'
import { getDevin2ApiRuntimeCount, isDevin2ApiBinaryAvailable } from './runtime'
import { listDevin2ApiModels } from './catalog'
import { redactLogFields } from '../logs'
import { redactSensitiveText } from '../../../shared/log-privacy'
import {
  createDevin2ApiAccount, deleteDevin2ApiAccount, getDevin2ApiAccount,
  listDevin2ApiAccounts, patchDevin2ApiAccount,
  type Devin2ApiAccount, type Devin2ApiAccountInput,
} from './accounts'

export type DevinAccountView = Devin2ApiAccount & { snapshot: unknown; lastUsedAt: string | null }
const view = (account: Devin2ApiAccount): DevinAccountView => ({ ...account, snapshot: account.snapshot, lastUsedAt: account.lastUsedAt })
// Reads remain available while the extension is disabled so the admin UI can
// show the saved configuration and explain why calls are paused. Mutations
// still require the module to be enabled.
export async function listDevinAccounts() { return (await listDevin2ApiAccounts()).map(view) }
export async function getDevinAccount(id: string) { const account = await getDevin2ApiAccount(id); return account ? view(account) : null }
export async function createDevinAccount(input: Devin2ApiAccountInput) { await requireModule('devin2api'); return view(await createDevin2ApiAccount(input)) }
export async function patchDevinAccount(id: string, input: Partial<Devin2ApiAccountInput>) { await requireModule('devin2api'); const account = await patchDevin2ApiAccount(id, input); return account ? view(account) : null }
export async function deleteDevinAccount(id: string) { await requireModule('devin2api'); return deleteDevin2ApiAccount(id) }

export async function getDevinStatus() {
  if (!await isModuleEnabled('devin2api')) return {
    mode: 'embedded' as const, configured: false, binaryAvailable: await isDevin2ApiBinaryAvailable(), reachable: false,
    status: 'disabled' as const, message: 'Devin 模块已停用；账号配置已保留', modelCount: 0,
    runtimeCount: getDevin2ApiRuntimeCount(), checkedAt: new Date().toISOString(), url: null,
  }
  const configured = (await listDevin2ApiAccounts()).some(account => account.enabled && account.hasToken)
  const binaryAvailable = await isDevin2ApiBinaryAvailable()
  const ready = configured && binaryAvailable
  return {
    mode: 'embedded' as const, configured, binaryAvailable, reachable: ready,
    status: ready ? 'ready' : binaryAvailable ? (configured ? 'unavailable' : 'unconfigured') : 'unavailable',
    message: !binaryAvailable ? 'Devin 内置运行时未安装，请重新构建 CPAN 镜像' : !configured ? '请添加至少一个 Devin 账号凭证' : 'Devin 内置运行时按账号池按需启动',
    modelCount: ready ? await listDevin2ApiModels().then(items => items.length).catch(() => 0) : 0,
    runtimeCount: getDevin2ApiRuntimeCount(), checkedAt: new Date().toISOString(), url: null,
  }
}
export async function listDevinModels() {
  try { const items = await listDevin2ApiModels(); return { items: items.map(item => ({ id: item.id, name: item.display_name || item.id, ownedBy: item.owned_by || 'devin2api' })), updatedAt: new Date().toISOString() } }
  catch (error) { throw createError({ statusCode: 502, message: error instanceof Error ? error.message : '读取 Devin 模型目录失败' }) }
}
export async function listDevinLogs(query: { page: number; pageSize: number; model?: string; status?: string }) {
  const db = getDb(); const offset = (query.page - 1) * query.pageSize
  const model = (query.model || '').slice(0, 200); const status = query.status || ''; const pattern = `%${model.replace(/[\\%_]/g, '\\$&')}%`
  const safePattern = `%${redactSensitiveText(model).replace(/[\\%_]/g, '\\$&')}%`
  const condition = db`WHERE l.module_id='devin2api' AND (${model}='' OR l.model ILIKE ${pattern} OR l.model ILIKE ${safePattern}) AND (${status}='' OR l.status=${status})`
  const [rows, count] = await Promise.all([
    db`SELECT l.id,l.account_id,l.source_id,a.label AS account_label,k.name AS key_name,l.model,l.protocol,l.status,l.http_status,l.duration_ms,l.streaming,l.usage,l.error_message,l.response_truncated,l.created_at FROM request_logs l LEFT JOIN devin2api_accounts a ON a.id::text=l.source_id LEFT JOIN gateway_keys k ON k.id=l.key_id ${condition} ORDER BY l.created_at DESC,l.id DESC LIMIT ${query.pageSize} OFFSET ${offset}`,
    db`SELECT count(*)::int AS total FROM request_logs l ${condition}`,
  ])
  return { items: rows.map((r: any) => redactLogFields({ id: r.id, accountId: r.account_id || r.source_id || null, accountLabel: r.account_label, keyName: r.key_name, model: r.model, protocol: r.protocol, status: r.status, httpStatus: r.http_status, durationMs: r.duration_ms, streaming: r.streaming, usage: r.usage, errorMessage: r.error_message, responseTruncated: r.response_truncated, createdAt: new Date(r.created_at).toISOString() })), total: Number(count[0]?.total || 0), page: query.page, pageSize: query.pageSize }
}
