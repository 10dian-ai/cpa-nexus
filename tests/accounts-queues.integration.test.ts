import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import { Worker } from 'bullmq'
import { afterEach,beforeEach,describe,it,expect,vi } from 'vitest'
import { CommandCodeClient } from '../server/lib/commandcode'
import { DEFAULT_SETTINGS } from '../shared/types'

const fixture=vi.hoisted(()=>({prefix:'',raw:undefined as Redis|undefined,redis:undefined as Redis|undefined,connections:[] as Redis[]}))
vi.mock('bullmq',async importOriginal=>{
  const actual=await importOriginal<typeof import('bullmq')>()
  return {...actual,Queue:class extends actual.Queue {
    constructor(name:string,options:any){super(name,{...options,prefix:fixture.prefix+':queues'})}
  }}
})
vi.mock('../server/lib/redis',()=>({
  getRedis:()=>fixture.redis,
  createRedisConnection:()=>{
    const connection=new Redis(process.env.TEST_REDIS_URL!,{maxRetriesPerRequest:null})
    fixture.connections.push(connection)
    return connection
  },
}))
vi.mock('../server/lib/crypto',()=>({decryptSecret:(value:string)=>value,encryptSecret:(value:string)=>value,fingerprint:(value:string)=>value}))
vi.mock('../server/lib/db',()=>{
  const sql:any=(strings:TemplateStringsArray,...values:unknown[])=>{
    const query=strings.join('?')
    if(query.startsWith('SELECT * FROM managed_accounts'))return Promise.resolve([{id:values[0],upstream_user_id:values[0],credential_fingerprint:'test-fingerprint',cookie_ciphertext:values[0]}])
    if(query.startsWith('AND ')||!query.trim())return {}
    return Promise.resolve([{id:'test-id'}])
  }
  sql.json=(value:unknown)=>value
  sql.array=(value:unknown)=>value
  return {getDb:()=>sql}
})
vi.mock('../server/lib/settings',()=>({getSettings:async()=>DEFAULT_SETTINGS}))
vi.mock('../server/lib/accounts',()=>({createPendingAccount:async()=>{throw new Error('No import in queue integration')},attachIdentity:async()=>{throw new Error('Existing identity only')}}))
vi.mock('../server/lib/events',()=>({publishUpdate:async()=>{}}))
vi.mock('../worker/keys',()=>({ensureDedicatedKey:async()=>{}}))
import { closeQueues,enqueueAccountRefresh,getRefreshQueue,REFRESH_QUEUE,REFRESH_PRIORITY } from '../server/lib/queues'
import { processRefresh } from '../worker/tasks'

