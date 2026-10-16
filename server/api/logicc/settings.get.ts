import { defineEventHandler } from 'h3'
import { getLogiccSecrets, getLogiccSettings } from '../../modules/logicc/settings'
import { readCalibration } from '../../modules/logicc/tokens'
import type { LogiccSettingsView } from '../../../shared/logicc'

export default defineEventHandler(async (): Promise<LogiccSettingsView> => {
  const [settings, secrets, calibrated] = await Promise.all([getLogiccSettings(), getLogiccSecrets(), readCalibration()])
  return { ...settings, anthropicCountKeySet: !!secrets.anthropicCountKey, geminiCountKeySet: !!secrets.geminiCountKey, calibrated }
})
