import { DelayedError, UnrecoverableError, type Job } from 'bullmq'
import { getDb } from '../server/lib/db'
import { getRedis } from '../server/lib/redis'
import { decryptSecret, encryptSecret, fingerprint } from '../server/lib/crypto'
import { CommandCodeClient, CommandCodeError } from '../server/lib/commandcode'
import { createPendingAccount, attachIdentity } from '../server/lib/accounts'
import { saveAccountSnapshot, completeAccountSync } from '../server/lib/account-quota'
import type { ImportJobData } from '../server/lib/queues'
import { publishUpdate } from '../server/lib/events'
import type { ImportResult, AccountSnapshot } from '../shared/types'
import { rateLimitUpstream, withAccountLock } from './coordination'
import { ensureDedicatedKey } from './keys'
export const client = new CommandCodeClient({ beforeRequest: rateLimitUpstream })
export function syncErrorMessage(error:unknown): string {
  if(error instanceof CommandCodeError)return error.message
  if(error instanceof Error && /^(KEY_[A-Z_]+:|ACCOUNT_SYNC_)/.test(error.message))return error.message.slice(0,300)
  return 'SYNC_FAILED: 同步失败，请稍后重试；上次成功快照已保留'
}
async function rotateSessionCookie(id: string, previousFingerprint: string, nextFingerprint: string, ciphertext: string): Promise<boolean> {
  const rows = await getDb()`UPDATE managed_accounts SET credential_fingerprint=${nextFingerprint},cookie_ciphertext=${ciphertext},sync_error=NULL,updated_at=now()
    WHERE id=${id} AND credential_fingerprint=${previousFingerprint} RETURNING id`
  return rows.length > 0
}
export async function markSyncFailure(id:string,error:unknown,fingerprint?:string) {
  const sql=getDb(), expired=error instanceof CommandCodeError && error.credentialExpired
  const updated=await sql`UPDATE managed_accounts SET status=${expired?'credential_expired':'sync_error'},sync_error=${syncErrorMessage(error)},updated_at=now()
    WHERE id=${id} ${fingerprint ? sql`AND credential_fingerprint=${fingerprint}` : sql``} RETURNING id`
  if(!updated.length)return
  const retry=error instanceof CommandCodeError ? error.retryAfterMs : 0
  const attempts=await getRedis().incr(`ccm:refresh:failures:${id}`)
  await getRedis().expire(`ccm:refresh:failures:${id}`,86400)
  await getRedis().set(`ccm:refresh:backoff:${id}`,'1','PX',Math.max(retry,Math.min(3600_000,30_000*2**Math.min(attempts,7))))
  await publishUpdate({type:'accounts',accountId:id})
}
export async function syncAccount(id:string,priorSession?:unknown):Promise<void> {
  const redirected = await withAccountLock(id,async(assertLock)=>{
    const sql=getDb(), rows=await sql`SELECT * FROM managed_accounts WHERE id=${id}`
    if(!rows.length)return
    const account=rows[0]!, cookieRef={value:''}
    let activeFingerprint=account.credential_fingerprint
    const scopedClient=new CommandCodeClient({cookieRef,beforeRequest:async()=>{await rateLimitUpstream();await assertLock()}})
    try {
      const cookie=decryptSecret(account.cookie_ciphertext)
      cookieRef.value=cookie
      const snapshot=await scopedClient.snapshot(cookie,priorSession)
      await assertLock()
      if(account.upstream_user_id && snapshot.identity.id!==account.upstream_user_id)throw new CommandCodeError('SESSION_IDENTITY_CHANGED',401,true)
      let activeCiphertext=account.cookie_ciphertext
      if(cookieRef.value!==cookie) {
        activeFingerprint=fingerprint(cookieRef.value)
        activeCiphertext=encryptSecret(cookieRef.value)
      }
      if(!account.upstream_user_id) {
        const attached=await attachIdentity(id,snapshot.identity,activeFingerprint,activeCiphertext)
        if(attached.account.id!==id)return attached.account.id as string
      } else if(activeFingerprint!==account.credential_fingerprint) {
        if(!await rotateSessionCookie(id,account.credential_fingerprint,activeFingerprint,activeCiphertext))return
        await assertLock()
      }
      const updated=await saveAccountSnapshot(id,activeFingerprint,snapshot,account.snapshot ?? null)
      if(!updated.length)return
      if(account.snapshot?.subscription?.planId && account.snapshot.subscription.planId!==snapshot.subscription.planId) {
        await sql`UPDATE account_models SET observation_scope='superseded-plan' WHERE account_id=${id} AND observation_scope='official-provider'`
      }
      await assertLock(); await ensureDedicatedKey(id,cookieRef.value,scopedClient)
      await assertLock(); await completeAccountSync(id,activeFingerprint,snapshot)
      await getRedis().del(`ccm:refresh:backoff:${id}`,`ccm:refresh:failures:${id}`)
      await publishUpdate({type:'accounts',accountId:id})
    } catch(error) {
      // A worker that lost ownership must not overwrite a newer sync's status.
      try { await assertLock() } catch { throw new Error('ACCOUNT_SYNC_LOCK_LOST') }
      await markSyncFailure(id,error,activeFingerprint);throw error
    }
  })
  if(redirected)await syncAccount(redirected)
}
interface Checkpoint { next:number; result:ImportResult }
export async function processImport(job:Job<ImportJobData & {checkpoint?:Checkpoint}>):Promise<ImportResult> {
  const {entries,groupName}=job.data
  const checkpoint=job.data.checkpoint ?? {next:0,result:{imported:0,updated:0,failed:job.data.rejected.length,skipped:job.data.duplicates,errors:[...job.data.rejected]}}
  const result=checkpoint.result
  await job.updateProgress({processed:checkpoint.next,total:entries.length})
  for(let i=checkpoint.next;i<entries.length;i++) {
    const entry=entries[i]!
    let accountId:string|undefined
    let syncStarted=false
    try {
      const pending=await createPendingAccount(entry.fingerprint,entry.ciphertext,groupName)
      accountId=pending.id
      const cookie=decryptSecret(entry.ciphertext), session=await client.session(cookie)
      const user=(session as {user:{id:string;name?:string;email?:string}}).user
      if(!user || typeof user.id!=='string')throw new CommandCodeError('INVALID_SESSION',401,true)
      const identity:AccountSnapshot['identity']={id:user.id,name:user.name??user.id,email:user.email??null}
      const attached=await attachIdentity(pending.id,identity,entry.fingerprint,entry.ciphertext,groupName)
      accountId=attached.account.id
      syncStarted=true
      await syncAccount(accountId!,session)
      if(attached.updated)result.updated++;else result.imported++
    } catch(error) {
      if(accountId && !syncStarted && !(error instanceof Error && error.message==='ACCOUNT_SYNC_LOCK_LOST'))await markSyncFailure(accountId,error,entry.fingerprint)
      result.failed++;result.errors.push({line:entry.line,message:syncErrorMessage(error)})
    }
    await job.updateData({...job.data,checkpoint:{next:i+1,result}})
    await job.updateProgress({processed:i+1,total:entries.length})
  }
  await publishUpdate({type:'accounts'})
  return result
}
export async function processRefresh(job:Job<{accountId:string;reason?:string}>,token?:string) {
  const redis=getRedis(),key=`ccm:refresh:dirty:${job.data.accountId}`, version=await redis.get(key)
  const backoff=await redis.pttl(`ccm:refresh:backoff:${job.data.accountId}`)
  if(backoff>0 && (job.attemptsMade>0 || job.data.reason!=='manual')) {
    await job.moveToDelayed(Date.now()+backoff,token)
    throw new DelayedError()
  }
  try {await syncAccount(job.data.accountId)}
  catch(error) {
    if(error instanceof CommandCodeError && error.credentialExpired)throw new UnrecoverableError(error.message)
    throw error
  }
  await redis.eval(`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end`,1,key,version??'')
}
export async function refreshCatalog() {
  const { syncOfficialCatalog } = await import('../server/lib/official-catalog')
  const official=await syncOfficialCatalog()
  const models=official.models.filter(model=>model.providerAvailable).map(model=>({id:model.id,name:model.name,metadata:{...model,supported_endpoints:model.supportedEndpoints.map(endpoint=>'/provider/v1/'+endpoint)}})),sql=getDb()
  if(!models.length)throw new Error('OFFICIAL_CATALOG_UNAVAILABLE')
  await sql.begin(async tx=> {
    for(const model of models)await tx`INSERT INTO model_catalog(model_id,name,metadata) VALUES(${model.id},${model.name},${sql.json(model.metadata as any)})
      ON CONFLICT(model_id) DO UPDATE SET name=EXCLUDED.name,metadata=EXCLUDED.metadata,updated_at=now()`
    await tx`DELETE FROM model_catalog WHERE model_id NOT IN ${sql(models.map(m=>m.id))}`
  })
  await getRedis().set('ccm:catalog:updatedAt',new Date().toISOString())
  await publishUpdate({type:'models'})
}
