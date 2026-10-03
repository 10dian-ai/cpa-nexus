import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import vm from 'node:vm'
import { describe,it,expect,vi } from 'vitest'

type Scenario = 'success' | 'creation-response-lost' | 'creation-unconfirmed' | 'delete-failed'
async function runProbe(script: string,scenario:Scenario){
  // Execute the actual script with entirely fake I/O; never read a real Cookie or contact upstream.
  const source=readFileSync(resolve('scripts',script),'utf8').replace(/^import .*;\r?\n/gm,'')
  let name=''
  let keys=[{id:'unrelated-id',name:'unrelated-user-key'}]
  const deleted:string[]=[]
  const files=new Map<string,string>()
  const fakeProcess={env:{COMMANDCODE_TEST_COOKIE:'fixture-cookie-only'},exitCode:0,execPath:'fixture-node'}
  const fetcher=vi.fn(async(url:string,options?:RequestInit)=>{
    const path=new URL(url).pathname
    if(path==='/auth/get-session')return Response.json({user:{id:'fixture-user'},session:{id:'fixture-session'}})
    if(path==='/provider/v1/models')return Response.json({data:[]})
    if(path==='/internal/billing/credits')return Response.json({credits:{monthlyCredits:1},windowLimits:null})
    if(path==='/internal/usage/summary')return Response.json({totalCost:0})
    if(path==='/internal/api-keys/create'){
      name=JSON.parse(String(options?.body)).name
      if(scenario!=='creation-unconfirmed')keys.push({id:'temporary-id',name})
      if(scenario==='creation-response-lost'||scenario==='creation-unconfirmed')throw new Error('fixture creation response lost')
      return Response.json({apiKey:'fixture-api-key-only'})
    }
    if(path==='/internal/api-keys/list')return Response.json(keys)
    if(path==='/internal/api-keys/delete'){
      const id=JSON.parse(String(options?.body)).apiKeyId
      deleted.push(id)
      if(scenario==='delete-failed')return Response.json({error:'fixture delete failure'},{status:500})
      keys=keys.filter(key=>key.id!==id)
      return Response.json({success:true})
    }
    if(url==='http://127.0.0.1:13059/health')return new Response('OK')
    throw new Error('Unexpected network request blocked: '+path)
  })
  const spawn=vi.fn(()=>{
    const child=new EventEmitter() as EventEmitter & {stdout:EventEmitter;stderr:EventEmitter;exitCode:number|null;signalCode:string|null;kill:(signal:string)=>void}
    child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.exitCode=null;child.signalCode=null
    child.kill=(signal:string)=>{child.signalCode=signal;child.exitCode=0;queueMicrotask(()=>child.emit('exit',0))}
    queueMicrotask(()=>child.stdout.emit('data',Buffer.from('CC Proxy started')))
    return child
  })
  const context=vm.createContext({
    mkdir:async()=>{},writeFile:async(path:string,data:string)=>{files.set(path,data)},
    resolve,randomUUID,spawn,process:fakeProcess,fetch:fetcher,AbortSignal,setTimeout,clearTimeout,
    console:{log:()=>{}},
  })
  await vm.runInContext('(async()=>{'+source+'})()',context)
  const report=JSON.parse([...files].find(([path])=>path.endsWith('.json'))![1])
  return {report,deleted,keys,name,exitCode:fakeProcess.exitCode}
}

describe.each(['probe-official-models.mjs','probe-kernel-models.mjs'])('%s temporary key cleanup',script=>{
  it('finds and revokes only its exact-name key after the creation response was lost',async()=>{
    const result=await runProbe(script,'creation-response-lost')
    expect(result.deleted).toEqual(['temporary-id'])
    expect(result.keys).toEqual([{id:'unrelated-id',name:'unrelated-user-key'}])
    expect(result.report.temporaryKey).toMatchObject({name:result.name,creationAttempted:true,creationStatus:'confirmed',created:true,revoked:true})
    expect(result.report.runError).toContain('response lost')
    expect(result.exitCode).toBe(1)
  })
  it('reports confirmed creation and revocation on a successful run',async()=>{
    const result=await runProbe(script,'success')
    expect(result.deleted).toEqual(['temporary-id'])
    expect(result.keys).toHaveLength(1)
    expect(result.report.temporaryKey).toMatchObject({name:result.name,created:true,revoked:true})
    expect(result.report.cleanupError).toBeUndefined()
    expect(result.exitCode).toBe(0)
  })
  it('does not claim revocation when an uncertain creation has no visible exact-name match',async()=>{
    const result=await runProbe(script,'creation-unconfirmed')
    expect(result.deleted).toEqual([])
    expect(result.report.temporaryKey).toMatchObject({name:result.name,creationStatus:'unknown',created:false,revoked:false})
    expect(result.report.cleanupError).toContain('unknown')
    expect(result.exitCode).toBe(1)
  })
  it('exits unsuccessfully when temporary key deletion cannot be confirmed',async()=>{
    const result=await runProbe(script,'delete-failed')
    expect(result.report.temporaryKey.revoked).toBe(false)
    expect(result.report.cleanupError).toContain('not confirmed')
    expect(result.exitCode).toBe(1)
  })
})
