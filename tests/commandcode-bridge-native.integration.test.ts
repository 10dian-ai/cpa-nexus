import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({ models: [{ id: 'claude-sonnet-4-6', supported_endpoints: ['/provider/v1/messages'] }] as { id: string; supported_endpoints: string[] }[],
  bridgeSecret: 'ccm_nexus_local-only-bridge-test-secret', keyId: 'local-key-id' }))
vi.mock('../server/lib/modules', () => ({ requireModule: async () => {}, isModuleEnabled: async () => true }))
vi.mock('../server/lib/gateway/accounts', () => ({ listGatewayModels: async () => ({ data: fixture.models }) }))
vi.mock('../server/lib/crypto', () => ({ encryptSecret: (value: string) => value, decryptSecret: (value: string) => value, hashGatewayKey: (value: string) => value }))
vi.mock('../server/lib/db', () => ({ getDb: () => {
  const sql: any = async (strings: TemplateStringsArray) => {
    const query = strings.join('')
    if (query.includes('pg_try_advisory_xact_lock')) return [{ acquired: true }]
    if (query.includes('SELECT') && query.includes('module_integrations')) return [{ connected_at: new Date(), key_id: fixture.keyId, credential_ciphertext: fixture.bridgeSecret }]
    if (query.includes('SELECT') && query.includes('gateway_keys')) return [{ id: fixture.keyId }]
    return []
  }
  sql.begin = async (callback: any) => callback(sql)
  return sql
} }))
import { createCpaClient } from '../server/lib/cpa/client'
import { buildCommandcodeMessagesChannel, refreshCommandcodeBridge } from '../server/lib/commandcode-bridge'

const binary = process.env.TEST_CPA_BINARY
const policyKey = Buffer.alloc(32, 21).toString('base64')
describe.skipIf(!binary)('managed bridge membership on the unmodified CPA model registry', () => {
  let directory = '', child: ChildProcess | undefined, base = '', output = ''
  const managementKey = 'local-management-' + randomBytes(16).toString('hex')
  const clientKey = 'local-client-' + randomBytes(16).toString('hex')
  const client = () => createCpaClient({ baseUrl: base, managementKey })
  async function catalog() {
    const response = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer ' + clientKey }, signal: AbortSignal.timeout(1000) })
    expect(response.status).toBe(200)
    return ((await response.json()) as { data: { id: string }[] }).data.map(model => model.id).sort()
  }
  async function waitForModels(expected: string[]) {
    const deadline = Date.now() + 5000
    let actual: string[] = []
    do {
      actual = await catalog()
      if (JSON.stringify(actual) === JSON.stringify([...expected].sort())) return actual
      await new Promise<void>(finish => setTimeout(finish, 100))
    } while (Date.now() < deadline)
    expect(actual).toEqual([...expected].sort())
    return actual
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nexus-cpa-empty-bridge-'))
    for (const name of ['auth', 'plugins', 'cache']) await mkdir(join(directory, name))
    const reservation = createServer()
    await new Promise<void>(finish => reservation.listen(0, '127.0.0.1', finish))
    const port = (reservation.address() as AddressInfo).port
    await new Promise<void>(finish => reservation.close(() => finish()))
    base = 'http://127.0.0.1:' + port
    const config = { 'config-version': 8, server: { host: '127.0.0.1', port, discovery: { enabled: false } },
      management: { 'secret-key': managementKey, 'disable-control-panel': true, 'disable-auto-update-panel': true }, access: { 'api-keys': [clientKey] },
      oauth: { 'auth-dir': join(directory, 'auth') }, plugins: { enabled: false, dir: join(directory, 'plugins'), configs: {} },
      observability: { logs: { 'logging-to-file': false } }, routing: { retry: { 'request-retry': 0 } },
      'api-keys': { claude: [buildCommandcodeMessagesChannel(fixture.bridgeSecret, fixture.models, 'http://127.0.0.1:1/v1')],
        'openai-compatibility': [{ name: 'unrelated-native', 'base-url': 'http://127.0.0.1:1/v1', models: [{ name: 'upstream-native', alias: 'native-other' }], keys: [{ 'api-key': 'local-native-only' }] }] } }
    const path = join(directory, 'config.yaml'); await writeFile(path, JSON.stringify(config))
    child = spawn(resolve(binary!), ['-config', path, '-local-model'], { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NEXUS_GROUP_POLICY_KEY: policyKey, MANAGEMENT_PASSWORD: '', LOCALAPPDATA: join(directory, 'cache'), XDG_CACHE_HOME: join(directory, 'cache') } })
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { output = (output + String(chunk)).slice(-4096) })
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw Error('Isolated CPA exited: ' + output)
      try { if ((await client().request({ path: 'config/api-keys' })).status === 200) break } catch { /* Start. */ }
      await new Promise<void>(finish => setTimeout(finish, 100))
    }
    vi.stubEnv('CPA_URL', base); vi.stubEnv('CPA_MANAGEMENT_KEY', managementKey); vi.stubEnv('CPA_CLIENT_KEY', clientKey)
    vi.stubEnv('NEXUS_GROUP_POLICY_KEY', policyKey)
    vi.stubEnv('CPA_COMMANDCODE_BASE_URL', 'http://127.0.0.1:1/v1')
  }, 25_000)
  afterAll(async () => {
    vi.unstubAllEnvs()
    if (child && child.exitCode === null) {
      const stopped = new Promise<void>(finish => child!.once('exit', () => finish())); child.kill('SIGTERM')
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([stopped, new Promise<void>(finish => { timer = setTimeout(finish, 2000) })]); if (timer) clearTimeout(timer)
      if (child.exitCode === null) { child.kill('SIGKILL'); await stopped }
    }
    if (directory) {
      const target = resolve(directory)
      if (!target.startsWith(resolve(tmpdir()) + sep) || !basename(target).startsWith('nexus-cpa-empty-bridge-')) throw Error('Unexpected cleanup path')
      await rm(target, { recursive: true, force: true })
    }
  })
  it('withdraws an empty Claude bridge from the actual catalog and restores it after permissions recover', async () => {
    await waitForModels(['native-other', 'commandcode/claude-sonnet-4-6'])
    fixture.models = []
    await refreshCommandcodeBridge()
    await waitForModels(['native-other'])
    const empty = JSON.parse(new TextDecoder().decode((await client().request({ path: 'config/api-keys/claude' })).body))
    expect(empty[0].name).toBe('nexus-commandcode-messages')
    expect(empty[0].models).toEqual([])
    expect(empty[0]['excluded-models']).toEqual(['*'])
    fixture.models = [{ id: 'claude-sonnet-4-6', supported_endpoints: ['/provider/v1/messages'] }]
    await refreshCommandcodeBridge()
    await waitForModels(['native-other', 'commandcode/claude-sonnet-4-6'])
    const restored = JSON.parse(new TextDecoder().decode((await client().request({ path: 'config/api-keys/claude' })).body))
    expect(restored[0]['excluded-models']).toEqual([])
  })
})
