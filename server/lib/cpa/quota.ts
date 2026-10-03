import type { CpaNativeQuota, CpaQuotaWindow } from '../../../shared/cpa'
import { CpaClientError, createCpaClient, type CpaRequest, type CpaResponse } from './client'
import { NATIVE_QUOTA_PROVIDERS } from './capabilities'

export interface CpaNativeQuotaClient { request(input: CpaRequest): Promise<CpaResponse> }
type Json = Record<string, unknown>
const record = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)
const object = (value: unknown): Json => record(value) ? value : {}
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const number = (value: unknown): number | undefined => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim() || !/^-?\d+(?:\.\d+)?$/.test(value.trim()))) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
const percent = (value: unknown) => { const parsed = number(value); return parsed !== undefined && parsed >= 0 && parsed <= 100 ? parsed : undefined }
function instant(value: unknown): string | undefined {
  const numeric = number(value)
  const ms = numeric !== undefined && numeric > 0 ? (numeric < 100_000_000_000 ? numeric * 1000 : numeric) : typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN
  return Number.isFinite(ms) && ms > 0 && ms <= 8_640_000_000_000_000 ? new Date(ms).toISOString() : undefined
}
function fail(code: string, message: string, status = 502): never { throw new CpaClientError(code, message, status) }
const fixedHeaders = { Authorization: 'Bearer $TOKEN$', 'Content-Type': 'application/json' }
const CODEX_HEADERS = { ...fixedHeaders, 'User-Agent': 'codex-tui/0.149.1 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.149.1)' }
const CLAUDE_HEADERS = { ...fixedHeaders, 'User-Agent': 'claude-cli/2.1.280 (external, cli)', 'anthropic-beta': 'oauth-2025-04-20' }
const ANTIGRAVITY_HEADERS = { ...fixedHeaders, 'User-Agent': 'antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)' }
const XAI_HEADERS = { Authorization: 'Bearer $TOKEN$', 'x-xai-token-auth': 'xai-grok-cli', 'x-grok-client-version': '0.2.91', accept: '*/*', 'user-agent': 'grok-pager/0.2.91 grok-shell/0.2.91 (macos; aarch64)' }

