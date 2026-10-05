import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface StoredGatewayKey { id: string; secret_hash: string; enabled: boolean }
interface StoredIntegration { key_id: string; credential_ciphertext: string; model_count: number; connected_at: Date | null; last_error: string | null }
const fixture = vi.hoisted(() => ({
  keys: new Map<string, StoredGatewayKey>(), integration: null as StoredIntegration | null,
  enabled: true, models: [] as { id: string; supported_endpoints: string[] }[], sqlCalls: [] as string[],
}))

vi.mock('../server/lib/config', () => ({ getConfig: () => ({ encryptionKey: Buffer.alloc(32, 9).toString('base64') }) }))
vi.mock('../server/lib/modules', async () => {
  const { createError } = await import('h3')
  return {
    isModuleEnabled: async () => fixture.enabled,
    requireModule: async () => { if (!fixture.enabled) throw createError({ statusCode: 503, message: 'Module disabled' }) },
  }
})
vi.mock('../server/lib/gateway/accounts', () => ({ listGatewayModels: async () => ({ object: 'list', data: fixture.models }) }))
vi.mock('../server/lib/db', () => {
  const locks = new Map<string, Promise<void>>()
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join('?').replace(/\s+/g, ' ').trim()
    fixture.sqlCalls.push(query)
    if (query.startsWith('SELECT pg_advisory')) return []
    if (query.startsWith('SELECT') && query.includes('module_integrations')) return fixture.integration ? [{ ...fixture.integration }] : []
    if (query.startsWith('SELECT id FROM gateway_keys')) {
      const key = fixture.keys.get(String(values[0]))
      return key && key.secret_hash === values[1] ? [{ id: key.id }] : []
    }
    if (query.startsWith('SELECT enabled,secret_hash FROM gateway_keys')) {
      const key = fixture.keys.get(String(values[0]))
      return key ? [{ enabled: key.enabled, secret_hash: key.secret_hash }] : []
    }
    if (query.startsWith('UPDATE gateway_keys')) {
      const key = fixture.keys.get(String(values[0]))
      if (key) key.enabled = true
      return []
    }
    if (query.startsWith('INSERT INTO gateway_keys')) {
      fixture.keys.set(String(values[0]), { id: String(values[0]), secret_hash: String(values[2]), enabled: true })
      return []
    }
    if (query.startsWith('INSERT INTO module_integrations')) {
      fixture.integration = { key_id: String(values[0]), credential_ciphertext: String(values[1]), model_count: 0, connected_at: null, last_error: null }
      return []
    }
    if (query.startsWith('UPDATE module_integrations SET last_error')) {
      if (fixture.integration) fixture.integration.last_error = 'CPA 拒绝渠道配置，原渠道未替换'
      return []
    }
    if (query.startsWith('UPDATE module_integrations SET model_count')) {
      if (fixture.integration) {
        fixture.integration.model_count = Number(values[0]); fixture.integration.connected_at = new Date(); fixture.integration.last_error = null
      }
      return []
    }
    throw new Error('Unexpected bridge fixture query: ' + query)
  }
  const begin = async (callback: (tx: typeof sql) => unknown) => {
    const releases: (() => void)[] = []
    const tx = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?').replace(/\s+/g, ' ').trim()
      const lock = query.match(/pg_(try_)?advisory_xact_lock\((\d+)\)/)
      if (lock) {
        const id = lock[2]!
        const alias = query.match(/\bAS (\w+)/i)?.[1] || 'locked'
        if (lock[1] && locks.has(id)) return [{ [alias]: false }]
        const previous = locks.get(id) || Promise.resolve()
        let release!: () => void
        const next = new Promise<void>(resolve => { release = resolve })
        locks.set(id, previous.then(() => next))
        await previous
        releases.push(() => { locks.delete(id); release() })
        return lock[1] ? [{ [alias]: true }] : []
      }
      return sql(strings, ...values)
    }
    try { return await callback(tx) } finally { for (const release of releases) release() }
  }
  return { getDb: () => Object.assign(sql, { begin }) }
})

