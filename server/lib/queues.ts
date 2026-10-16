import { Queue } from 'bullmq'
import { randomUUID } from 'node:crypto'
import { createRedisConnection } from './redis'
import { encryptSecret } from './crypto'
import { getDb } from './db'
import { intakeHandler } from '../modules/registry'
import type { IntakeModuleId, IntakeRequest, IntakeSubmitResult } from '../../shared/intake'
import type { ImportIssue, ImportResult, JobView } from '../../shared/types'

/**
 * One queue imports accounts for every source module. A job carries the
 * module id and the encrypted, already-parsed credential items; the worker
 * hands each item to that module's intake handler. Payloads are encrypted at
 * rest in Redis because they contain credentials.
 */
export const INTAKE_QUEUE = 'ccm-intake'
export interface IntakeJobData { moduleId: IntakeModuleId; entries: { line: number; ciphertext: string }[]; groupIds?: string[] }
let intake: Queue<IntakeJobData> | undefined
export function getIntakeQueue() {
  return intake ??= new Queue<IntakeJobData>(INTAKE_QUEUE, {
    connection: createRedisConnection(),
    defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: { age: 86400, count: 300 }, removeOnFail: { age: 604800, count: 300 } },
  })
}

/** Items of the submission already queued (by fingerprint), so a resubmit dedupes. */
async function knownFingerprints(moduleId: IntakeModuleId, fingerprints: string[]): Promise<Set<string>> {
  if (!fingerprints.length) return new Set()
  const sql = getDb()
  const column = moduleId === 'logicc'
    ? sql`SELECT encode(sha256(convert_to('logicc:' || session_id, 'UTF8')),'hex') AS fp FROM logicc_accounts`
    : null
  if (!column) return new Set()
  const rows = await sql`SELECT fp FROM (${column}) existing WHERE fp IN ${sql(fingerprints)}`
  return new Set(rows.map(row => String(row.fp)))
}

export async function submitIntake(moduleId: IntakeModuleId, request: IntakeRequest): Promise<IntakeSubmitResult> {
  const { items, errors } = intakeHandler(moduleId).parse(request)
  const known = await knownFingerprints(moduleId, items.map(item => item.fingerprint)).catch(() => new Set<string>())
  const fresh = items.filter(item => !known.has(item.fingerprint))
  const duplicates = items.length - fresh.length
  const jobId = randomUUID()
  if (fresh.length) {
    await getIntakeQueue().add('intake', {
      moduleId, ...(request.groupIds ? { groupIds: request.groupIds } : {}),
      entries: fresh.map(item => ({ line: item.line, ciphertext: encryptSecret(JSON.stringify(item.payload)) })),
    }, { jobId })
  }
  return { jobId, moduleId, accepted: fresh.length, rejected: errors.length, duplicates, errors }
}

export async function getIntakeJobView(id: string): Promise<JobView> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw Object.assign(new Error('Job not found'), { statusCode: 404 })
  const job = await getIntakeQueue().getJob(id)
  if (!job) {
    // A submission with only duplicates/errors never creates a job, yet its id is valid.
    return { id, moduleId: '', status: 'completed', progress: { processed: 0, total: 0 }, result: { imported: 0, updated: 0, failed: 0, skipped: 0, errors: [] }, error: null }
  }
  const state = await job.getState()
  const progress = typeof job.progress === 'object' && job.progress ? job.progress as JobView['progress'] : { processed: 0, total: job.data.entries.length }
  return {
    id, moduleId: job.data.moduleId, status: state, progress,
    result: state === 'completed' ? job.returnvalue as ImportResult : null,
    error: state === 'failed' ? '导入任务中断，请重试；已完成的账号已保留。' : null,
  }
}

export async function closeQueues() { await intake?.close(); intake = undefined }
export type { ImportIssue }
