// This policy applies to diagnostics and log copies, never to routing inputs or
// successful model output. Keep the kernel's diagnostic policy in sync.
const PROVIDER_NAMES = /chat[\s_-]*gpt|open[\s_-]*ai|anthropic|gemini|claude|codex|deep[\s_-]*seek|x[\s_-]*ai|grok|qwen|zhipu|moonshot|kimi|mistral|cohere|perplexity|nvidia|vertex(?:[\s_-]*ai)?|microsoft|azure|bedrock|amazon|mini[\s_-]*max|baidu|doubao|byte[\s_-]*dance|tencent|hunyuan|devin|codeium|windsurf|goat|cognition|augment|antigravity|kiro|command[\s_-]*code|(?<![a-z0-9])(?:meta|llama|glm|aws|google)(?![a-z0-9])|谷歌|阿里(?:巴巴)?|通义千问|智谱|腾讯|字节跳动|豆包|百度|文心(?:一言)?|英伟达|微软|亚马逊/gi
// Also cover JSON-escaped slashes in raw SSE, downloaded logs and nested text.
// Stop at literal/escaped string or line boundaries so neighbouring fields stay
// readable and a URL cannot consume an entire serialized diagnostic document.
const HTTP_URLS = /https?:(?:\/|\\\/|\\u002f){2}(?:\\\/|\\u[0-9a-f]{4}|[^\s<>"'`\\])*/gi
const DIAGNOSTIC_FIELDS = /^(?:error|errors|error[_-]?message|(?:last|sync|bridge)[_-]?error|status[_-]?message|error[_-]?description|stack|stackTrace)$/i

export function redactSensitiveText(value: string): string {
  return value.replace(HTTP_URLS, '***').replace(PROVIDER_NAMES, '***')
}

/** Full redaction for error payloads and every user-visible log field. */
export function redactLogValue<T>(value: T): T {
  if (typeof value === 'string') return redactSensitiveText(value) as T
  if (Array.isArray(value)) return value.map(redactLogValue) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [redactSensitiveText(key), redactLogValue(item)])) as T
  return value
}

/** Redact diagnostic fields embedded in otherwise usable API/config data. */
export function redactDiagnosticFields<T>(value: T): T {
  if (!value || typeof value !== 'object') return value
  let changed = false
  if (Array.isArray(value)) {
    const next = value.map(item => {
      const safe = redactDiagnosticFields(item)
      if (safe !== item) changed = true
      return safe
    })
    return changed ? next as T : value
  }
  const entries = Object.entries(value).map(([key, item]) => {
    const data = value as Record<string, unknown>
    const diagnosticMessage = key === 'message' && (data.error || data.type === 'error' || data.status === 'error' || data.status === 'failed')
    const safe = DIAGNOSTIC_FIELDS.test(key) || diagnosticMessage ? redactLogValue(item) : redactDiagnosticFields(item)
    if (safe !== item) changed = true
    return [key, safe]
  })
  return changed ? Object.fromEntries(entries) as T : value
}

export function isModelErrorPayload(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const data = value as Record<string, unknown>
  if (data.error || data.type === 'error' || data.type === 'response.failed' || data.status === 'error' || data.status === 'failed') return true
  const response = data.response
  return !!response && typeof response === 'object' && !Array.isArray(response) && isModelErrorPayload(response)
}
