import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { createApp, defineEventHandler, toNodeListener } from 'h3'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.mock('../server/lib/auth', () => ({
  authenticateGatewayKey: async (secret: string) => !secret.startsWith('ccm_') || secret.startsWith('ccm_service_') ? null
    : { id: secret.startsWith('ccm_nexus_') ? 'native-bridge' : 'original-native-client', name: 'native legacy client', moduleId: 'commandcode' },
  findEnabledModelKey: async (id: string) => id === 'original-native-client' ? { id, name: 'native legacy client', moduleId: 'commandcode' } : null,
  requireModelKeyModule: async (key: { moduleId?: string }, moduleId: string) => {
    if ((key.moduleId || 'commandcode') !== moduleId) throw Object.assign(new Error('Key is bound to another module'), { statusCode: 403 })
  },
}))
vi.mock('../server/lib/modules', () => ({ requireModule: async () => {} }))
vi.mock('../server/lib/settings', () => ({ getSettings: async () => ({ maxRequestBodyMb: 1 }) }))
vi.mock('../server/lib/config', () => ({ getConfig: () => ({ encryptionKey: Buffer.alloc(32, 9).toString('base64') }) }))
import { buildCommandcodeChannel, buildCommandcodeMessagesChannel } from '../server/lib/commandcode-bridge'
import { createCpaClient } from '../server/lib/cpa/client'
import { handleCommandcodeCompatibility } from '../server/lib/commandcode-compat'
import { ORIGINAL_KEY_ID_HEADER, ORIGINAL_KEY_SIGNATURE_HEADER, signOriginalGatewayKey } from '../server/lib/commandcode-identity'

// Opt-in only. This never uses a production CPA process, config, auth directory,
// provider credential, database or network upstream.
const binary = process.env.TEST_CPA_BINARY
const credential = (label: string) => label + randomBytes(24).toString('base64url')
const managementKey = credential('test-management-')
const clientKey = credential('test-client-')
const bridgeKey = credential('ccm_nexus_')
const policyKey = Buffer.alloc(32, 9).toString('base64')

