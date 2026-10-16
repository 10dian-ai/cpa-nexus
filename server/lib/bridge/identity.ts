import { createHmac, timingSafeEqual } from 'node:crypto'
import { getConfig } from '../config'

/**
 * Route context carried from the unified router through CPA to a module bridge.
 *
 * The router decides which client key, call group and request a bridge call
 * belongs to. CPA forwards these headers unchanged (its bridge channel maps
 * them with `$Header` placeholders); the module verifies the signature, so a
 * caller can never pick another key's group by sending these headers itself.
 * Client-supplied `x-nexus-*` headers are stripped before requests reach CPA.
 */
export const ROUTE_HEADERS = {
  keyId: 'x-nexus-original-key-id',
  groupId: 'x-nexus-route-group',
  requestId: 'x-nexus-request-id',
  expires: 'x-nexus-route-expires',
  signature: 'x-nexus-route-signature',
} as const
/** Header names as configured on the CPA channel (`Name: $Name`). */
export const ROUTE_HEADER_NAMES = ['X-Nexus-Original-Key-ID', 'X-Nexus-Route-Group', 'X-Nexus-Request-ID', 'X-Nexus-Route-Expires', 'X-Nexus-Route-Signature'] as const

export interface RouteContext { moduleId: string; keyId: string; groupId: string; requestId: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/
/** A route signature outlives the longest upstream wait CPA may add before calling the bridge. */
export const ROUTE_TTL_MS = 10 * 60_000

function sign(context: RouteContext, expires: number): string {
  return createHmac('sha256', Buffer.from(getConfig().encryptionKey, 'base64'))
    .update(['cpa-nexus:bridge-route:v1', context.moduleId, context.keyId, context.groupId, context.requestId, String(expires)].join('\0'))
    .digest('base64url')
}

export function routeHeaders(context: RouteContext, now = Date.now()): Record<string, string> {
  if (!UUID.test(context.keyId) || !UUID.test(context.groupId) || !UUID.test(context.requestId) || !/^[a-z0-9-]{1,32}$/.test(context.moduleId))
    throw new Error('Invalid bridge route context')
  const expires = now + ROUTE_TTL_MS
  return {
    [ROUTE_HEADERS.keyId]: context.keyId, [ROUTE_HEADERS.groupId]: context.groupId, [ROUTE_HEADERS.requestId]: context.requestId,
    [ROUTE_HEADERS.expires]: String(expires), [ROUTE_HEADERS.signature]: sign(context, expires),
  }
}

export function verifyRouteHeaders(moduleId: string, headers: Record<string, string | string[] | undefined>, now = Date.now()): RouteContext | null {
  const value = (name: string) => { const item = headers[name]; return typeof item === 'string' ? item.trim() : '' }
  const keyId = value(ROUTE_HEADERS.keyId), groupId = value(ROUTE_HEADERS.groupId), requestId = value(ROUTE_HEADERS.requestId)
  const expires = Number(value(ROUTE_HEADERS.expires)), signature = value(ROUTE_HEADERS.signature)
  if (!UUID.test(keyId) || !UUID.test(groupId) || !UUID.test(requestId) || !SIGNATURE.test(signature)) return null
  if (!Number.isSafeInteger(expires) || expires < now || expires > now + ROUTE_TTL_MS + 60_000) return null
  const context = { moduleId, keyId, groupId, requestId }
  const expected = Buffer.from(sign(context, expires), 'base64url')
  const actual = Buffer.from(signature, 'base64url')
  return actual.length === expected.length && timingSafeEqual(actual, expected) ? context : null
}