const numericKeys = new Set(('utilization percent used_percent usedPercent remainingFraction remaining_fraction remainingPercent dailyQuotaRemainingPercent weeklyQuotaRemainingPercent used limit remaining used_ratio monthly_limit monthlyLimit used_credits creditUsagePercent credit_usage_percent onDemandCap on_demand_cap onDemandUsed on_demand_used prepaidBalance prepaid_balance val balance available_count availableCount applicable_available_count applicableAvailableCount duration limit_window_seconds limitWindowSeconds reset_after_seconds resetAfterSeconds window_duration_mins dailyQuotaResetAtUnix weeklyQuotaResetAtUnix resets_at reset_at resetAt expires_at granted_at usagePercent usage_percent').split(' '))
const textKeys = new Set(('id name title display_name displayName window description plan_type planType plan tier tierName tierId subs_tier_name billing_type organization_type rate_limit_tier reset_time resetTime resets_at reset_at resetAt start end billingPeriodStart billingPeriodEnd billing_period_start billing_period_end type product key label unit format currency granted_at grantedAt expiresAt status scope group kind').split(' '))
const containerKeys = new Set(('usage usages limits detail window five_hour seven_day seven_day_oauth_apps seven_day_opus seven_day_sonnet seven_day_cowork iguana_necktie extra_usage rate_limit rateLimit primary_window primaryWindow secondary_window secondaryWindow code_review_rate_limit codeReviewRateLimit additional_rate_limits additionalRateLimits rate_limit_reset_credits rateLimitResetCredits credits groups buckets config currentPeriod current_period productUsage product_usage subs_usage weekly userStatus planStatus planInfo summary limit_month_total scope model').split(' '))
const booleanKeys = new Set(['allowed', 'limit_reached', 'limitReached', 'has_credits', 'unlimited', 'is_enabled', 'is_active', 'is_subs_active'])
/** Only known quota fields survive. Credentials, fresh Meta API keys, account profile PII and errors never do. */
export function sanitizeQuotaPayload(value: unknown, depth = 0): unknown {
  if (depth > 8) return undefined
  if (Array.isArray(value)) return value.slice(0, 128).map(item => sanitizeQuotaPayload(item, depth + 1)).filter(item => item !== undefined)
  if (!record(value)) return undefined
  const out: Json = {}
  for (const [key, child] of Object.entries(value)) {
    if (containerKeys.has(key) && (record(child) || Array.isArray(child))) {
      const safe = sanitizeQuotaPayload(child, depth + 1)
      if (safe !== undefined) out[key] = safe
    } else if (numericKeys.has(key) && number(child) !== undefined) out[key] = child
    else if (textKeys.has(key) && typeof child === 'string' && child.length <= 512 && !/[\r\n]/.test(child)
      && !/(?:Bearer\s|dca:|sk-[a-zA-Z0-9]|eyJ[a-zA-Z0-9_-]{20})/.test(child)) out[key] = child
    else if (booleanKeys.has(key) && typeof child === 'boolean') out[key] = child
  }
  return out
}
function window(id: string, name: string, fields: Partial<CpaQuotaWindow>): CpaQuotaWindow {
  const safeName = /(?:Bearer\s|dca:|sk-[a-zA-Z0-9]|eyJ[a-zA-Z0-9_-]{20})/.test(name) ? '额度窗口' : name.slice(0, 160)
  return Object.fromEntries(Object.entries({ id, name: safeName, ...fields }).filter(([, value]) => value !== undefined)) as unknown as CpaQuotaWindow
}
export function parseNativeQuotaWindows(provider: string, payload: unknown): CpaQuotaWindow[] {
  const root = object(payload), result: CpaQuotaWindow[] = []
  if (provider === 'claude') {
    for (const key of ['five_hour', 'seven_day', 'seven_day_oauth_apps', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_cowork', 'iguana_necktie']) {
      const row = object(root[key])
      if (Object.keys(row).length) result.push(window(key, key, { usedPercent: percent(row.utilization), resetsAt: instant(row.resets_at) }))
    }
    if (Array.isArray(root.limits)) root.limits.filter(record).forEach((row, index) => result.push(window('limit-' + index,
      text(object(object(row.scope).model).display_name) || text(row.kind) || '模型限额', { usedPercent: percent(row.percent), resetsAt: instant(row.resets_at) })))
    const extra = object(root.extra_usage)
    if (Object.keys(extra).length) result.push(window('extra_usage', '额外用量', { used: number(extra.used_credits), limit: number(extra.monthly_limit), usedPercent: percent(extra.utilization) }))
  } else if (provider === 'codex') {
    const append = (id: string, name: string, value: unknown) => {
      const rate = object(value)
      for (const kind of ['primary', 'secondary']) {
        const row = object(rate[kind + '_window'] ?? rate[kind + 'Window'])
        if (Object.keys(row).length) result.push(window(id + '-' + kind, name + ' · ' + kind, { usedPercent: percent(row.used_percent ?? row.usedPercent), resetsAt: instant(row.reset_at ?? row.resetAt) }))
      }
    }
    append('rate', '模型请求', root.rate_limit ?? root.rateLimit)
    append('review', '代码审查', root.code_review_rate_limit ?? root.codeReviewRateLimit)
    const additional = root.additional_rate_limits ?? root.additionalRateLimits
    if (Array.isArray(additional)) additional.filter(record).forEach((row, index) => append('additional-' + index,
      text(row.limit_name ?? row.limitName ?? row.metered_feature ?? row.meteredFeature) || '额外限额', row.rate_limit ?? row.rateLimit))
  } else if (provider === 'antigravity') {
    if (Array.isArray(root.groups)) root.groups.filter(record).forEach((group, groupIndex) => {
      if (Array.isArray(group.buckets)) group.buckets.filter(record).forEach((row, index) => {
        const fraction = number(row.remainingFraction ?? row.remaining_fraction)
        result.push(window('group-' + groupIndex + '-bucket-' + index,
          text(row.displayName ?? row.display_name ?? row.window) || text(group.displayName ?? group.display_name) || '额度窗口', {
            remainingPercent: fraction !== undefined && fraction >= 0 && fraction <= 1 ? fraction * 100 : undefined,
            resetsAt: instant(row.resetTime ?? row.reset_time),
          }))
      })
    })
  } else if (provider === 'kimi') {
    const append = (id: string, name: string, value: unknown) => {
      const row = object(value)
      if (Object.keys(row).length) result.push(window(id, text(row.name ?? row.title) || name, {
        used: number(row.used), limit: number(row.limit), remaining: number(row.remaining),
        resetsAt: instant(row.reset_time ?? row.resetTime ?? row.reset_at ?? row.resetAt),
      }))
    }
    append('usage', '订阅用量', root.usage)
    if (Array.isArray(root.limits)) root.limits.filter(record).forEach((row, index) => append('limit-' + index, text(row.name ?? row.title) || '额度窗口', row.detail ?? row))
    const monthly = object(object(root.usages).limit_month_total), ratio = number(monthly.used_ratio)
    if (Object.keys(monthly).length) result.push(window('monthly', '月额度', { usedPercent: ratio !== undefined && ratio >= 0 && ratio <= 1 ? ratio * 100 : undefined, resetsAt: instant(monthly.reset_time) }))
  } else if (provider === 'devin') {
    const plan = object(object(root.userStatus).planStatus)
    for (const kind of ['daily', 'weekly']) if (plan[kind + 'QuotaRemainingPercent'] !== undefined || plan[kind + 'QuotaResetAtUnix'] !== undefined)
      result.push(window(kind, kind === 'daily' ? '日额度' : '周额度', { remainingPercent: percent(plan[kind + 'QuotaRemainingPercent']), resetsAt: instant(plan[kind + 'QuotaResetAtUnix']) }))
  } else if (provider === 'meta') {
    const usage = object(root.subs_usage)
    for (const kind of ['window', 'weekly']) {
      const row = object(usage[kind])
      if (Object.keys(row).length) result.push(window(kind, kind === 'weekly' ? '周额度' : '当前窗口', { usedPercent: percent(row.used_percent), resetsAt: instant(row.resets_at) }))
    }
  } else if (provider === 'xai') {
    const config = object(root.config), current = object(config.currentPeriod ?? config.current_period)
    if (Object.keys(config).length) result.push(window('billing', text(current.type) || '账单额度', {
      usedPercent: percent(config.creditUsagePercent ?? config.credit_usage_percent),
      used: number(object(config.used).val ?? config.used), limit: number(object(config.monthlyLimit ?? config.monthly_limit).val ?? config.monthlyLimit ?? config.monthly_limit),
      resetsAt: instant(current.end ?? config.billingPeriodEnd ?? config.billing_period_end),
    }))
    const products = config.productUsage ?? config.product_usage
    if (Array.isArray(products)) products.filter(record).forEach((row, index) => result.push(window('product-' + index, text(row.product) || '产品额度', { usedPercent: percent(row.usagePercent ?? row.usage_percent) })))
  }
  return result.slice(0, 128)
}

function parseResponse(response: CpaResponse): unknown {
  if (response.status < 200 || response.status >= 300) fail('quota_core_error', 'CPA 未完成配额查询，请检查凭据和内核连接')
  try { return JSON.parse(new TextDecoder().decode(response.body)) } catch { fail('quota_invalid_response', 'CPA 返回了无效的配额响应') }
}
async function apiCall(client: CpaNativeQuotaClient, authIndex: string, method: 'GET' | 'POST', url: string, header: Record<string, string>, data?: string): Promise<Json> {
  let response: CpaResponse
  try { response = await client.request({ path: 'requests/api-call', method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ auth_index: authIndex, method, url, header, ...(data !== undefined ? { data } : {}) }), signal: AbortSignal.timeout(20_000) }) }
  catch { fail('quota_unreachable', '配额查询暂时无法完成，请稍后重试') }
  const envelope = object(parseResponse(response))
  const status = number(envelope.status_code ?? envelope.statusCode)
  if (status === undefined || status < 200 || status >= 300) fail('quota_upstream_error', status ? '供应商拒绝配额查询（HTTP ' + status + '）' : '供应商配额响应缺少状态码')
  let payload: unknown = envelope.body
  if (typeof payload === 'string') { try { payload = JSON.parse(payload) } catch { fail('quota_invalid_response', '供应商配额响应格式无效') } }
  if (!record(payload)) fail('quota_invalid_response', '供应商配额响应格式无效')
  if (payload.error !== undefined && payload.error !== null && payload.error !== false) fail('quota_upstream_error', '供应商返回了配额查询错误')
  return payload
}
async function authDocument(client: CpaNativeQuotaClient, credential: Json): Promise<Json> {
  const name = text(credential.name || credential.id)
  if (!name || credential.runtime_only === true) fail('quota_credential_unavailable', '此凭据不能读取所需的原生账号信息', 409)
  const payload = parseResponse(await client.request({ path: 'credentials/download', query: { name } }))
  if (!record(payload)) fail('quota_credential_unavailable', '凭据账号信息格式无效', 502)
  return payload
}
const goodHeaderValue = (value: unknown) => typeof value === 'string' && value.trim().length <= 1024 && !/[\r\n]/.test(value) ? value.trim() : ''
function codexAccountId(credential: Json): string {
  const claims = object(credential.id_token), auth = object(claims['https://api.openai.com/auth'])
  return goodHeaderValue(credential.account_id ?? credential.chatgpt_account_id ?? auth.chatgpt_account_id)
}

