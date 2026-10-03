import { defineEventHandler } from 'h3'
import { getSettings } from '../lib/settings'
import { getConfig } from '../lib/config'
export const KERNEL_INFO = { version: 'official-provider-v1', upstreamCommit: null, cliVersion: null }
export default defineEventHandler(async () => ({ settings: await getSettings(), kernel: KERNEL_INFO,
  provider: {baseUrl:getConfig().commandcodeApiUrl,authentication:'API Key',credentialManagement:'Cookie'} }))
