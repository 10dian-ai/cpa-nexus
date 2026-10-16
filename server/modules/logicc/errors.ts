import { redactSensitiveText } from '../../../shared/log-privacy'

/**
 * Why a Logicc call failed, which decides what happens to the account:
 * - `credential`: Clerk or Logicc rejected the session → cooldown; the account leaves the pool only after repeated rejections.
 * - `rate_limit`: the account is temporarily throttled → short cooldown, try another account.
 * - `model`: this account cannot use the requested model → try another account.
 * - `upstream` / `network`: transient Logicc or network failure → brief cooldown, try another account.
 * - `client`: the request itself is unusable on any account → return to the caller.
 * - `unsupported`: Logicc cannot serve this kind of request → let another source take it.
 * - `generation`: the model answered, but not in a usable form (e.g. a malformed tool call) → not the account's fault.
 *
 * `message` is for administrators (account status, request logs) and may be
 * Chinese and name Logicc. Callers of the model API only ever see
 * `publicMessage`: English, and never naming the upstream service.
 */
export type LogiccFailureKind = 'credential' | 'rate_limit' | 'model' | 'upstream' | 'network' | 'client' | 'unsupported' | 'generation'

const PUBLIC_BY_KIND: Record<LogiccFailureKind, string> = {
  credential: 'The service is temporarily unavailable, please retry later',
  rate_limit: 'Rate limit reached, please retry later',
  model: 'The requested model is temporarily unavailable, please retry later',
  upstream: 'The service is temporarily unavailable, please retry later',
  network: 'The upstream service did not respond in time, please retry later',
  client: 'Invalid request',
  unsupported: 'This kind of request is not supported for the requested model',
  generation: 'The model returned an unusable response, please retry',
}

export interface LogiccErrorOptions {
  /** English text for API callers; defaults to a generic message for the kind. */
  publicMessage?: string
  /** Seconds the account rests, instead of the kind's default. */
  cooldownSeconds?: number
  /** The failure cannot heal on its own (no cookie to renew with): the account leaves the pool at once. */
  definitive?: boolean
}

export class LogiccError extends Error {
  /** Set once the account-level consequence (strike, status) has been recorded. */
  handled = false
  constructor(public readonly kind: LogiccFailureKind, public readonly status: number, message: string, private readonly options: LogiccErrorOptions = {}) {
    super(redactLogiccText(message))
    this.name = 'LogiccError'
  }
  get publicMessage(): string { return this.options.publicMessage ?? PUBLIC_BY_KIND[this.kind] }
  get definitive(): boolean { return this.options.definitive === true }
  /** Another account may succeed where this one failed. */
  get accountSpecific() { return ['credential', 'rate_limit', 'model', 'upstream', 'network'].includes(this.kind) }
  /** Seconds the account rests before it is selected again. */
  get cooldownSeconds() {
    if (this.options.cooldownSeconds !== undefined) return this.options.cooldownSeconds
    return this.kind === 'rate_limit' ? 60 : this.kind === 'credential' ? 300 : this.kind === 'upstream' || this.kind === 'network' ? 15 : 0
  }
}

/** A request-validation failure: the English message is meant for the caller. */
export const invalidRequest = (message: string) => new LogiccError('client', 400, message, { publicMessage: message })
/** Logicc cannot serve this request; the router hands it to another source. */
export const unsupportedRequest = (message: string) => new LogiccError('unsupported', 422, message, { publicMessage: message })
/** The model produced output that cannot be returned (e.g. an invalid tool call). */
export const generationFailure = (message: string) => new LogiccError('generation', 502, message, { publicMessage: message })

/** Never let session JWTs, Clerk client cookies or session IDs reach logs and responses. */
export function redactLogiccText(value: unknown): string {
  return redactSensitiveText(String(value ?? ''))
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[凭据已隐藏]')
    .replace(/__client=[^;\s]+/gi, '__client=[凭据已隐藏]')
    .replace(/\bsess_[A-Za-z0-9]{6,}\b/g, 'sess_[已隐藏]')
    .slice(0, 500)
}

/**
 * Describe an error body for administrators: Clerk's own error code when it
 * sent one, or a hint that something in front of it (a firewall, Cloudflare)
 * answered instead. Only codes and short messages, never the raw body.
 */
