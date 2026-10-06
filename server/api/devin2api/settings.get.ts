import { defineEventHandler } from 'h3'
import { getDevinStatus } from '../../lib/devin2api/admin'
export default defineEventHandler(async () => { const status = await getDevinStatus(); return { settings: { mode: status.mode, url: null, configured: status.configured, binaryAvailable: status.binaryAvailable, timeoutMs: Number(process.env.DEVIN2API_TIMEOUT_MS || 15000) }, status } })
