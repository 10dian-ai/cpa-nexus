import type { Job } from 'bullmq'
import { decryptSecret } from '../server/lib/crypto'
import { intakeHandler } from '../server/modules/registry'
import { reconcileModuleBridge } from '../server/modules/bridge-maintenance'
import type { IntakeJobData } from '../server/lib/queues'
import type { ImportResult } from '../shared/types'
import { isPoolModuleId } from '../shared/modules'

/** Process one account-import job: run every entry through its module's intake handler. */
export async function processIntake(job: Job<IntakeJobData>): Promise<ImportResult> {
  const handler = intakeHandler(job.data.moduleId)
  const result: ImportResult = { imported: 0, updated: 0, failed: 0, skipped: 0, errors: [] }
  const total = job.data.entries.length
  let processed = 0
  for (const entry of job.data.entries) {
    try {
      const payload = JSON.parse(decryptSecret(entry.ciphertext)) as Record<string, unknown>
      const outcome = await handler.process(payload, { groupIds: job.data.groupIds })
      if (outcome.result === 'imported') result.imported++
      else if (outcome.result === 'updated') result.updated++
      else result.skipped++
      if (outcome.warning) result.errors.push({ line: entry.line, message: outcome.warning })
    } catch (error) {
      result.failed++
      result.errors.push({ line: entry.line, message: error instanceof Error ? error.message.slice(0, 300) : '导入失败' })
    }
    await job.updateProgress({ processed: ++processed, total })
  }
  // New accounts change what the module serves; refresh its CPA bridge channel.
  if ((result.imported || result.updated) && isPoolModuleId(job.data.moduleId)) await reconcileModuleBridge(job.data.moduleId).catch(() => {})
  return result
}
