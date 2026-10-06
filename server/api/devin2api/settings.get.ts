import { defineEventHandler } from 'h3'
import { getDevinStatus } from '../../lib/devin2api/admin'
export default defineEventHandler(async () => { const status = await getDevinStatus(); return { settings: { url: status.url, configured: status.configured, apiKeyConfigured: Boolean(process.env.DEVIN2API_API_KEY?.trim()), timeoutMs: Number(process.env.DEVIN2API_TIMEOUT_MS || 15000) }, status } })
