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
/**
 * Headers Logicc's own web app sends. Clerk and Logicc sit behind bot
 * protection that is stricter with requests that do not look like a browser.
 */
export function browserHeaders(): Record<string, string> {
  return {
    'user-agent': process.env.LOGICC_USER_AGENT?.trim() || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    'accept-language': 'en-US,en;q=0.9',
    origin: LOGICC_ORIGIN,
    referer: LOGICC_ORIGIN + '/',
  }
}
/** Credential rejections in a row (without a success in between) before an account leaves the pool. */
export const CREDENTIAL_STRIKE_LIMIT = 3
/** A session JWT is treated as expired this long before its `exp`. */
export const TOKEN_EXPIRY_MARGIN_MS = 10_000
