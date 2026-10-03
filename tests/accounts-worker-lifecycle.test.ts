import { describe,it,expect,vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../shared/types'

const fixture=vi.hoisted(()=>({
  workers:[] as {close:ReturnType<typeof vi.fn>}[],
  closeQueues:vi.fn(async()=>{}),closeRedis:vi.fn(async(_force?:boolean)=>{}),closeDb:vi.fn(async()=>{}),
  redis:{exists:vi.fn(async()=>0),set:vi.fn(async()=>'OK')},
}))
vi.mock('dotenv/config',()=>({}))
vi.mock('bullmq',()=>({Worker:class {
  concurrency=2
  close=vi.fn(async(_force?:boolean)=>{})
  constructor(){fixture.workers.push(this)}
  on(){return this}
}}))
vi.mock('../server/lib/redis',()=>({getRedis:()=>fixture.redis,createRedisConnection:()=>({}),closeRedis:fixture.closeRedis}))
vi.mock('../server/lib/db',()=>({closeDb:fixture.closeDb}))
vi.mock('../server/lib/settings',()=>({getSettings:async()=>DEFAULT_SETTINGS}))
vi.mock('../server/lib/queues',()=>({IMPORT_QUEUE:'test-import',REFRESH_QUEUE:'test-refresh',enqueueAccountRefresh:async()=>{},closeQueues:fixture.closeQueues}))
vi.mock('../server/lib/migrations',()=>({migrate:async()=>{}}))
vi.mock('../worker/tasks',()=>({processImport:async()=>{},processRefresh:async()=>{}}))
vi.mock('../worker/scheduler',()=>({WORKER_HEARTBEAT_KEY:'test-heartbeat',schedulerTick:async()=>{throw new Error('initial scheduler database unavailable')}}))

describe('worker failed startup cleanup',()=>{
  it('closes both BullMQ workers and timers when the first scheduling tick fails',async()=>{
    const exitCode=process.exitCode
    const signals=['SIGTERM','SIGINT'] as const
    const listeners=signals.map(signal=>new Set(process.listeners(signal)))
    const log=vi.spyOn(console,'error').mockImplementation(()=>{})
    vi.useFakeTimers()
    try {
      await import('../worker/index')
      await vi.waitFor(()=>expect(process.exitCode).toBe(1))
      expect(fixture.workers).toHaveLength(2)
      for(const worker of fixture.workers)expect(worker.close).toHaveBeenCalledExactlyOnceWith(true)
      expect(fixture.closeQueues).toHaveBeenCalledTimes(1)
      expect(fixture.closeRedis).toHaveBeenCalledWith(true)
      expect(fixture.closeDb).toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      process.exitCode=exitCode
      for(const [index,signal] of signals.entries()){
        for(const listener of process.listeners(signal))if(!listeners[index]!.has(listener))process.removeListener(signal,listener)
      }
      vi.useRealTimers();log.mockRestore()
    }
  })
})
