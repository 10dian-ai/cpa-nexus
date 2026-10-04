import { createHmac } from 'node:crypto'
import { getConfig } from '../config'
import { platformError } from '../platform-error'
import { createCpaClient } from './client'

export const CPA_GROUP_POLICY_HEADER = 'x-nexus-group-policy'
export interface CpaGroupPolicyInput { keyId: string; allowedAuthIDs: string[]; allowedPluginIDs: string[] }
export function signCpaGroupPolicy(id: string, expiresAt: number, secret: string): string {
  const value = id + '.' + expiresAt
  return value + '.' + createHmac('sha256', secret).update(value).digest('hex')
}
/** Only a short opaque reference crosses the request boundary; account lists stay server-side. */
export async function registerCpaGroupPolicy(input: CpaGroupPolicyInput): Promise<string> {
  const expiresAt = Date.now() + 30_000
  const response = await createCpaClient().request({ path: 'nexus/group-policies', method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, expiresAt }) })
  if (response.status === 404) throw platformError({ statusCode: 503, message: '当前 CPA 内核未启用插件分组适配，请更新内核后重试' })
  if (response.status !== 200 && response.status !== 201) throw platformError({ statusCode: 503, message: '账号分组策略注册失败，请检查内核配置' })
  let result: { id?: unknown; expiresAt?: unknown }
  try { result = JSON.parse(new TextDecoder().decode(response.body)) } catch { throw platformError({ statusCode: 502, message: '内核分组策略响应无效' }) }
  if (typeof result.id !== 'string' || !/^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(result.id) || !Number.isSafeInteger(result.expiresAt)
    || Number(result.expiresAt) <= Date.now() || Number(result.expiresAt) > expiresAt) throw platformError({ statusCode: 502, message: '内核分组策略响应无效' })
  return signCpaGroupPolicy(result.id, Number(result.expiresAt), process.env.NEXUS_GROUP_POLICY_KEY || getConfig().encryptionKey)
}
