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
/**
 * Only a short opaque reference crosses the request boundary; account lists stay server-side.
 * CPA keeps a registered policy until it expires (30 s) and accepts it on any
 * number of requests, so identical policies are reused while at least 10 s of
 * validity remain instead of registering one per request.
 */
const policyCache = new Map<string, { expiresAt: number; value: Promise<string> }>()
const REUSE_MARGIN_MS = 10_000
function policyCacheKey(input: CpaGroupPolicyInput) {
  return JSON.stringify([input.keyId, [...new Set(input.allowedAuthIDs)].sort(), [...new Set(input.allowedPluginIDs)].sort()])
}
export function resetCpaGroupPolicyCache() { policyCache.clear() }
/** Forget a cached policy CPA no longer knows (for example after a core restart). */
export function invalidateCpaGroupPolicy(input: CpaGroupPolicyInput) { policyCache.delete(policyCacheKey(input)) }
export async function registerCpaGroupPolicy(input: CpaGroupPolicyInput): Promise<string> {
  const key = policyCacheKey(input)
  const now = Date.now()
  const cached = policyCache.get(key)
  if (cached && cached.expiresAt - now > REUSE_MARGIN_MS) return cached.value
  const expiresAt = now + 30_000
  const value = createCpaGroupPolicy(input, expiresAt)
  policyCache.set(key, { expiresAt, value })
  if (policyCache.size > 5000) for (const [entry, item] of policyCache) if (item.expiresAt - now <= REUSE_MARGIN_MS) policyCache.delete(entry)
  value.catch(() => { if (policyCache.get(key)?.value === value) policyCache.delete(key) })
  return value
}
async function createCpaGroupPolicy(input: CpaGroupPolicyInput, expiresAt: number): Promise<string> {
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
