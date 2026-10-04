import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { createApp, defineEventHandler, toNodeListener } from 'h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ bindings: new Map<string, { groupIds: string[]; groupNames: string[] }>() }))
vi.mock('../server/lib/db', () => ({ getDb: () => {
  const sql: any = async () => []; sql.begin = async (callback: any) => callback(sql); return sql
} }))
vi.mock('../server/lib/groups', () => ({
  ensureAccountGroups: async () => {}, accountGroupBindings: async () => fixture.bindings,
  resolveEnabledKeyGroupIds: async (id: string) => id === 'key-a' ? ['A'] : id === 'key-b' ? ['B'] : ['A', 'B'],
}))
vi.mock('../server/lib/auth', () => ({ authenticateGatewayKey: async (secret: string) => {
  const id = { ccm_local_a: 'key-a', ccm_local_b: 'key-b', ccm_local_both: 'key-both' }[secret as 'ccm_local_a']
  return id ? { id, name: id, moduleId: 'auto' } : null
} }))
vi.mock('../server/lib/modules', () => ({ requireModule: async () => {}, isModuleEnabled: async (id: string) => id === 'cpa' }))
vi.mock('../server/lib/presets', () => ({ resolveKeyPresetStack: async () => [] }))
vi.mock('../server/lib/settings', () => ({ getSettings: async () => ({ maxRequestBodyMb: 0 }) }))
vi.mock('../server/lib/commandcode-compat', () => ({ handleCommandcodeCompatibility: async () => { throw Error('Unexpected CommandCode path') } }))
vi.mock('../server/lib/gateway/accounts', () => ({ listCandidates: async () => [], listGatewayModels: async () => ({ data: [] }) }))
vi.mock('../server/lib/official-catalog', () => ({ getProviderModel: async () => null }))

import { createCpaClient } from '../server/lib/cpa/client'
import { readCpaConfigGroupSources } from '../server/lib/cpa/preset-config-routing'
import { resetCpaGroupRouting } from '../server/lib/cpa/group-routing'
import { handleNexusInference } from '../server/lib/cpa/inference'

