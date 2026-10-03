import { defineEventHandler } from 'h3'
import { listPresets } from '../../lib/presets'
import { isModuleEnabled } from '../../lib/modules'
export default defineEventHandler(async () => { const [presets, moduleEnabled] = await Promise.all([listPresets(), isModuleEnabled('presets')]); return { presets, moduleEnabled } })
