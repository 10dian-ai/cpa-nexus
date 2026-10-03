import { beforeEach,describe,it,expect,vi } from 'vitest'
import type { Job } from 'bullmq'
import { CommandCodeClient,CommandCodeError } from '../server/lib/commandcode'
import type { ImportJobData } from '../server/lib/queues'

const fixture=vi.hoisted(()=>({
  account:{id:'account-id',upstream_user_id:'user-id',credential_fingerprint:'fingerprint',cookie_ciphertext:'encrypted-cookie'},
  acceptsFailure:true,
  failureWrites:0,
  decrypt:vi.fn((_value:string)=>'fake-cookie'),
  redis:{incr:vi.fn(async()=>1),expire:vi.fn(async()=>1),set:vi.fn(async()=>'OK'),del:vi.fn(async()=>1)},
  publish:vi.fn(async()=>{}),
}))
vi.mock('../server/lib/db',()=>{
  const sql:any=(strings:TemplateStringsArray,..._values:unknown[])=>{
    const query=strings.join('?')
    if(query.startsWith('AND ') || !query.trim())return {}
    if(query.startsWith('SELECT * FROM managed_accounts'))return Promise.resolve([fixture.account])
    if(query.includes('UPDATE managed_accounts SET status=?')){
      fixture.failureWrites++
      return Promise.resolve(fixture.acceptsFailure?[{id:fixture.account.id}]:[])
    }
    return Promise.resolve([{id:fixture.account.id}])
  }
  sql.json=(value:unknown)=>value
  sql.array=(value:unknown)=>value
  return {getDb:()=>sql}
})
vi.mock('../server/lib/redis',()=>({getRedis:()=>fixture.redis}))
vi.mock('../server/lib/crypto',()=>({decryptSecret:(value:string)=>fixture.decrypt(value)}))
vi.mock('../server/lib/accounts',()=>({
  createPendingAccount:async()=>fixture.account,
  attachIdentity:async()=>({account:fixture.account,updated:false}),
}))
vi.mock('../server/lib/events',()=>({publishUpdate:fixture.publish}))
vi.mock('../worker/coordination',()=>({rateLimitUpstream:async()=>{},withAccountLock:async(_id:string,run:any)=>run(async()=>{})}))
vi.mock('../worker/keys',()=>({ensureDedicatedKey:async()=>{}}))
import { markSyncFailure,processImport,syncAccount } from '../worker/tasks'

describe('account synchronization failure ownership',()=>{
  beforeEach(()=>{
    vi.restoreAllMocks();vi.clearAllMocks()
    fixture.acceptsFailure=true;fixture.failureWrites=0
    fixture.decrypt.mockImplementation(()=> 'fake-cookie')
  })
  it('counts a failed imported-account sync only once and retains the checkpoint',async()=>{
    vi.spyOn(CommandCodeClient.prototype,'session').mockResolvedValue({user:{id:'user-id'}})
    vi.spyOn(CommandCodeClient.prototype,'snapshot').mockRejectedValue(new CommandCodeError('UPSTREAM_UNAVAILABLE',503))
    const job={
      data:{entries:[{line:1,ciphertext:'encrypted-cookie',fingerprint:'fingerprint'}],rejected:[],duplicates:0},
      updateProgress:vi.fn(async()=>{}),updateData:vi.fn(async()=>{}),
    }
    const result=await processImport(job as unknown as Job<ImportJobData>)
    expect(result).toMatchObject({imported:0,updated:0,failed:1,skipped:0})
    expect(fixture.failureWrites).toBe(1)
    expect(fixture.redis.incr).toHaveBeenCalledTimes(1)
    expect(job.updateData).toHaveBeenCalledWith(expect.objectContaining({checkpoint:{next:1,result}}))
  })
  it('does not back off or notify for a deleted account or a replaced credential',async()=>{
    fixture.acceptsFailure=false
    await markSyncFailure('account-id',new CommandCodeError('INVALID_SESSION',401,true),'old-fingerprint')
    expect(fixture.redis.incr).not.toHaveBeenCalled()
    expect(fixture.redis.set).not.toHaveBeenCalled()
    expect(fixture.publish).not.toHaveBeenCalled()
  })
  it('records decryption failure instead of leaving the account ready',async()=>{
    fixture.decrypt.mockImplementation(()=>{throw new Error('Unable to decrypt credential')})
    await expect(syncAccount('account-id')).rejects.toThrow('Unable to decrypt credential')
    expect(fixture.failureWrites).toBe(1)
    expect(fixture.redis.incr).toHaveBeenCalledTimes(1)
  })
})