import { connectCommandcodeBridge, getCommandcodeBridge, refreshCommandcodeBridge, COMMANDCODE_CHANNEL, COMMANDCODE_MESSAGES_CHANNEL, splitCommandcodeModels } from '../server/lib/commandcode-bridge'
import { decryptSecret } from '../server/lib/crypto'

describe('CommandCode bridge against a real CPA management HTTP service', () => {
  let server: Server | undefined
  let groups: Record<string, any>[]
  let claudeGroups: Record<string, any>[]
  let rejectUpdate: boolean
  let malformedGroups: boolean
  let statusCode: number
  let updates: unknown[]
  let requests: string[]
  let pauseNextRead: ((snapshot: Record<string, any>[]) => Promise<void>) | undefined

  beforeEach(async () => {
    fixture.keys.clear(); fixture.integration = null; fixture.enabled = true; fixture.sqlCalls.length = 0
    fixture.models = [
      { id: 'gpt-test', supported_endpoints: ['/v1/chat/completions', '/v1/responses'] },
      { id: 'claude-test', supported_endpoints: ['/v1/messages'] },
      { id: 'typesafe/jev', supported_endpoints: ['/v1/systemone'] },
      { id: 'website-only', supported_endpoints: [] },
    ]
    groups = [{ name: 'existing-provider', 'base-url': 'https://native.example/v1', keys: [{ 'api-key': 'existing-native-key', headers: { 'X-Team': 'keep' } }], models: [{ name: 'native', alias: 'native' }] }]
    claudeGroups = [{ name: 'existing-claude', 'base-url': 'https://native.example', keys: [{ 'api-key': 'existing-claude-key' }], models: [{ name: 'native-claude', alias: 'native-claude' }] }]
    rejectUpdate = false; malformedGroups = false; statusCode = 200; updates = []; requests = []; pauseNextRead = undefined
    server = createServer(async (request, response) => {
      requests.push(request.method + ' ' + request.url)
      expect(request.headers.authorization).toBe('Bearer management-secret-for-tests')
      response.setHeader('content-type', 'application/json')
      response.setHeader('X-CPA-VERSION', 'v8.0.15')
      if (request.url === '/v8/management/config') {
        response.statusCode = statusCode
        response.end(statusCode === 200 ? '{"config-version":8}' : '{"error":"invalid management key"}')
        return
      }
      if (request.url === '/v8/management/config/api-keys/openai-compatibility' && request.method === 'GET') {
        const snapshot = structuredClone(groups)
        if (pauseNextRead) { const pause = pauseNextRead; pauseNextRead = undefined; await pause(snapshot) }
        response.end(JSON.stringify(malformedGroups ? { error: 'broken catalog' } : snapshot))
        return
      }
      if (request.url === '/v8/management/config/api-keys/claude' && request.method === 'GET') {
        response.end(JSON.stringify(malformedGroups ? { error: 'broken catalog' } : claudeGroups))
        return
      }
      if (request.url === '/v8/management/config/api-keys' && request.method === 'PATCH') {
        let text = ''
        for await (const chunk of request) text += chunk
        const next = JSON.parse(text)
        updates.push(next)
        if (rejectUpdate) { response.statusCode = 422; response.end('{"error":"invalid_config"}'); return }
        groups = next['openai-compatibility']
        claudeGroups = next.claude
        response.end('{"status":"ok","config-version":8}')
        return
      }
      response.statusCode = 404; response.end('{"error":"not_found"}')
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    vi.stubEnv('CPA_URL', `http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    vi.stubEnv('CPA_MANAGEMENT_KEY', 'management-secret-for-tests')
    vi.stubEnv('CPA_COMMANDCODE_BASE_URL', 'http://app:3000/v1')
  })

  afterEach(async () => {
    if (server) await new Promise<void>(resolve => { server!.close(() => resolve()); server!.closeAllConnections() })
    vi.unstubAllEnvs()
  })

  it('registers actual catalog models through an encrypted internal key while preserving unrelated native channels', async () => {
    const previous = structuredClone(groups[0])
    const previousClaude = structuredClone(claudeGroups[0])
    const result = await connectCommandcodeBridge()
    expect(result).toMatchObject({ connected: true, models: 2 })
    expect(groups[0]).toEqual(previous)
    expect(claudeGroups[0]).toEqual(previousClaude)
    const channel = groups.find(group => group.name === COMMANDCODE_CHANNEL)!
    expect(channel['base-url']).toBe('http://app:3000/v1')
    expect(channel['request-retry']).toBe(0)
    expect(channel.models).toEqual([{ name: 'gpt-test', alias: 'commandcode/gpt-test' }])
    const messages = claudeGroups.find(group => group.name === COMMANDCODE_MESSAGES_CHANNEL)!
    expect(messages['base-url']).toBe('http://app:3000')
    expect(messages['request-retry']).toBe(0)
    expect(messages.models).toEqual([{ name: 'claude-test', alias: 'commandcode/claude-test' }])
    const key = String(channel.keys[0]['api-key'])
    expect(key).toMatch(/^ccm_nexus_[A-Za-z0-9_-]{43}$/)
    expect(messages.keys).toEqual([{ 'api-key': key, cloak: { mode: 'never' } }])
    expect(requests.filter(request => request.startsWith('PATCH '))).toEqual(['PATCH /v8/management/config/api-keys'])
    expect(requests.some(request => request.startsWith('PUT '))).toBe(false)
    expect(fixture.integration?.credential_ciphertext).not.toContain(key)
    expect(decryptSecret(fixture.integration!.credential_ciphertext)).toBe(key)
    expect(fixture.keys.get(fixture.integration!.key_id)?.secret_hash).toBe(createHash('sha256').update(key).digest('hex'))
    expect(JSON.stringify(result)).not.toContain(key)
    expect(await getCommandcodeBridge()).toMatchObject({ configured: true, connected: true, modelCount: 2, error: null })
  })

  it('reuses its private credential and replaces only its own channel on reconnect', async () => {
    await connectCommandcodeBridge()
    const key = groups.find(group => group.name === COMMANDCODE_CHANNEL)!.keys[0]['api-key']
    fixture.models = [{ id: 'new-model', supported_endpoints: ['/v1/chat/completions'] }]
    await connectCommandcodeBridge()
    expect(fixture.keys.size).toBe(1)
    expect(groups.filter(group => group.name === COMMANDCODE_CHANNEL)).toHaveLength(1)
    expect(groups.find(group => group.name === COMMANDCODE_CHANNEL)!.keys[0]['api-key']).toBe(key)
    expect(groups.find(group => group.name === COMMANDCODE_CHANNEL)!.models).toEqual([{ name: 'new-model', alias: 'commandcode/new-model' }])
    expect(claudeGroups.some(group => group.name === COMMANDCODE_MESSAGES_CHANNEL)).toBe(false)
  })

  it('leaves all original CPA channels intact when CPA rejects registration and can retry with the same private credential', async () => {
    const original = structuredClone(groups)
    const originalClaude = structuredClone(claudeGroups)
    rejectUpdate = true
    await expect(connectCommandcodeBridge()).rejects.toMatchObject({ statusCode: 502 })
    expect(groups).toEqual(original)
    expect(claudeGroups).toEqual(originalClaude)
    expect(fixture.integration?.connected_at).toBeNull()
    expect(fixture.integration?.last_error).not.toBeNull()
    expect(fixture.keys.size).toBe(1)
    const keyId = fixture.integration!.key_id
    rejectUpdate = false
    await connectCommandcodeBridge()
    expect(fixture.integration!.key_id).toBe(keyId)
    expect(fixture.integration!.last_error).toBeNull()
  })

  it('does not issue a private credential or write config on CPA auth failure, invalid catalog, or disabled module', async () => {
    statusCode = 401
    await expect(connectCommandcodeBridge()).rejects.toMatchObject({ statusCode: 503 })
    expect(fixture.keys.size).toBe(0)
    statusCode = 200; malformedGroups = true
    await expect(connectCommandcodeBridge()).rejects.toMatchObject({ statusCode: 502 })
    expect(fixture.keys.size).toBe(0)
    malformedGroups = false; fixture.enabled = false
    const count = requests.length
    await expect(connectCommandcodeBridge()).rejects.toMatchObject({ statusCode: 503 })
    expect(requests).toHaveLength(count)
    expect(updates).toHaveLength(0)
  })

  it('never silently creates or recreates a channel during worker maintenance', async () => {
    await refreshCommandcodeBridge()
    expect(requests).toHaveLength(0)
    await connectCommandcodeBridge()
    groups = groups.filter(group => group.name !== COMMANDCODE_CHANNEL)
    claudeGroups = claudeGroups.filter(group => group.name !== COMMANDCODE_MESSAGES_CHANNEL)
    const count = updates.length
    fixture.models = [{ id: 'new-model', supported_endpoints: ['/v1/chat/completions'] }]
    await refreshCommandcodeBridge()
    expect(updates).toHaveLength(count)
    expect(groups.some(group => group.name === COMMANDCODE_CHANNEL)).toBe(false)
  })

  it.each(['chat', 'messages'])('does not recreate an explicitly removed %s group while maintaining the other group', async removed => {
    await connectCommandcodeBridge()
    const nativeChat = structuredClone(groups[0])
    const nativeMessages = structuredClone(claudeGroups[0])
    if (removed === 'chat') groups = groups.filter(group => group.name !== COMMANDCODE_CHANNEL)
    else claudeGroups = claudeGroups.filter(group => group.name !== COMMANDCODE_MESSAGES_CHANNEL)
    await refreshCommandcodeBridge()
    expect(groups.some(group => group.name === COMMANDCODE_CHANNEL)).toBe(removed !== 'chat')
    expect(claudeGroups.some(group => group.name === COMMANDCODE_MESSAGES_CHANNEL)).toBe(removed !== 'messages')
    expect(groups[0]).toEqual(nativeChat)
    expect(claudeGroups[0]).toEqual(nativeMessages)
    expect(await getCommandcodeBridge()).toMatchObject({ connected: false })
    await connectCommandcodeBridge()
    expect(await getCommandcodeBridge()).toMatchObject({ connected: true, modelCount: 2 })
    expect(fixture.keys.size).toBe(1)
  })

  it('requires a model with a CPA-supported native format before issuing an internal credential', async () => {
    fixture.models = [
      { id: 'typesafe/jev', supported_endpoints: ['/v1/systemone'] },
      { id: 'metadata-missing', supported_endpoints: [] },
    ]
    await expect(connectCommandcodeBridge()).rejects.toMatchObject({ statusCode: 409 })
    expect(fixture.keys.size).toBe(0)
    expect(updates).toHaveLength(0)
    expect(groups.some(group => group.name === COMMANDCODE_CHANNEL)).toBe(false)
    expect(claudeGroups.some(group => group.name === COMMANDCODE_MESSAGES_CHANNEL)).toBe(false)
  })

  it('updates the catalog only when model availability changes', async () => {
    await connectCommandcodeBridge()
    await refreshCommandcodeBridge()
    expect(updates).toHaveLength(1)
    fixture.models = [{ id: 'new-model', supported_endpoints: ['/v1/chat/completions'] }]
    await refreshCommandcodeBridge()
    expect(updates).toHaveLength(2)
    expect(groups.find(group => group.name === COMMANDCODE_CHANNEL)!.models).toEqual([{ name: 'new-model', alias: 'commandcode/new-model' }])
  })
  it('clears disappeared official models and restores them after a later refresh while keeping native channels intact', async () => {
    await connectCommandcodeBridge()
    const nativeChat = structuredClone(groups[0]), nativeMessages = structuredClone(claudeGroups[0])
    fixture.models = []
    await refreshCommandcodeBridge()
    expect(groups.find(group => group.name === COMMANDCODE_CHANNEL)?.models).toEqual([])
    expect(claudeGroups.find(group => group.name === COMMANDCODE_MESSAGES_CHANNEL)?.models).toEqual([])
    expect(claudeGroups.find(group => group.name === COMMANDCODE_MESSAGES_CHANNEL)?.['excluded-models']).toEqual(['*'])
    expect(fixture.integration?.model_count).toBe(0)
    expect(groups[0]).toEqual(nativeChat)
    expect(claudeGroups[0]).toEqual(nativeMessages)
    fixture.models = [{ id: 'restored-model', supported_endpoints: ['/v1/chat/completions'] }]
    await refreshCommandcodeBridge()
    expect(groups.find(group => group.name === COMMANDCODE_CHANNEL)?.models).toEqual([{ name: 'restored-model', alias: 'commandcode/restored-model' }])
    expect(fixture.integration?.model_count).toBe(1)
    fixture.models.push({ id: 'restored-claude', supported_endpoints: ['/v1/messages'] })
    await refreshCommandcodeBridge()
    expect(claudeGroups.find(group => group.name === COMMANDCODE_MESSAGES_CHANNEL)?.['excluded-models']).toEqual([])
    expect(claudeGroups.find(group => group.name === COMMANDCODE_MESSAGES_CHANNEL)?.models).toEqual([{ name: 'restored-claude', alias: 'commandcode/restored-claude' }])
  })

  it('does not write a live channel while the module is disabled', async () => {
    await connectCommandcodeBridge()
    fixture.enabled = false; fixture.models = [{ id: 'changed', supported_endpoints: ['/v1/chat/completions'] }]
    await refreshCommandcodeBridge()
    expect(updates).toHaveLength(1)
    expect(await getCommandcodeBridge()).toMatchObject({ connected: false, error: 'CommandCode 模块已停用' })
  })

  it('preserves a native channel added after its initial configuration read', async () => {
    let readStarted!: () => void, resumeRead!: () => void
    const started = new Promise<void>(resolve => { readStarted = resolve })
    const resume = new Promise<void>(resolve => { resumeRead = resolve })
    pauseNextRead = async () => { readStarted(); await resume }
    const connecting = connectCommandcodeBridge()
    await started
    const added = { name: 'concurrently-added-native', keys: [{ 'api-key': 'keep-new-native-key' }], models: [{ name: 'native-new' }] }
    groups.push(added)
    resumeRead()
    await connecting
    expect(groups.find(group => group.name === added.name)).toEqual(added)
    expect(groups.filter(group => group.name === COMMANDCODE_CHANNEL)).toHaveLength(1)
  })

  it('does not repeatedly reload CPA for an unchanged mixed-case model catalog', async () => {
    fixture.models = ['a', 'A', 'z'].map(id => ({ id, supported_endpoints: ['/v1/chat/completions'] }))
    await connectCommandcodeBridge()
    await refreshCommandcodeBridge()
    await refreshCommandcodeBridge()
    expect(updates).toHaveLength(1)
  })

  it('rejects a simultaneous registration while the first one holds the integration lock', async () => {
    let readStarted!: () => void, resumeRead!: () => void
    const started = new Promise<void>(resolve => { readStarted = resolve })
    const resume = new Promise<void>(resolve => { resumeRead = resolve })
    pauseNextRead = async () => { readStarted(); await resume }
    const first = connectCommandcodeBridge()
    await started
    await expect(connectCommandcodeBridge()).rejects.toMatchObject({ statusCode: 409 })
    expect(updates).toHaveLength(0)
    resumeRead()
    await first
    expect(updates).toHaveLength(1)
    expect(fixture.keys.size).toBe(1)
  })

  it.each([1, 2])('does not recreate a channel removed after maintenance read %s', async deleteAfterRead => {
    await connectCommandcodeBridge()
    fixture.models = [{ id: 'new-model', supported_endpoints: ['/v1/chat/completions'] }]
    let reads = 0
    const removeAfterRead = async () => {
      reads++
      if (reads === deleteAfterRead) {
        groups = groups.filter(group => group.name !== COMMANDCODE_CHANNEL)
        claudeGroups = claudeGroups.filter(group => group.name !== COMMANDCODE_MESSAGES_CHANNEL)
      }
      else pauseNextRead = removeAfterRead
    }
    pauseNextRead = removeAfterRead
    await refreshCommandcodeBridge()
    expect(updates).toHaveLength(1)
    expect(groups.some(group => group.name === COMMANDCODE_CHANNEL)).toBe(false)
  })

  it('reports a mismatched CPA credential as disconnected without changing unrelated channels', async () => {
    await connectCommandcodeBridge()
    const original = structuredClone(groups.find(group => group.name !== COMMANDCODE_CHANNEL))
    const channel = groups.find(group => group.name === COMMANDCODE_CHANNEL)!
    channel.keys = [{ 'api-key': 'different-invalid-bridge-key' }]
    const view = await getCommandcodeBridge()
    expect(view).toMatchObject({ configured: true, connected: false })
    expect(view.error).not.toBeNull()
    expect(groups.find(group => group.name !== COMMANDCODE_CHANNEL)).toEqual(original)
    expect(updates).toHaveLength(1)
  })

  it('selects native formats from exact official endpoint metadata instead of model name prefixes', () => {
    const chat = { id: 'claude-looking-name', supported_endpoints: ['/v1/chat/completions', '/v1/responses'] }
    const messages = { id: 'gpt-looking-name', supported_endpoints: ['/v1/messages'] }
    const decision = { id: 'typesafe/jev', supported_endpoints: ['/v1/systemone'] }
    const unknown = { id: 'claude-unknown', supported_endpoints: [] }
    expect(splitCommandcodeModels([chat, messages, decision, unknown])).toEqual({ chat: [chat], messages: [messages] })
  })

  it('preserves native Claude channels added after the first bridge read', async () => {
    let readStarted!: () => void, resumeRead!: () => void
    const started = new Promise<void>(resolve => { readStarted = resolve })
    const resume = new Promise<void>(resolve => { resumeRead = resolve })
    pauseNextRead = async () => { readStarted(); await resume }
    const connecting = connectCommandcodeBridge()
    await started
    const native = { name: 'concurrently-added-claude', keys: [{ 'api-key': 'keep-concurrent-claude' }], models: [{ name: 'native-new-claude' }] }
    claudeGroups.push(native)
    resumeRead()
    await connecting
    expect(claudeGroups.find(group => group.name === native.name)).toEqual(native)
    expect(claudeGroups.filter(group => group.name === COMMANDCODE_MESSAGES_CHANNEL)).toHaveLength(1)
  })

  it('does not claim to be connected with a disabled, missing, or hash-mismatched local gateway credential', async () => {
    await connectCommandcodeBridge()
    const id = fixture.integration!.key_id
    const original = { ...fixture.keys.get(id)! }
    fixture.keys.set(id, { ...original, enabled: false })
    expect(await getCommandcodeBridge()).toMatchObject({ connected: false })
    fixture.keys.set(id, { ...original, secret_hash: 'mismatched-hash' })
    expect(await getCommandcodeBridge()).toMatchObject({ connected: false })
    fixture.keys.delete(id)
    expect(await getCommandcodeBridge()).toMatchObject({ connected: false })
    fixture.keys.set(id, original)
    expect(await getCommandcodeBridge()).toMatchObject({ connected: true, error: null })
  })
})
