/**
 * Shared validation for the two CPA access-key APIs.
 *
 * CPA v8 accepts a JSON string array while the legacy v0 console also accepts
 * `{ items: string[] }`.  Keeping the shape handling in this small module
 * prevents the management proxy and the embedded console from drifting apart
 * when the reserved Nexus client key is retained.
 */
export type LegacyAccessKeyPayload = unknown[] | { items?: unknown }

export function parseJsonAccessKeyPayload(body: Uint8Array | string | undefined): unknown {
  try {
    const text = typeof body === 'string' ? body : body ? new TextDecoder().decode(body) : ''
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Return a validated key list, or `undefined` when the payload is malformed. */
export function parseClientKeyList(value: unknown, mode: 'v8' | 'v0' = 'v8'): string[] | undefined {
  const list = mode === 'v0' && value && typeof value === 'object' && !Array.isArray(value)
    ? (value as { items?: unknown }).items
    : value
  if (!Array.isArray(list) || list.some(key => typeof key !== 'string' || !key.trim() || /[\r\n]/.test(key))) return undefined
  return list
}

/** Preserve the private key used by Nexus while removing duplicate entries. */
export function withReservedClientKey(keys: readonly string[], reserved: string): string[] {
  return [...new Set([...keys, reserved])]
}

