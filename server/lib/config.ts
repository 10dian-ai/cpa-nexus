export interface AppConfig {
  databaseUrl: string; redisUrl: string; encryptionKey: string
  adminUsername: string; adminPassword: string; appUrl: string; kernelUrl: string
  commandcodeApiUrl: string; commandcodeManagementUrl: string
}
let cached: AppConfig | undefined
export function getConfig(): AppConfig {
  if (cached) return cached
  const required = (name: string) => { const value = process.env[name]?.trim(); if (!value) throw new Error('Missing configuration: ' + name); return value }
  const encryptionKey = required('APP_ENCRYPTION_KEY')
  if (Buffer.from(encryptionKey, 'base64').length !== 32) throw new Error('APP_ENCRYPTION_KEY must be a base64-encoded 32-byte key')
  const adminPassword = required('ADMIN_PASSWORD')
  if (adminPassword.length < 12) throw new Error('ADMIN_PASSWORD must contain at least 12 characters')
  const appUrl = process.env.APP_URL || 'http://localhost:3000'
  const kernelUrl = process.env.KERNEL_URL || 'http://127.0.0.1:3050'
  const commandcodeApiUrl = process.env.COMMANDCODE_API_URL || 'https://api.commandcode.ai/provider/v1'
  const commandcodeManagementUrl = process.env.COMMANDCODE_MANAGEMENT_URL || 'https://api.commandcode.ai'
  for (const value of [appUrl, kernelUrl, commandcodeApiUrl, commandcodeManagementUrl]) {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error('Invalid HTTP URL configuration')
  }
  cached = { databaseUrl: required('DATABASE_URL'), redisUrl: required('REDIS_URL'), encryptionKey,
    adminUsername: process.env.ADMIN_USERNAME || 'admin', adminPassword, appUrl, kernelUrl: kernelUrl.replace(/\/$/, ''),
    commandcodeApiUrl: commandcodeApiUrl.replace(/\/$/, ''), commandcodeManagementUrl: commandcodeManagementUrl.replace(/\/$/, '') }
  return cached
}
export function resetConfigForTests() { cached = undefined }
