import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execPath } from 'node:process'
import { Devin2ApiRuntimeManager, type Devin2ApiRuntimeAccount } from '../server/lib/devin2api/runtime'

const account: Devin2ApiRuntimeAccount = { id: 'account-1', baseUrl: null, model: 'cascade', proxy: null, maxConcurrency: 1 }
const managers: Devin2ApiRuntimeManager[] = []
async function fakeBinary() {
  const dir = await mkdtemp(join(tmpdir(), 'cpa-runtime-test-'))
  const path = join(dir, 'devin')
  await writeFile(path, `#!${execPath}\nconst http=require('http'),fs=require('fs');const i=process.argv.indexOf('-config');const p=process.argv[i+1];const c=JSON.parse(fs.readFileSync(p,'utf8'));const s=http.createServer((q,r)=>{if(q.url==='/healthz')return r.end('{"status":"ok"}');if(q.url==='/v1/models')return r.end('{"data":[{"id":"cascade"}]}');r.statusCode=404;r.end()});s.listen(Number(c.server.listen.split(':').pop()),'127.0.0.1');process.on('SIGTERM',()=>s.close(()=>process.exit(0)));`)
  await chmod(path, 0o755)
  return { dir, path }
}
afterEach(async () => { await Promise.all(managers.splice(0).map(manager => manager.close())) })
describe('embedded Devin runtime manager', () => {
  it('starts a private account runtime and reuses it', async () => {
    const binary = await fakeBinary(); const manager = new Devin2ApiRuntimeManager({ binaryPath: binary.path, startupTimeoutMs: 2000 }); managers.push(manager)
    const first = await manager.ensure(account, 'devin-session-token$one'); const second = await manager.ensure(account, 'devin-session-token$one')
    expect(first.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:/); expect(second).toEqual(first); expect(manager.count()).toBe(1)
    await rm(binary.dir, { recursive: true, force: true })
  })
  it('enforces account concurrency and releases the lease', async () => {
    const binary = await fakeBinary(); const manager = new Devin2ApiRuntimeManager({ binaryPath: binary.path, startupTimeoutMs: 2000 }); managers.push(manager)
    const lease = await manager.acquire(account, 'devin-session-token$one'); await expect(manager.acquire(account, 'devin-session-token$one')).rejects.toMatchObject({ statusCode: 429 }); lease.release(); const next = await manager.acquire(account, 'devin-session-token$one'); next.release()
    await rm(binary.dir, { recursive: true, force: true })
  })
  it('does not fall back to an external endpoint when binary is absent', async () => {
    const manager = new Devin2ApiRuntimeManager({ binaryPath: '/missing/devin-2api' }); managers.push(manager)
    await expect(manager.ensure(account, 'token')).rejects.toMatchObject({ statusCode: 503 })
  })
})