const redisUrl=process.env.TEST_REDIS_URL
// Only connection-prefix plumbing and the upstream/DB boundary are mocked. The real BullMQ
// queue, Worker, delay scripts, account lock and refresh processor all execute against Redis.
describe.skipIf(!redisUrl)('BullMQ account refresh compatibility (Redis integration)',()=>{
  let workers:Worker[]=[]
  let processed:string[]=[]
  let errors:Error[]=[]
  beforeEach(async()=>{
    fixture.prefix='ccm-queue-test:'+randomUUID()
    fixture.connections=[];workers=[];processed=[];errors=[]
    fixture.raw=new Redis(redisUrl!,{lazyConnect:true,maxRetriesPerRequest:1})
    fixture.redis=new Redis(redisUrl!,{lazyConnect:true,maxRetriesPerRequest:1,keyPrefix:fixture.prefix+':app:'})
    await Promise.all([fixture.raw.connect(),fixture.redis.connect()])
    // toKey() already returns the fully qualified BullMQ key; do not apply the app prefix twice.
    fixture.redis.zscore=fixture.raw.zscore.bind(fixture.raw)
    vi.spyOn(CommandCodeClient.prototype,'snapshot').mockImplementation(async cookie=>{
      processed.push(cookie)
      return {identity:{id:cookie,name:'fixture',email:null},credits:{},windowLimits:null,
        subscription:{planId:null,status:null,currentPeriodStart:null,currentPeriodEnd:null,cancelAtPeriodEnd:null},usage:{},fetchedAt:new Date().toISOString()}
    })
    await getRefreshQueue().waitUntilReady()
  })
  afterEach(async()=>{
    await Promise.all(workers.map(worker=>worker.close(true)))
    await closeQueues()
    for(const connection of fixture.connections)connection.disconnect()
    if(fixture.raw){
      let cursor='0'
      do{
        const result=await fixture.raw.scan(cursor,'MATCH',fixture.prefix+':*','COUNT',100)
        cursor=result[0]
        if(result[1].length)await fixture.raw.unlink(...result[1])
      }while(cursor!=='0')
    }
    fixture.raw?.disconnect();fixture.redis?.disconnect();vi.restoreAllMocks()
  })
  function startWorker(){
    const connection=new Redis(redisUrl!,{maxRetriesPerRequest:null})
    fixture.connections.push(connection)
    const worker=new Worker(REFRESH_QUEUE,processRefresh,{connection,prefix:fixture.prefix+':queues',concurrency:1})
    worker.on('error',error=>errors.push(error))
    workers.push(worker)
    return worker
  }
  it('shortens real delayed jobs once and promotes forced manual refresh without losing priority',async()=>{
    const id=randomUUID(),queue=getRefreshQueue(),jobId='refresh-'+id
    await fixture.redis!.set('ccm:refresh:backoff:'+id,'1','PX',60_000)
    await enqueueAccountRefresh(id,{reason:'scheduled'})
    expect(await (await queue.getJob(jobId))!.getState()).toBe('delayed')
    const original=Number(await fixture.raw!.zscore(queue.toKey('delayed'),jobId))/4096
    await fixture.redis!.del('ccm:refresh:backoff:'+id)
    await enqueueAccountRefresh(id,{reason:'request'})
    const shortened=Number(await fixture.raw!.zscore(queue.toKey('delayed'),jobId))/4096
    expect(shortened).toBeLessThan(original-40_000)
    expect(shortened-Date.now()).toBeGreaterThan(8000)
    await enqueueAccountRefresh(id,{reason:'request'})
    expect(Number(await fixture.raw!.zscore(queue.toKey('delayed'),jobId))/4096).toBe(shortened)
    expect((await queue.getJob(jobId))!.priority).toBe(REFRESH_PRIORITY.request)
    await enqueueAccountRefresh(id,{reason:'manual',force:true})
    const promoted=(await queue.getJob(jobId))!
    expect(await promoted.getState()).toBe('prioritized')
    expect(promoted.priority).toBe(REFRESH_PRIORITY.manual)
    expect(promoted.data.reason).toBe('manual')
    expect(await queue.getJobCounts('delayed','prioritized')).toMatchObject({delayed:0,prioritized:1})
  })
  it('processes promoted manual and active jobs before idle work and closes its blocking connection',async()=>{
    const idle=randomUUID(),active=randomUUID(),manual=randomUUID()
    for(const id of [idle,active,manual])await enqueueAccountRefresh(id,{reason:'scheduled'})
    await enqueueAccountRefresh(active,{reason:'request'})
    await enqueueAccountRefresh(manual,{reason:'manual',force:true})
    const worker=startWorker()
    let completed=0
    worker.on('completed',()=>{completed++})
    await vi.waitFor(()=>expect(completed).toBe(3),{timeout:5000,interval:20})
    expect(processed).toEqual([manual,active,idle])
    for(const id of [idle,active,manual])expect(await fixture.redis!.get('ccm:refresh:dirty:'+id)).toBeNull()
    await worker.close()
    expect(worker.isRunning()).toBe(false)
    expect(errors).toEqual([])
  })
  it('uses moveToDelayed from the real refresh processor until upstream backoff expires',async()=>{
    const id=randomUUID(),queue=getRefreshQueue(),jobId='refresh-'+id
    await enqueueAccountRefresh(id,{reason:'scheduled'})
    await fixture.redis!.set('ccm:refresh:backoff:'+id,'1','PX',700)
    const worker=startWorker()
    let completed=0
    worker.on('completed',()=>{completed++})
    await vi.waitFor(async()=>expect(await (await queue.getJob(jobId))!.getState()).toBe('delayed'),{timeout:500,interval:20})
    expect(processed).toEqual([])
    await vi.waitFor(()=>expect(completed).toBe(1),{timeout:5000,interval:20})
    expect(processed).toEqual([id])
    expect(await fixture.redis!.get('ccm:refresh:dirty:'+id)).toBeNull()
    expect(errors).toEqual([])
  })
})
