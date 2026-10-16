import { defineEventHandler } from 'h3'
import { getDb } from '../../lib/db'
import { resetCalibrationCache } from '../../modules/logicc/tokens'

/** Forget learned usage factors; the configured factors (all ≥ 1) apply again. */
export default defineEventHandler(async () => {
  await getDb()`DELETE FROM logicc_usage_calibration`
  resetCalibrationCache()
  return { ok: true }
})
