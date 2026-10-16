import 'dotenv/config'
import { Worker, DelayedError } from 'bullmq'
import { createRedisConnection, getRedis, closeRedis } from '../server/lib/redis'
import { closeDb } from '../server/lib/db'
import { closeQueues, INTAKE_QUEUE } from '../server/lib/queues'
import { processIntake } from './intake'
import { ensureNativeCpaPrivacy } from '../server/lib/cpa/privacy'
import { resetCpaGroupRouting } from '../server/lib/cpa/group-routing'
import { schedulerTick, WORKER_HEARTBEAT_KEY } from './scheduler'
import { migrate } from '../server/lib/migrations'
import { isModuleEnabled } from '../server/lib/modules'

async function main() {
  await migrate()
  const intake = new Worker(INTAKE_QUEUE, async (job, token) => {
    if (!await isModuleEnabled(job.data.moduleId)) { await job.moveToDelayed(Date.now() + 30_000, token); throw new DelayedError() }
    return processIntake(job)
  }, { connection: createRedisConnection(), concurrency: 2 })
  intake.on('error', () => console.error('Intake queue connection error'))

  const scheduler = setInterval(() => { void schedulerTick().catch(() => console.error('Worker scheduler tick failed')) }, 10_000)
  scheduler.unref()
  let privacyPending = false
  const privacyTimer = setInterval(() => {
    if (privacyPending) return
    privacyPending = true
    void ensureNativeCpaPrivacy().then(result => { if (result.changed) resetCpaGroupRouting() })
      .catch(() => console.error('CPA request-header privacy reconciliation failed; inspect core connection'))
      .finally(() => { privacyPending = false })
  }, 60_000)
  privacyTimer.unref()
  const heartbeat = setInterval(() => { void getRedis().set(WORKER_HEARTBEAT_KEY, new Date().toISOString(), 'EX', 45).catch(() => {}) }, 10_000)
  heartbeat.unref()

  let closing = false
  const stop = async (force = false) => {
    if (closing) return
    closing = true
    clearInterval(scheduler); clearInterval(privacyTimer); clearInterval(heartbeat)
    await intake.close(force).catch(() => {})
    await closeQueues(); await closeRedis(force); await closeDb()
  }
  process.on('SIGTERM', () => { void stop() })
  process.on('SIGINT', () => { void stop() })
  try { await schedulerTick() }
  catch (error) {
    // BullMQ holds a second blocking connection; stop the worker before propagating.
    await stop(true)
    throw error
  }
}
main().catch(async () => { console.error('Worker startup failed; check database, Redis and configuration.'); await closeRedis(true); await closeDb(); process.exitCode = 1 })
