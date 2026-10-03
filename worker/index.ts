import 'dotenv/config'
import { Worker, DelayedError } from 'bullmq'
import { createRedisConnection, getRedis, closeRedis } from '../server/lib/redis'
import { getSettings } from '../server/lib/settings'
import { closeDb } from '../server/lib/db'
import { closeQueues, IMPORT_QUEUE, REFRESH_QUEUE, enqueueAccountRefresh } from '../server/lib/queues'
import { processImport, processRefresh } from './tasks'
import { schedulerTick, WORKER_HEARTBEAT_KEY } from './scheduler'
import { migrate } from '../server/lib/migrations'
import { isModuleEnabled } from '../server/lib/modules'
import { refreshCommandcodeBridge } from '../server/lib/commandcode-bridge'

async function main() {
  await migrate()
  const settings=await getSettings()
  const importer=new Worker(IMPORT_QUEUE,async(job,token)=>{
    if(!await isModuleEnabled('commandcode')) { await job.moveToDelayed(Date.now()+30_000,token);throw new DelayedError() }
    return processImport(job)
  },{connection:createRedisConnection(),concurrency:1})
  const refresher=new Worker(REFRESH_QUEUE,async(job,token)=>{
    if(!await isModuleEnabled('commandcode')) { await job.moveToDelayed(Date.now()+30_000,token);throw new DelayedError() }
    return processRefresh(job,token)
  },{connection:createRedisConnection(),concurrency:settings.refreshConcurrency})
  for(const worker of [importer,refresher])worker.on('error',()=>{console.error('Worker queue connection error')})
  refresher.on('completed',job=>{
    void getRedis().exists(`ccm:refresh:dirty:${job.data.accountId}`).then(dirty=>dirty?enqueueAccountRefresh(job.data.accountId,{reason:'request'}):undefined).catch(()=>{})
  })
  const timer=setInterval(()=>{void isModuleEnabled('commandcode').then(enabled=>enabled?getSettings().then(s=>{refresher.concurrency=s.refreshConcurrency;return schedulerTick()}):undefined).catch(()=>{console.error('Worker scheduler check failed')})},10_000)
  timer.unref()
  const bridgeTimer=setInterval(()=>{void refreshCommandcodeBridge().catch(()=>{console.error('CommandCode CPA channel refresh failed; existing channel was preserved')})},120_000)
  bridgeTimer.unref()
  const heartbeat=setInterval(()=>{void getRedis().set(WORKER_HEARTBEAT_KEY,new Date().toISOString(),'EX',45).catch(()=>{})},10_000)
  heartbeat.unref()
  let closing=false
  const stop=async(force=false)=>{
    if(closing)return;closing=true;clearInterval(timer);clearInterval(heartbeat);clearInterval(bridgeTimer)
    await Promise.allSettled([importer.close(force),refresher.close(force)]);await closeQueues();await closeRedis(force);await closeDb()
  }
  process.on('SIGTERM',()=>{void stop()});process.on('SIGINT',()=>{void stop()})
  try { if(await isModuleEnabled('commandcode'))await schedulerTick() }
  catch(error) {
    // BullMQ owns an additional blocking connection; closing shared Redis alone leaves a
    // failed startup process reconnecting forever. Stop both workers before propagating.
    await stop(true)
    throw error
  }
}
main().catch(async()=>{console.error('Worker startup failed; check database, Redis and configuration.');await closeRedis(true);await closeDb();process.exitCode=1})