/** Native quota definitions follow official Management Center v1.25.2 (752e0ee).
 * https://github.com/router-for-me/Cli-Proxy-API-Management-Center/tree/v1.25.2/src/features/quota/providers
 * Each returned field is an actual supplier observation. Missing fields remain absent.
 */
async function queryProvider(client: CpaNativeQuotaClient, authIndex: string, provider: string, credential: Json): Promise<CpaNativeQuota> {
  const raw: Json = {}, windows: CpaQuotaWindow[] = [], errors: string[] = []
  const append = (name: string, value: Json) => {
    raw[name] = sanitizeQuotaPayload(value)
    windows.push(...parseNativeQuotaWindows(provider, value).map(row => ({ ...row, id: name + ':' + row.id })))
  }
  if (provider === 'codex') {
    const headers: Record<string, string> = { ...CODEX_HEADERS }, accountId = codexAccountId(credential)
    if (accountId) headers['Chatgpt-Account-Id'] = accountId
    append('usage', await apiCall(client, authIndex, 'GET', 'https://chatgpt.com/backend-api/wham/usage', headers))
    try { raw.resetCredits = sanitizeQuotaPayload(await apiCall(client, authIndex, 'GET', 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits', { ...headers, Accept: 'application/json', 'OpenAI-Beta': 'codex-1', Originator: 'Codex Desktop' })) }
    catch { errors.push('恢复额度凭证信息暂时无法读取；没有消耗任何恢复额度。') }
  } else if (provider === 'claude') {
    append('usage', await apiCall(client, authIndex, 'GET', 'https://api.anthropic.com/api/oauth/usage', CLAUDE_HEADERS))
    try {
      const profile = await apiCall(client, authIndex, 'GET', 'https://api.anthropic.com/api/oauth/profile', CLAUDE_HEADERS)
      raw.subscription = sanitizeQuotaPayload(object(profile.organization))
    } catch { errors.push('套餐信息暂时无法读取，已保留实际额度查询结果。') }
  } else if (provider === 'antigravity') {
    let project = goodHeaderValue(credential.project_id)
    if (!project) { const document = await authDocument(client, credential); project = goodHeaderValue(document.project_id ?? object(document.installed).project_id ?? object(document.web).project_id) }
    if (!project) fail('quota_project_missing', 'Google Antigravity 凭据缺少项目 ID', 409)
    const hosts = ['daily-cloudcode-pa.googleapis.com', 'daily-cloudcode-pa.sandbox.googleapis.com', 'cloudcode-pa.googleapis.com']
    let result: Json | undefined
    for (const host of hosts) {
      try { result = await apiCall(client, authIndex, 'POST', 'https://' + host + '/v1internal:retrieveUserQuotaSummary', ANTIGRAVITY_HEADERS, JSON.stringify({ project })); break } catch { /* Try only the fixed official quota endpoints. */ }
    }
    if (!result) fail('quota_upstream_error', 'Google Antigravity 配额查询暂时不可用')
    append('usage', result)
  } else if (provider === 'kimi') {
    const document = await authDocument(client, credential)
    const explicitDomain = text(document.domain).toLowerCase()
    let domain = explicitDomain ? (explicitDomain === 'ai' || explicitDomain === 'kimi-ai' || explicitDomain === 'kimi.ai' || explicitDomain.endsWith('.kimi.ai') ? 'ai' : 'com') : ''
    if (!domain) {
      const base = Object.prototype.hasOwnProperty.call(document, 'base_url') ? document.base_url : document['base-url']
      try { const host = new URL(text(base)).hostname.toLowerCase(); if (host === 'kimi.ai' || host.endsWith('.kimi.ai')) domain = 'ai'; else if (host === 'kimi.com' || host.endsWith('.kimi.com')) domain = 'com' } catch { /* No client URL is used as an upstream target. */ }
    }
    if (!domain) domain = /kimi-ai|kimi\.ai/i.test(text(document.type) + ' ' + text(credential.provider ?? credential.type)) ? 'ai' : 'com'
    append('usage', await apiCall(client, authIndex, 'GET', domain === 'ai' ? 'https://api.kimi.ai/coding/v1/usages' : 'https://api.kimi.com/coding/v1/usages', { Authorization: 'Bearer $TOKEN$' }))
  } else if (provider === 'devin') {
    append('usage', await apiCall(client, authIndex, 'POST', 'https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus', {
      'Content-Type': 'application/json', 'Connect-Protocol-Version': '1',
    }, JSON.stringify({ metadata: { ideName: 'chisel', ideVersion: '3000.10.21', apiKey: '$TOKEN$', locale: 'en', os: 'darwin', extensionVersion: '3000.10.21', clientName: 'chisel' } })))
  } else if (provider === 'meta') {
    // CPA's $TOKEN$ selects a minted inference key. The official quota operation requires DCA.
    // This credential exists only in this server request and is delegated to one fixed official endpoint.
    const document = await authDocument(client, credential), token = document.dca_token
    if (text(document.type).toLowerCase() !== 'meta' || typeof token !== 'string' || !token.trim() || token.length > 8192 || /[\r\n]/.test(token)) fail('quota_meta_dca_missing', 'Meta 凭据缺少有效的 DCA 授权信息，请重新授权', 409)
    append('usage', await apiCall(client, authIndex, 'POST', 'https://api.meta.ai/muse-code/key', { Authorization: 'Bearer ' + token.trim(), Accept: 'application/json', 'Content-Type': 'application/json', 'x-api-version': '1.0.0' }, '{}'))
  } else if (provider === 'xai') {
    const headers: Record<string, string> = { ...XAI_HEADERS }, userId = goodHeaderValue(credential.user_id ?? credential.sub)
    if (userId) headers['x-userid'] = userId
    for (const [name, url] of [['weekly', 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'], ['monthly', 'https://cli-chat-proxy.grok.com/v1/billing']] as const) {
      try { append(name, await apiCall(client, authIndex, 'GET', url, headers)) } catch { errors.push(name === 'weekly' ? '周账单额度暂时无法读取。' : '月账单额度暂时无法读取。') }
    }
    if (!Object.keys(raw).length) {
      // Original paid health fallback also sends chat ping. Reading quota must never trigger inference.
      const profile = await apiCall(client, authIndex, 'GET', 'https://api.x.ai/v1/me', { Authorization: 'Bearer $TOKEN$', Accept: 'application/json' })
      raw.account = sanitizeQuotaPayload(profile)
      errors.push('该账户未返回账单额度；付费模型健康测试可在原版控制台显式执行。')
    }
  }
  if (!windows.some(row => row.used !== undefined || row.limit !== undefined || row.remaining !== undefined || row.usedPercent !== undefined || row.remainingPercent !== undefined)) errors.push('供应商未返回可识别的额度数值，未知值未转换为零。')
  return { provider, authIndex, checkedAt: new Date().toISOString(), source: 'core-api-call', raw, windows: windows.slice(0, 128), ...(errors.length ? { errors } : {}) }
}

const cache = new Map<string, { until: number; value?: CpaNativeQuota; error?: CpaClientError }>()
const inFlight = new Map<string, Promise<CpaNativeQuota>>()
let active = 0
const waiting: (() => void)[] = []
const MAX_CACHE = 128
export function resetNativeQuotaCache() { cache.clear() }
async function runLimited<T>(callback: () => Promise<T>): Promise<T> {
  if (active >= 4) {
    if (waiting.length >= 64) fail('quota_busy', '配额查询队列繁忙，请稍后重试', 429)
    await new Promise<void>(resolve => waiting.push(resolve))
  } else active++
  try { return await callback() } finally { const next = waiting.shift(); if (next) next(); else active-- }
}
export async function queryNativeQuota(input: { auth_index: string; provider: string }, client: CpaNativeQuotaClient = createCpaClient()): Promise<CpaNativeQuota> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.auth_index)) fail('quota_invalid_input', '请选择有效的凭据 auth_index', 400)
  const requested = input.provider.trim().toLowerCase(), canonical = requested === 'anthropic' ? 'claude' : requested === 'kimi-ai' ? 'kimi' : requested
  const capability = NATIVE_QUOTA_PROVIDERS.find(provider => provider.id === canonical)
  if (!capability) fail('quota_provider_unsupported', '此原生配额提供方不受支持', 400)
  const credentials = object(parseResponse(await client.request({ path: 'credentials', query: { auth_index: input.auth_index } }))).files
  if (!Array.isArray(credentials)) fail('quota_credentials_invalid', 'CPA 凭据列表格式无效')
  const matches = credentials.filter(record).filter(row => row.auth_index === input.auth_index)
  if (matches.length !== 1) fail('quota_credential_missing', matches.length ? '凭据索引不唯一，请检查重复配置' : 'CPA 凭据不存在', matches.length ? 409 : 404)
  const credential = matches[0]!, actual = text(credential.provider ?? credential.type).toLowerCase()
  if (!(capability.credentialProviders as readonly string[]).includes(actual)) fail('quota_provider_mismatch', '配额提供方与所选凭据不匹配', 400)
  const key = (process.env.CPA_URL || '') + '\0' + canonical + '\0' + input.auth_index
  const previous = cache.get(key)
  if (previous && previous.until > Date.now()) {
    if (previous.error) throw previous.error
    return structuredClone(previous.value!)
  }
  if (inFlight.has(key)) return structuredClone(await inFlight.get(key)!)
  const pending = runLimited(() => queryProvider(client, input.auth_index, canonical, credential)).then(value => {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!)
    cache.set(key, { value, until: Date.now() + 5000 }); return value
  }).catch(error => {
    const safe = error instanceof CpaClientError ? error : new CpaClientError('quota_failed', '配额查询暂时无法完成，请稍后重试', 502)
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!)
    cache.set(key, { error: safe, until: Date.now() + 5000 }); throw safe
  }).finally(() => { inFlight.delete(key) })
  inFlight.set(key, pending)
  return structuredClone(await pending)
}
