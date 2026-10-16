/**
 * Logicc endpoints. Overridable for tests and for deployments that reach
 * Logicc through a proxy; the defaults are the public production services.
 */
export const LOGICC_POOL_ID = 'logicc'
export const LOGICC_ORIGIN = 'https://app.logicc.com'
function base(name: string, fallback: string): string {
  const value = (process.env[name]?.trim() || fallback).replace(/\/+$/, '')
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`Invalid ${name}`)
  return value
}
export function logiccApiBase() { return base('LOGICC_API_BASE', 'https://app.logicc.com/api') }
export function logiccClerkBase() { return base('LOGICC_CLERK_BASE', 'https://clerk.logicc.com') }
/** A session JWT is treated as expired this long before its `exp`. */
export const TOKEN_EXPIRY_MARGIN_MS = 10_000