// Uses the actual public handler and unmodified pinned CPA binary, with only identity storage
// replaced by a local ledger. Every provider call goes to these isolated mock listeners.
const binary = process.env.TEST_CPA_BINARY
describe.skipIf(!binary)('real CPA groups through the public model-key endpoint', () => {
  let core: ChildProcess | undefined, directory = '', cpaUrl = '', appUrl = '', output = ''
  const servers: Server[] = [], calls: { source: string; model: string; authorization: string }[] = []
  const failed = new Set<string>()
  const random = (name: string) => name + randomBytes(16).toString('hex')
  const managementKey = random('local-management-'), clientKey = random('local-client-')
  const upstreamKeys = { A: random('local-upstream-a-'), B: random('local-upstream-b-') }
  const client = () => createCpaClient({ baseUrl: cpaUrl, managementKey })
  async function listen(server: Server) {
    servers.push(server)
    await new Promise<void>(finish => server.listen(0, '127.0.0.1', finish))
    return 'http://127.0.0.1:' + (server.address() as AddressInfo).port
  }
  const post = (key: string, model = 'shared-model') => fetch(appUrl + '/v1/chat/completions', { method: 'POST',
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'local test only' }] }), signal: AbortSignal.timeout(8000) })

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nexus-cpa-groups-'))
    await mkdir(join(directory, 'auth')); await mkdir(join(directory, 'plugins')); await mkdir(join(directory, 'cache'))
    const providers: Record<string, unknown>[] = []
    for (const source of ['A', 'B'] as const) {
      const url = await listen(createServer(async (request, response) => {
        let raw = ''; for await (const chunk of request) raw += chunk
        const body = JSON.parse(raw || '{}')
        calls.push({ source, model: body.model, authorization: String(request.headers.authorization || '') })
        response.setHeader('content-type', 'application/json')
        if (failed.has(source)) { response.statusCode = 503; response.end('{"error":{"message":"isolated account failure"}}'); return }
        response.end(JSON.stringify({ id: 'local-' + source, object: 'chat.completion', created: 1, model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: source }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
      }))
      providers.push({ name: 'local-' + source, prefix: 'source-' + source.toLowerCase(), 'base-url': url + '/v1',
        models: [{ name: 'gpt-local', alias: 'shared-model' }], keys: [{ 'api-key': upstreamKeys[source] }], 'request-retry': 1 })
    }
    const reservation = createServer()
    await new Promise<void>(finish => reservation.listen(0, '127.0.0.1', finish))
    const port = (reservation.address() as AddressInfo).port
    await new Promise<void>(finish => reservation.close(() => finish()))
    cpaUrl = 'http://127.0.0.1:' + port
    const config = { 'config-version': 8, server: { host: '127.0.0.1', port, discovery: { enabled: false } },
      management: { 'secret-key': managementKey, 'allow-remote': false, 'disable-control-panel': true, 'disable-auto-update-panel': true },
      access: { 'api-keys': [clientKey] }, oauth: { 'auth-dir': join(directory, 'auth') },
      plugins: { enabled: false, dir: join(directory, 'plugins'), configs: {} },
      routing: { 'force-model-prefix': false, retry: { 'request-retry': 1 }, cooldown: { 'disable-cooling': true } },
      observability: { logs: { 'logging-to-file': false } }, 'api-keys': { 'openai-compatibility': providers } }
    const configPath = join(directory, 'config.yaml'); await writeFile(configPath, JSON.stringify(config))
    core = spawn(resolve(binary!), ['-config', configPath, '-local-model'], { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MANAGEMENT_PASSWORD: '', LOCALAPPDATA: join(directory, 'cache'), XDG_CACHE_HOME: join(directory, 'cache') } })
    for (const stream of [core.stdout, core.stderr]) stream?.on('data', chunk => { output = (output + String(chunk)).slice(-4096) })
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (core.exitCode !== null) throw Error('Local CPA exited: ' + output)
      try { if ((await client().request({ path: 'config/api-keys' })).status === 200) break } catch { /* Startup. */ }
      await new Promise<void>(finish => setTimeout(finish, 100))
    }
    const sources = await readCpaConfigGroupSources(client())
    for (const source of sources) fixture.bindings.set(source.accountId, { groupIds: [source.name.slice(-1)], groupNames: [source.name.slice(-1)] })
    vi.stubEnv('CPA_URL', cpaUrl); vi.stubEnv('CPA_CLIENT_KEY', clientKey); vi.stubEnv('CPA_MANAGEMENT_KEY', managementKey)
    resetCpaGroupRouting()
    const h3 = createApp(); h3.use(defineEventHandler(handleNexusInference)); appUrl = await listen(createServer(toNodeListener(h3)))
  }, 25_000)
  afterAll(async () => {
    vi.unstubAllEnvs(); resetCpaGroupRouting(); fixture.bindings.clear()
    if (core && core.exitCode === null) {
      const stopped = new Promise<void>(finish => core!.once('exit', () => finish())); core.kill('SIGTERM')
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([stopped, new Promise<void>(finish => { timer = setTimeout(finish, 2000) })]); if (timer) clearTimeout(timer)
      if (core.exitCode === null) { core.kill('SIGKILL'); await stopped }
    }
    for (const server of servers) await new Promise<void>(finish => { server.close(() => finish()); server.closeAllConnections() })
    if (directory) {
      const target = resolve(directory)
      if (!target.startsWith(resolve(tmpdir()) + sep) || !/^nexus-cpa-groups-/.test(basename(target))) throw Error('Unexpected test cleanup path')
      await rm(target, { recursive: true, force: true })
    }
  })
  it('routes identical bare model IDs to the two separately grouped real upstreams', async () => {
    for (const [key, source] of [['ccm_local_a', 'A'], ['ccm_local_b', 'B']] as const) {
      const response = await post(key)
      expect(response.status, await response.clone().text()).toBe(200)
      expect((await response.json()).choices[0].message.content).toBe(source)
      expect(calls.at(-1)).toEqual({ source, model: 'gpt-local', authorization: 'Bearer ' + upstreamKeys[source] })
      const catalog = await fetch(appUrl + '/v1/models', { headers: { authorization: 'Bearer ' + key } })
      expect((await catalog.json()).data.map((model: { id: string }) => model.id)).toEqual(['shared-model'])
    }
  })
  it('rejects a foreign source prefix before invoking a provider and combines allowed groups only', async () => {
    const before = calls.length
    const forbidden = await post('ccm_local_a', 'source-b/shared-model')
    expect(forbidden.status).toBe(404); await forbidden.text(); expect(calls).toHaveLength(before)
    const a = await post('ccm_local_both'), b = await post('ccm_local_both')
    expect(a.status).toBe(200); expect(b.status).toBe(200)
    const origins = new Set([(await a.json()).choices[0].message.content, (await b.json()).choices[0].message.content])
    expect(origins).toEqual(new Set(['A', 'B']))
  })
  it('keeps native keys working and refuses cross-group retries when the selected real account fails', async () => {
    const native = await post(clientKey); expect(native.status).toBe(200); await native.text()
    const before = calls.length; failed.add('A')
    try {
      const unavailable = await post('ccm_local_a'); expect(unavailable.ok).toBe(false); await unavailable.text()
      expect(calls.slice(before).length).toBeGreaterThan(0)
      expect(calls.slice(before).every(call => call.source === 'A')).toBe(true)
    } finally { failed.delete('A') }
    const healthy = await post('ccm_local_b'); expect(healthy.status).toBe(200); await healthy.text(); expect(calls.at(-1)?.source).toBe('B')
  })
})
