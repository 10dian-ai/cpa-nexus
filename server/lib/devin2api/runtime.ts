import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Each runtime is private to CPAN and receives exactly one account's credentials. */
export interface Devin2ApiRuntimeAccount {
  id: string
  baseUrl: string | null
  model: string | null
  proxy: string | null
  maxConcurrency: number
}
export interface Devin2ApiRuntimeEndpoint { baseUrl: string; apiKey: string }
interface Runtime extends Devin2ApiRuntimeEndpoint {
  fingerprint: string; child: ChildProcess; directory: string; lastUsed: number
}
interface RuntimeOptions {
  binaryPath?: string
  startupTimeoutMs?: number
  idleTimeoutMs?: number
}
const failure = (message: string, statusCode = 503) => Object.assign(new Error(message), { statusCode })
// The Go runtime allocates a bounded semaphore at startup. Keep that internal
// allocation safe even when the platform-level account limit uses PostgreSQL's
// full INTEGER range; CPAN still enforces the configured account lease.
const EMBEDDED_RUNTIME_CONCURRENCY_CAP = 16_384
export const devin2ApiBinaryPath = () => process.env.DEVIN2API_BINARY?.trim() || '/usr/local/bin/devin-2api'
export async function isDevin2ApiBinaryAvailable(): Promise<boolean> {
  try { await access(devin2ApiBinaryPath(), constants.X_OK); return true } catch { return false }
}
async function freePort(): Promise<number> {
  const server = createServer()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export class Devin2ApiRuntimeManager {
  private readonly runtimes = new Map<string, Runtime>()
  private readonly pending = new Map<string, Promise<Runtime>>()
  private readonly inflight = new Map<string, number>()
  private readonly revisions = new Map<string, number>()
  private readonly binaryPath: string
  private readonly startupTimeoutMs: number
  private readonly idleTimeoutMs: number
  private readonly sweep: ReturnType<typeof setInterval>
  private closed = false

  constructor(options: RuntimeOptions = {}) {
    this.binaryPath = options.binaryPath || devin2ApiBinaryPath()
    this.startupTimeoutMs = options.startupTimeoutMs || 15_000
    this.idleTimeoutMs = options.idleTimeoutMs || 15 * 60_000
    this.sweep = setInterval(() => {
      for (const [id, runtime] of this.runtimes) {
        if (!this.load(id) && Date.now() - runtime.lastUsed > this.idleTimeoutMs) void this.invalidate(id)
      }
    }, 60_000)
    this.sweep.unref()
  }

  load(id: string) { return this.inflight.get(id) || 0 }
  count() { return this.runtimes.size }

  async ensure(account: Devin2ApiRuntimeAccount, token: string): Promise<Devin2ApiRuntimeEndpoint> {
    if (this.closed) throw failure('Devin 内置运行时正在关闭')
    if (!token.trim()) throw failure('Devin 账号缺少令牌，请在账号设置中添加凭证')
    if (!Number.isSafeInteger(account.maxConcurrency) || account.maxConcurrency < 1) throw failure('Devin 账号并发配置无效')
    const fingerprint = createHash('sha256').update(JSON.stringify([token, account.baseUrl, account.model, account.proxy, account.maxConcurrency])).digest('hex')
    // Serialize startup/replacement for an account. Different accounts can start concurrently.
    const existingPending = this.pending.get(account.id)
    if (existingPending) { await existingPending.catch(() => undefined); return this.ensure(account, token) }
    const existing = this.runtimes.get(account.id)
    if (existing && existing.fingerprint === fingerprint && existing.child.exitCode === null && !existing.child.killed) {
      existing.lastUsed = Date.now()
      return { baseUrl: existing.baseUrl, apiKey: existing.apiKey }
    }
    const revision = this.revisions.get(account.id) || 0
    const start = (async () => {
      if (existing) { this.runtimes.delete(account.id); await this.stop(existing) }
      const runtime = await this.start(account, token, fingerprint)
      if (this.closed || revision !== (this.revisions.get(account.id) || 0)) {
        await this.stop(runtime)
        throw failure('Devin 账号配置已变更，请重试')
      }
      this.runtimes.set(account.id, runtime)
      runtime.child.once('exit', () => {
        if (this.runtimes.get(account.id) === runtime) this.runtimes.delete(account.id)
        void rm(runtime.directory, { recursive: true, force: true })
      })
      return runtime
    })()
    this.pending.set(account.id, start)
    try {
      const runtime = await start
      return { baseUrl: runtime.baseUrl, apiKey: runtime.apiKey }
    } finally { if (this.pending.get(account.id) === start) this.pending.delete(account.id) }
  }

  /** A lease is held until the full response stream closes, not just until headers arrive. */
  async acquire(account: Devin2ApiRuntimeAccount, token: string): Promise<Devin2ApiRuntimeEndpoint & { release(): void }> {
    if (this.load(account.id) >= account.maxConcurrency) throw failure('Devin 账号并发已满，请稍后重试', 429)
    this.inflight.set(account.id, this.load(account.id) + 1)
    let released = false
    const release = () => {
      if (released) return
      released = true
      const count = this.load(account.id) - 1
      if (count > 0) this.inflight.set(account.id, count)
      else this.inflight.delete(account.id)
      const runtime = this.runtimes.get(account.id)
      if (runtime) runtime.lastUsed = Date.now()
    }
    try { return { ...await this.ensure(account, token), release } } catch (error) { release(); throw error }
  }

  async invalidate(id: string): Promise<void> {
    this.revisions.set(id, (this.revisions.get(id) || 0) + 1)
    const runtime = this.runtimes.get(id)
    this.runtimes.delete(id)
    if (runtime) await this.stop(runtime)
  }
  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.sweep)
    await Promise.allSettled([...this.pending.values()])
    await Promise.all([...this.runtimes.keys()].map(id => this.invalidate(id)))
  }
  killOnExit() {
    for (const runtime of this.runtimes.values()) runtime.child.kill('SIGTERM')
  }

  private async start(account: Devin2ApiRuntimeAccount, token: string, fingerprint: string): Promise<Runtime> {
    try { await access(this.binaryPath, constants.X_OK) } catch { throw failure('Devin 内置运行时未安装，请重新构建 CPAN 镜像') }
    const directory = await mkdtemp(join(tmpdir(), 'cpa-nexus-devin-'))
    let runtime: Runtime | undefined
    try {
      const port = await freePort()
      const apiKey = randomBytes(32).toString('base64url')
      const baseUrl = `http://127.0.0.1:${port}`
      const runtimeConcurrency = Math.min(account.maxConcurrency, EMBEDDED_RUNTIME_CONCURRENCY_CAP)
      // JSON is a YAML subset. Encoding also prevents config injection via account values.
      const config = {
        server: { listen: `127.0.0.1:${port}`, max_concurrency: runtimeConcurrency },
        devin: { base_url: account.baseUrl || 'https://server.codeium.com', accounts: [{ name: account.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32) || 'account', token }], model: account.model || 'glm-5-2', proxy: account.proxy || '', force_http1: true },
        // The bundled runtime deliberately keeps its HTTP listener on loopback.
        // Its deprecated auth.api_key config is rejected by the current runtime;
        // CPAN's per-process loopback endpoint is the trust boundary.
        dashboard: { password: randomBytes(32).toString('base64url') }, debug: { enabled: false },
      }
      const configPath = join(directory, 'config.json')
      const stateDirectory = join(directory, 'state')
      await mkdir(stateDirectory, { mode: 0o700 })
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 })
      const child = spawn(this.binaryPath, ['-config', configPath, '-state-dir', stateDirectory], {
        cwd: directory, stdio: 'ignore', windowsHide: true,
        // The runtime has its account credential in a private config, and does
        // not inherit database/admin/application secrets from CPAN's environment.
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|HOME|TMPDIR|SYSTEMROOT|SSL_CERT_FILE|SSL_CERT_DIR)$/.test(key))),
      })
      runtime = { child, directory, baseUrl, apiKey, fingerprint, lastUsed: Date.now() }
      let spawnError = false
      child.once('error', () => { spawnError = true })
      const deadline = Date.now() + this.startupTimeoutMs
      while (Date.now() < deadline) {
        if (spawnError || child.exitCode !== null || child.signalCode !== null) throw failure('Devin 内置运行时启动失败，请检查账号上游配置')
        try {
          const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(500) })
          if (response.ok) return runtime
        } catch { /* Wait for the child to bind its loopback port. */ }
        await delay(50)
      }
      throw failure('Devin 内置运行时启动超时')
    } catch (error) {
      if (runtime) await this.stop(runtime)
      else await rm(directory, { recursive: true, force: true })
      throw error
    }
  }
  private async stop(runtime: Runtime): Promise<void> {
    if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { runtime.child.kill('SIGKILL'); resolve() }, 1500)
        timer.unref()
        runtime.child.once('exit', () => { clearTimeout(timer); resolve() })
        runtime.child.kill('SIGTERM')
      })
    }
    await rm(runtime.directory, { recursive: true, force: true })
  }
}

let manager: Devin2ApiRuntimeManager | undefined
function getManager() { return manager ??= new Devin2ApiRuntimeManager() }
process.once('exit', () => manager?.killOnExit())
export const getDevin2ApiRuntimeLoad = (id: string) => manager?.load(id) || 0
export const getDevin2ApiRuntimeCount = () => manager?.count() || 0
export const invalidateDevin2ApiRuntime = (id: string) => manager?.invalidate(id) || Promise.resolve()
export async function closeDevin2ApiRuntimes() { await manager?.close(); manager = undefined }
async function accountToken(id: string) {
  const { decryptDevin2ApiAccountToken } = await import('./accounts')
  return await decryptDevin2ApiAccountToken(id) || ''
}
export async function getDevin2ApiRuntime(account: Devin2ApiRuntimeAccount) { return getManager().ensure(account, await accountToken(account.id)) }
export async function acquireDevin2ApiRuntimeLease(account: Devin2ApiRuntimeAccount) { return getManager().acquire(account, await accountToken(account.id)) }
