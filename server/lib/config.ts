export interface AppConfig {
  databaseUrl: string; redisUrl: string; encryptionKey: string
  adminUsername: string; adminPassword: string; appUrl: string
  /**
   * Base URL the CPA kernel uses to call back into this application for
   * module bridge channels. It is an internal container address and never
   * leaves the deployment network.
   */
  bridgeBaseUrl: string
}
let cached: AppConfig | undefined
function httpUrl(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('Invalid HTTP URL configuration')
  return value.replace(/\/+$/, '')
}
export function getConfig(): AppConfig {
  if (cached) return cached
  const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error('Missing configuration: ' + name); return value }
  const encryptionKey = required('APP_ENCRYPTION_KEY')
  if (Buffer.from(encryptionKey, 'base64').length !== 32) throw new Error('APP_ENCRYPTION_KEY must be a base64-encoded 32-byte key')
  const adminPassword = required('ADMIN_PASSWORD')
  if (adminPassword.length < 12) throw new Error('ADMIN_PASSWORD must contain at least 12 characters')
  cached = {
    databaseUrl: required('DATABASE_URL'), redisUrl: required('REDIS_URL'), encryptionKey,
    adminUsername: process.env.ADMIN_USERNAME || 'admin', adminPassword,
    appUrl: httpUrl(process.env.APP_URL || 'http://localhost:3000'),
    bridgeBaseUrl: httpUrl(process.env.NEXUS_BRIDGE_BASE_URL?.trim() || 'http://app:3000'),
  }
  return cached
}
export function resetConfigForTests() { cached = undefined }