export function describeErrorBody(body: string, contentType = ''): string {
  const text = body.trim()
  if (!text) return '响应为空'
  try {
    const value = JSON.parse(text) as { errors?: { code?: unknown; message?: unknown; long_message?: unknown }[]; error?: unknown; message?: unknown }
    const first = Array.isArray(value?.errors) ? value.errors[0] : undefined
    const code = typeof first?.code === 'string' ? first.code : typeof value?.error === 'string' ? value.error : ''
    const message = [first?.long_message, first?.message, value?.message].find(item => typeof item === 'string') as string | undefined
    return [code && `code=${code}`, message && message.slice(0, 160)].filter(Boolean).join('：') || 'JSON 响应没有错误码'
  } catch { /* Not JSON. */ }
  if (/<html|<!doctype/i.test(text) || /text\/html/i.test(contentType)) {
    const title = /<title>([^<]{0,80})/i.exec(text)?.[1]?.trim()
    return `返回了网页而不是接口数据${title ? `（${title}）` : ''}，可能被防火墙或 Cloudflare 拦截`
  }
  return text.slice(0, 120)
}

/** Whether an error response came from a firewall in front of the service rather than the service itself. */
export function looksBlocked(body: string, contentType = '', server = ''): boolean {
  return /<html|<!doctype/i.test(body.trim().slice(0, 200)) || /text\/html/i.test(contentType) || (/cloudflare/i.test(server) && !body.trim().startsWith('{'))
}

/** Map an HTTP failure from Logicc's API to a failure kind. */
export function classifyLogiccStatus(status: number, body: string, operation: string, headers?: { contentType?: string; server?: string }): LogiccError {
  const text = body.slice(0, 2000)
  const detail = describeErrorBody(text, headers?.contentType)
  if ((status === 401 || status === 403) && looksBlocked(text, headers?.contentType, headers?.server)) {
    // A firewall page, not a verdict on the session: rest the account without counting a strike.
    return new LogiccError('upstream', status, `Logicc ${operation} 被拦截（HTTP ${status}）：${detail}`, { cooldownSeconds: 120 })
  }
  if (status === 401 || status === 403) return new LogiccError('credential', status, `Logicc ${operation} 拒绝了账号凭据（HTTP ${status}）：${detail}`)
  if (status === 429) return new LogiccError('rate_limit', status, `Logicc ${operation} 触发频率限制（HTTP 429）`)
  if (status === 402 || /quota|credit|limit reached|insufficient|subscription|upgrade/i.test(text)) return new LogiccError('rate_limit', status, `Logicc 账号额度或套餐限制（HTTP ${status}）`, { cooldownSeconds: 300 })
  if ((status === 400 || status === 404 || status === 422) && /model/i.test(text)) return new LogiccError('model', status, `此账号不能使用请求的模型（HTTP ${status}）`)
  if (status >= 500) return new LogiccError('upstream', status, `Logicc ${operation} 暂时失败（HTTP ${status}）`)
  if (status === 408) return new LogiccError('network', status, `Logicc ${operation} 请求超时`)
  return new LogiccError('client', status >= 400 ? status : 502, `Logicc ${operation} 返回 HTTP ${status}：${detail}`, { publicMessage: 'The upstream service rejected the request' })
}

export function networkFailure(error: unknown, host: string): LogiccError {
  const known: Record<string, string> = {
    EAI_AGAIN: 'DNS 暂时解析失败', ENOTFOUND: 'DNS 找不到上游域名', ECONNREFUSED: '连接被拒绝', ECONNRESET: '连接被中断',
    ETIMEDOUT: '连接超时', UND_ERR_CONNECT_TIMEOUT: '连接超时', UND_ERR_SOCKET: '连接被中断',
    CERT_HAS_EXPIRED: 'TLS 证书已过期', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书无法验证',
  }
  const cause = (error as { cause?: { code?: string; errors?: { code?: string }[] }; code?: string })
  const code = [cause?.cause?.code, cause?.code, ...(cause?.cause?.errors || []).map(item => item?.code)].find(item => item && Object.hasOwn(known, item))
  // Only the hostname and a known network code: URLs and headers carry credentials.
  return new LogiccError('network', 502, `${host}：${code ? `${known[code]}（${code}）` : '网络连接失败'}`)
}