describe.skipIf(!binary)('real CPA binary integration with an isolated local upstream', () => {
  let child: ChildProcess | undefined
  let upstream: Server | undefined
  let directory: string | undefined
  let base: string
  let upstreamBase: string
  let output = ''
  const calls: { headers: IncomingHttpHeaders; body: Record<string, any>; path: string }[] = []

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nexus-cpa-native-'))
    for (const folder of ['auth', 'plugins', 'logs', 'cache']) await mkdir(join(directory, folder))
    const legacyApp = createApp().use(defineEventHandler(handleCommandcodeCompatibility))
    const legacyListener = toNodeListener(legacyApp)
    upstream = createServer(async (request, response) => {
      if (request.url?.startsWith('/commandcode/v1/')) return legacyListener(request, response)
      let text = ''
      for await (const chunk of request) text += chunk
      const body = JSON.parse(text || '{}')
      calls.push({ headers: request.headers, body, path: request.url || '' })
      if (new URL(request.url || '/', 'http://local.test').pathname === '/v1/messages') {
        if (body.stream) {
          response.setHeader('content-type', 'text/event-stream')
          const events = [
            { type: 'message_start', message: { id: 'msg-local', type: 'message', role: 'assistant', model: 'claude-test', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'nexus-native-messages' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
            { type: 'message_stop' },
          ]
          for (const event of events) response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n')
          response.end()
          return
        }
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ id: 'msg-local', type: 'message', role: 'assistant', model: 'claude-test',
          content: [{ type: 'text', text: 'nexus-native-messages' }], stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        }))
        return
      }
      if (body.stream) {
        response.setHeader('content-type', 'text/event-stream')
        const chunks = [
          { delta: { role: 'assistant', content: '' }, finish_reason: null },
          { delta: { content: 'nexus-native' }, finish_reason: null },
          { delta: {}, finish_reason: 'stop' },
        ]
        for (const [index, choice] of chunks.entries()) response.write('data: ' + JSON.stringify({
          id: 'chatcmpl-local', object: 'chat.completion.chunk', created: 1, model: 'gpt-test',
          choices: [{ index: 0, ...choice }],
          ...(index === 2 ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
        }) + '\n\n')
        response.end('data: [DONE]\n\n')
        return
      }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({
        id: 'chatcmpl-local', object: 'chat.completion', created: 1, model: 'gpt-test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'nexus-native' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }))
    })
    await new Promise<void>(resolvePort => upstream!.listen(0, '127.0.0.1', resolvePort))
    upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`
    const portReservation = createServer()
    await new Promise<void>(resolvePort => portReservation.listen(0, '127.0.0.1', resolvePort))
    const port = (portReservation.address() as AddressInfo).port
    await new Promise<void>(finish => portReservation.close(() => finish()))
    base = `http://127.0.0.1:${port}`
    vi.stubEnv('CPA_URL', base)
    vi.stubEnv('CPA_CLIENT_KEY', clientKey)
    vi.stubEnv('CPA_MANAGEMENT_KEY', managementKey)
    vi.stubEnv('NEXUS_GROUP_POLICY_KEY', policyKey)
    const config = {
      'config-version': 8,
      server: { host: '127.0.0.1', port, discovery: { enabled: false } },
      management: { 'allow-remote': false, 'secret-key': managementKey, 'disable-control-panel': true, 'disable-auto-update-panel': true },
      access: { 'api-keys': [clientKey] },
      oauth: { 'auth-dir': join(directory, 'auth') },
      plugins: { enabled: false, dir: join(directory, 'plugins'), configs: {} },
      routing: { retry: { 'request-retry': 0 }, cooldown: { 'disable-cooling': true } },
      observability: { logs: { 'logging-to-file': false } },
      'api-keys': { 'openai-compatibility': [], claude: [] },
    }
    const configPath = join(directory, 'config.yaml')
    // JSON is valid YAML; this preserves Windows absolute paths without shell escaping.
    await writeFile(configPath, JSON.stringify(config, null, 2))
    child = spawn(resolve(binary!), ['-config', configPath, '-local-model'], {
      cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NEXUS_GROUP_POLICY_KEY: policyKey, MANAGEMENT_PASSWORD: '', LOCALAPPDATA: join(directory, 'cache'), XDG_CACHE_HOME: join(directory, 'cache') },
    })
    child.stdout?.on('data', chunk => { output = (output + String(chunk)).slice(-8192) })
    child.stderr?.on('data', chunk => { output = (output + String(chunk)).slice(-8192) })
    child.on('error', error => { output = (output + '\n' + error.message).slice(-8192) })
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('Isolated CPA exited before startup: ' + output)
      try {
        const response = await fetch(base + '/v8/management/config', { headers: { authorization: 'Bearer ' + managementKey }, signal: AbortSignal.timeout(500) })
        if (response.ok) { await response.arrayBuffer(); return }
        await response.arrayBuffer()
      } catch { /* The random listener is still starting. */ }
      await new Promise<void>(finish => setTimeout(finish, 100))
    }
    throw new Error('Isolated CPA failed to start: ' + output)
  }, 25_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    if (child && child.exitCode === null) {
      const stopped = new Promise<void>(finish => child!.once('exit', () => finish()))
      child.kill('SIGTERM')
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([stopped, new Promise<void>(finish => { timer = setTimeout(finish, 2000) })])
      if (timer) clearTimeout(timer)
      if (child.exitCode === null) { child.kill('SIGKILL'); await stopped }
    }
    if (upstream) await new Promise<void>(finish => { upstream!.close(() => finish()); upstream!.closeAllConnections() })
    if (directory) {
      const target = resolve(directory), temporaryRoot = resolve(tmpdir())
      if (!target.startsWith(temporaryRoot + sep) || !/^nexus-cpa-native-/.test(basename(target))) throw new Error('Unexpected CPA test cleanup target')
      await rm(target, { recursive: true, force: true })
    }
  }, 10_000)

  it('accepts the generated CommandCode group through actual v8 configuration validation', async () => {
    const client = createCpaClient({ baseUrl: base, managementKey })
    expect(await client.status()).toMatchObject({ connected: true, version: '8.0.15' })
    const channel = buildCommandcodeChannel(bridgeKey, [{ id: 'gpt-test' }], upstreamBase)
    const messagesChannel = buildCommandcodeMessagesChannel(bridgeKey, [{ id: 'claude-test' }], upstreamBase)
    // v8.0.15 supports retry/cooling overrides at the group level, not in keys[].
    expect(channel.keys[0]).toEqual({ 'api-key': bridgeKey })
    const response = await client.request({ path: 'config/api-keys', method: 'PATCH', body: JSON.stringify({ 'openai-compatibility': [channel], claude: [messagesChannel] }), headers: { 'content-type': 'application/json' } })
    expect(response.status, new TextDecoder().decode(response.body)).toBe(200)
    const saved = await client.request({ path: 'config/api-keys/openai-compatibility' })
    const groups = JSON.parse(new TextDecoder().decode(saved.body))
    expect(groups[0]).toMatchObject({ name: 'nexus-commandcode', 'base-url': upstreamBase, 'request-retry': 0, 'disable-cooling': true })
    expect(groups[0].keys[0]).toEqual({ 'api-key': bridgeKey })
    const savedMessages = await client.request({ path: 'config/api-keys/claude' })
    const messages = JSON.parse(new TextDecoder().decode(savedMessages.body))
    expect(messages[0]).toMatchObject({ name: 'nexus-commandcode-messages', 'base-url': upstreamBase.replace(/\/v1$/, ''), 'request-retry': 0, 'disable-cooling': true })
    expect(messages[0].keys[0]).toMatchObject({ 'api-key': bridgeKey, cloak: { mode: 'never' } })
    const file = await readFile(join(directory!, 'config.yaml'), 'utf8')
    expect(file).not.toContain(managementKey)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const models = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer ' + clientKey }, signal: AbortSignal.timeout(1000) })
      const catalog = await models.json() as { data: { id: string }[] }
      if (['commandcode/gpt-test', 'commandcode/claude-test'].every(id => catalog.data.some(model => model.id === id))) return
      await new Promise<void>(finish => setTimeout(finish, 50))
    }
    throw new Error('CPA did not expose the registered CommandCode model alias')
  })

  it.each([
    ['/v1/chat/completions', { model: 'commandcode/gpt-test', messages: [{ role: 'user', content: 'local test' }] }],
    ['/v1/messages', { model: 'commandcode/gpt-test', max_tokens: 32, messages: [{ role: 'user', content: 'local test' }] }],
    ['/v1/responses', { model: 'commandcode/gpt-test', input: 'local test' }],
  ])('translates %s to the local CommandCode upstream and retains caller session metadata', async (path, body) => {
    const previous = calls.length
    const response = await fetch(base + path, {
      method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { authorization: 'Bearer ' + clientKey, 'content-type': 'application/json', 'X-Session-ID': 'native-session-test', 'X-Agent-ID': 'native-agent-test', 'X-Cmd-Zdr': '1' },
      body: JSON.stringify(body),
    })
    const result = await response.text()
    expect(response.status, result).toBe(200)
    expect(result).toContain('nexus-native')
    expect(calls).toHaveLength(previous + 1)
    const call = calls.at(-1)!
    expect(call.path).toBe('/v1/chat/completions')
    expect(call.body.model).toBe('gpt-test')
    expect(call.headers.authorization).toBe('Bearer ' + bridgeKey)
    expect(call.headers['x-session-id']).toBe('native-session-test')
    expect(call.headers['x-agent-id']).toBe('native-agent-test')
    expect(call.headers['x-cmd-zdr']).toBe('1')
    expect(call.headers['x-nexus-client-authorization']).toBe('Bearer ' + clientKey)
    expect(JSON.stringify(call)).not.toContain(managementKey)
  })

  it.each([
    ['/v1/chat/completions', { model: 'commandcode/claude-test', messages: [{ role: 'user', content: 'local test' }] }],
    ['/v1/messages', { model: 'commandcode/claude-test', max_tokens: 32, messages: [{ role: 'user', content: 'local test' }] }],
    ['/v1/responses', { model: 'commandcode/claude-test', input: 'local test' }],
  ])('translates %s to the advertised Messages upstream instead of guessing a chat endpoint', async (path, body) => {
    const previous = calls.length
    const response = await fetch(base + path, {
      method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { authorization: 'Bearer ' + clientKey, 'content-type': 'application/json', 'X-Session-ID': 'messages-session-test', 'X-Agent-ID': 'messages-agent-test', 'X-Cmd-Zdr': '1' },
      body: JSON.stringify(body),
    })
    const result = await response.text()
    expect(response.status, result).toBe(200)
    expect(result).toContain('nexus-native-messages')
    expect(calls).toHaveLength(previous + 1)
    const call = calls.at(-1)!
    expect(new URL(call.path, 'http://local.test').pathname).toBe('/v1/messages')
    expect(call.body.model).toBe('claude-test')
    expect(call.headers['x-api-key'] || call.headers.authorization?.replace(/^Bearer /, '')).toBe(bridgeKey)
    expect(call.headers['x-session-id']).toBe('messages-session-test')
    expect(call.headers['x-agent-id']).toBe('messages-agent-test')
    expect(call.headers['x-cmd-zdr']).toBe('1')
    expect(call.headers['x-nexus-client-authorization']).toBe('Bearer ' + clientKey)
    expect(JSON.stringify(call)).not.toContain(managementKey)
  })

  it('converts native Messages streaming into Chat and Responses events', async () => {
    for (const path of ['/v1/chat/completions', '/v1/responses']) {
      const previous = calls.length
      const response = await fetch(base + path, {
        method: 'POST', signal: AbortSignal.timeout(5000),
        headers: { authorization: 'Bearer ' + clientKey, 'content-type': 'application/json' },
        body: JSON.stringify(path.endsWith('/responses')
          ? { model: 'commandcode/claude-test', stream: true, input: 'local stream test' }
          : { model: 'commandcode/claude-test', stream: true, messages: [{ role: 'user', content: 'local stream test' }] }),
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/event-stream')
      const events = await response.text()
      expect(events).toContain('nexus-native-messages')
      expect(events).toContain(path.endsWith('/responses') ? 'response.completed' : 'data: [DONE]')
      expect(calls).toHaveLength(previous + 1)
      expect(new URL(calls.at(-1)!.path, 'http://local.test').pathname).toBe('/v1/messages')
      expect(calls.at(-1)!.body.stream).toBe(true)
    }
  })

  it('retains the original ccm client endpoint while CPA converts a raw Claude model and forwards signed caller attribution', async () => {
    const previous = calls.length
    const response = await fetch(upstreamBase.replace(/\/v1$/, '') + '/commandcode/v1/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(5000), headers: { authorization: 'Bearer ccm_original-native-client-key', 'content-type': 'application/json', 'X-Session-ID': 'original-session', 'X-Cmd-Zdr': '1' },
      body: JSON.stringify({ model: 'claude-test', messages: [{ role: 'user', content: 'original client format' }] }),
    })
    const result = await response.text()
    expect(response.status, result).toBe(200)
    expect(result).toContain('nexus-native-messages')
    expect(calls).toHaveLength(previous + 1)
    const call = calls.at(-1)!
    expect(new URL(call.path, 'http://local.test').pathname).toBe('/v1/messages')
    expect(call.body.model).toBe('claude-test')
    expect(call.headers[ORIGINAL_KEY_ID_HEADER]).toBe('original-native-client')
    expect(call.headers[ORIGINAL_KEY_SIGNATURE_HEADER]).toBe(signOriginalGatewayKey('original-native-client'))
    expect(call.headers['x-session-id']).toBe('original-session')
    expect(call.headers['x-cmd-zdr']).toBe('1')
    expect(call.headers['x-api-key'] || call.headers.authorization?.replace(/^Bearer /, '')).toBe(bridgeKey)
    expect(JSON.stringify(call)).not.toContain('ccm_original-native-client-key')
  })

  it('preserves native chat streaming through CPA', async () => {
    const response = await fetch(base + '/v1/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { authorization: 'Bearer ' + clientKey, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'commandcode/gpt-test', stream: true, messages: [{ role: 'user', content: 'local stream test' }] }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const events = await response.text()
    expect(events).toContain('nexus-native')
    expect(events).toContain('data: [DONE]')
  })
})
