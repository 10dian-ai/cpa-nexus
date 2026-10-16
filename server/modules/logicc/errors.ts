import { redactSensitiveText } from '../../../shared/log-privacy'

/**
 * Why a Logicc call failed, which decides what happens to the account:
 * - `credential`: the session is revoked or the cookie no longer works → account needs new credentials.
 * - `rate_limit`: the account is temporarily throttled → short cooldown, try another account.
 * - `model`: this account cannot use the requested model → try another account.
 * - `upstream` / `network`: transient Logicc or network failure → brief cooldown, try another account.
 * - `client`: the request itself is unusable on any account → return to the caller.
 * - `unsupported`: Logicc cannot serve this kind of request → let another source take it.
 * - `generation`: the model answered, but not in a usable form (e.g. a malformed tool call) → not the account's fault.
 */
export type LogiccFailureKind = 'credential' | 'rate_limit' | 'model' | 'upstream' | 'network' | 'client' | 'unsupported' | 'generation'
export class LogiccError extends Error {
  constructor(public readonly kind: LogiccFailureKind, public readonly status: number, message: string) {
    super(redactLogiccText(message))
    this.name = 'LogiccError'
  }
  /** Another account may succeed where this one failed. */
  get accountSpecific() { return ['credential', 'rate_limit', 'model', 'upstream', 'network'].includes(this.kind) }
  /** Seconds the account rests before it is selected again. */
  get cooldownSeconds() {
    return this.kind === 'rate_limit' ? 60 : this.kind === 'credential' ? 300 : this.kind === 'upstream' || this.kind === 'network' ? 15 : 0
  }
}

/** Never let session JWTs, Clerk client cookies or session IDs reach logs and responses. */
export function redactLogiccText(value: unknown): string {
  return redactSensitiveText(String(value ?? ''))
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[凭据已隐藏]')
    .replace(/__client=[^;\s]+/gi, '__client=[凭据已隐藏]')
    .replace(/\bsess_[A-Za-z0-9]{6,}\b/g, 'sess_[已隐藏]')
    .slice(0, 500)
}

/** Map an HTTP failure from Logicc's API to a failure kind. */
export function classifyLogiccStatus(status: number, body: string, operation: string): LogiccError {
  const text = body.slice(0, 2000)
  if (status === 401 || status === 403) return new LogiccError('credential', status, `Logicc ${operation} 拒绝了账号凭据（HTTP ${status}）`)
  if (status === 429) return new LogiccError('rate_limit', status, `Logicc ${operation} 触发频率限制（HTTP 429）`)
  if (status === 402 || /quota|credit|limit reached|insufficient|subscription|upgrade/i.test(text)) return new LogiccError('rate_limit', status, `Logicc 账号额度或套餐限制（HTTP ${status}）`)
  if ((status === 400 || status === 404 || status === 422) && /model/i.test(text)) return new LogiccError('model', status, `此账号不能使用请求的模型（HTTP ${status}）`)
  if (status >= 500) return new LogiccError('upstream', status, `Logicc ${operation} 暂时失败（HTTP ${status}）`)
  if (status === 408) return new LogiccError('network', status, `Logicc ${operation} 请求超时`)
  return new LogiccError('client', status >= 400 ? status : 502, `Logicc ${operation} 返回 HTTP ${status}`)
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
