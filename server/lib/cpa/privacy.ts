import { applyCpaPrivacyPolicy } from '../../../scripts/cpa-privacy-policy.mjs'
import { createCpaClient } from './client'
import { getDb } from '../db'
import { platformError } from '../platform-error'

export { CPA_PRIVACY_USER_AGENT } from '../../../scripts/cpa-privacy-policy.mjs'
export async function ensureNativeCpaPrivacy(options: { fileNames?: string[]; locked?: boolean } = {}) {
  const apply = () => applyCpaPrivacyPolicy(createCpaClient(), { fileNames: options.fileNames })
  try {
    if (options.locked) return await apply()
    return await getDb().begin(async sql => {
      await sql`SELECT pg_advisory_xact_lock(71645203)`
      return apply()
    })
  } catch {
    throw platformError({ statusCode: 503, message: 'CPA 上游请求头隐私设置未完成，请检查核心连接后重试' })
  }
}
