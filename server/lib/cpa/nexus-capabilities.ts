import { createCpaClient } from './client'
import { platformError } from '../platform-error'
export interface NexusCpaPlugin {
  id: string; provider: string; executorModelScope: string; capabilities: Record<string, boolean>; modelClientIDs?: string[]
}
export interface NexusCpaRuntimeAccount {
  id: string; authIndex: string; fileName: string; provider: string; source: string; sourcePath: string; prefix?: string; disabled: boolean
}
export interface NexusCpaCapabilities {
  schemaVersion: 1; groupPolicy: { enabled: boolean; protocol: 'opaque-hmac-sha256-v1' }
  plugins: NexusCpaPlugin[]; runtimeAccounts: NexusCpaRuntimeAccount[]
}
let cached: { value: NexusCpaCapabilities | null; until: number } | undefined
export function resetNexusCpaCapabilities() { cached = undefined }
export async function getNexusCpaCapabilities(fresh = false): Promise<NexusCpaCapabilities | null> {
  if (!fresh && cached && cached.until > Date.now()) return cached.value
  const response = await createCpaClient().request({ path: 'nexus/capabilities' })
  if (response.status === 404) { cached = { value: null, until: Date.now() + 5000 }; return null }
  if (response.status !== 200) throw platformError({ statusCode: 502, message: 'CPA 内核能力状态无法读取，请检查核心连接' })
  let value: unknown
  try { value = JSON.parse(new TextDecoder().decode(response.body)) } catch { throw platformError({ statusCode: 502, message: 'CPA 内核能力格式无效' }) }
  const capabilities = value as NexusCpaCapabilities
  if (capabilities?.schemaVersion !== 1 || capabilities.groupPolicy?.protocol !== 'opaque-hmac-sha256-v1'
    || typeof capabilities.groupPolicy.enabled !== 'boolean' || !Array.isArray(capabilities.plugins) || !Array.isArray(capabilities.runtimeAccounts)) {
    throw platformError({ statusCode: 502, message: 'CPA 内核分组协议版本不匹配，请重新更新内核' })
  }
  cached = { value: capabilities, until: Date.now() + 5000 }
  return capabilities
}
