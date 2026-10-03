import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createCpaClient } from '../server/lib/cpa/client'
import { ensureCpaConfigAccountRoute, readCpaConfigAccountRoutes } from '../server/lib/cpa/preset-config-routing'

// Opt-in binary, temporary config and random local listeners. Never uses real credentials or upstreams.
const binary = process.env.TEST_CPA_BINARY
const key = (label: string) => label + randomBytes(20).toString('hex')
const managementKey = key('test-management-'), clientKey = key('test-client-')
const chatKeys = [key('test-chat-a-'), key('test-chat-b-')]
const messageKeys = [key('test-messages-a-'), key('test-messages-b-')]

describe.skipIf(!binary)('real CPA per-account preset routing through native prefixes', () => {
  let child: ChildProcess | undefined, upstream: Server | undefined, directory: string | undefined
  let base = '', upstreamBase = '', output = ''
  const calls: { headers: IncomingHttpHeaders; model: string; path: string }[] = []
  const cpaHeaders = { authorization: 'Bearer ' + clientKey, 'content-type': 'application/json' }
  const client = () => createCpaClient({ baseUrl: base, managementKey })
  const parse = (body: Uint8Array) => JSON.parse(new TextDecoder().decode(body))
  const post = (path: string, model: string) => fetch(base + path, { method: 'POST', headers: cpaHeaders,
    body: JSON.stringify({ model, max_tokens: 32, messages: [{ role: 'user', content: 'local mock only' }] }), signal: AbortSignal.timeout(5000) })

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nexus-cpa-preset-'))
    for (const folder of ['auth', 'plugins', 'cache']) await mkdir(join(directory, folder))
    upstream = createServer(async (request, response) => {
      let text = ''
      for await (const chunk of request) text += chunk
      const body = JSON.parse(text || '{}')
      calls.push({ headers: request.headers, model: body.model, path: request.url || '' })
      response.setHeader('content-type', 'application/json')
      const receivedKey = String(request.headers['x-api-key'] || request.headers.authorization || '')
      if (request.url?.startsWith('/v1/messages')) response.end(JSON.stringify({ id: 'msg-local', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: receivedKey }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }))
      else response.end(JSON.stringify({ id: 'chatcmpl-local', object: 'chat.completion', created: 1, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: receivedKey }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    })
    await new Promise<void>(finish => upstream!.listen(0, '127.0.0.1', finish))
    upstreamBase = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
    const reservation = createServer()
    await new Promise<void>(finish => reservation.listen(0, '127.0.0.1', finish))
    const port = (reservation.address() as AddressInfo).port
    await new Promise<void>(finish => reservation.close(() => finish()))
    base = `http://127.0.0.1:${port}`
    const config = {
      'config-version': 8,
      server: { host: '127.0.0.1', port, discovery: { enabled: false } },
      management: { 'allow-remote': false, 'secret-key': managementKey, 'disable-control-panel': true, 'disable-auto-update-panel': true },
      access: { 'api-keys': [clientKey] }, oauth: { 'auth-dir': join(directory, 'auth') },
      plugins: { enabled: false, dir: join(directory, 'plugins'), configs: {} },
      routing: { 'force-model-prefix': false, retry: { 'request-retry': 0 }, cooldown: { 'disable-cooling': true } },
      observability: { logs: { 'logging-to-file': false } },
      'api-keys': {
        'openai-compatibility': [{ name: 'test-chat', 'base-url': upstreamBase + '/v1', 'request-retry': 0, headers: { 'X-Preserved': 'chat' },
          models: [{ name: 'gpt-local', alias: 'chat-local' }], keys: chatKeys.map(value => ({ 'api-key': value })) }],
        claude: [{ name: 'test-messages', 'base-url': upstreamBase, 'request-retry': 0, headers: { 'X-Preserved': 'messages' },
          models: [{ name: 'claude-local', alias: 'messages-local' }], keys: messageKeys.map(value => ({ 'api-key': value, cloak: { mode: 'never' } })) }],
      },
    }
    const configPath = join(directory, 'config.yaml')
    await writeFile(configPath, JSON.stringify(config, null, 2))
    child = spawn(resolve(binary!), ['-config', configPath, '-local-model'], { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MANAGEMENT_PASSWORD: '', LOCALAPPDATA: join(directory, 'cache'), XDG_CACHE_HOME: join(directory, 'cache') } })
    child.stdout?.on('data', chunk => { output = (output + String(chunk)).slice(-8192) })
    child.stderr?.on('data', chunk => { output = (output + String(chunk)).slice(-8192) })
    child.on('error', error => { output = (output + error.message).slice(-8192) })
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('Isolated CPA exited: ' + output)
      try { if ((await client().request({ path: 'config/api-keys' })).status === 200) return } catch { /* Starting local listener. */ }
      await new Promise<void>(finish => setTimeout(finish, 100))
    }
    throw new Error('Isolated CPA did not start: ' + output)
  }, 25_000)

  afterAll(async () => {
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
      const target = resolve(directory), root = resolve(tmpdir())
      if (!target.startsWith(root + sep) || !/^nexus-cpa-preset-/.test(basename(target))) throw new Error('Unexpected temporary cleanup path')
      await rm(target, { recursive: true, force: true })
    }
  }, 10_000)

  async function waitForModels(ids: string[]) {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const response = await fetch(base + '/v1/models', { headers: cpaHeaders, signal: AbortSignal.timeout(1000) })
      const body = await response.json() as { data: { id: string }[] }
      if (ids.every(id => body.data.some(model => model.id === id))) return
      await new Promise<void>(finish => setTimeout(finish, 50))
    }
    throw new Error('CPA model prefixes were not registered')
  }

  it('persists native per-key and compatibility split prefixes, retains stable account IDs and routes to exactly the selected mock key', async () => {
    const before = await readCpaConfigAccountRoutes(client(), [])
    const chat = before.find(route => route.name === 'test-chat · Key 2')!
    const messages = before.find(route => route.name === 'test-messages · Key 2')!
    expect(chat.supported).toBe(true)
    expect(messages.supported).toBe(true)
    await ensureCpaConfigAccountRoute(client(), { id: chat.accountId }, 'chat-account-b')
    await ensureCpaConfigAccountRoute(client(), { id: messages.accountId }, 'messages-account-b')
    const after = await readCpaConfigAccountRoutes(client(), [])
    expect(after.find(route => route.accountId === chat.accountId)).toMatchObject({ prefix: 'chat-account-b', supported: true })
    expect(after.find(route => route.accountId === messages.accountId)).toMatchObject({ prefix: 'messages-account-b', supported: true })
    await waitForModels(['chat-local', 'chat-account-b/chat-local', 'messages-local', 'messages-account-b/messages-local'])
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await post('/v1/chat/completions', 'chat-account-b/chat-local')
      expect(response.status, await response.text()).toBe(200)
      expect(calls.at(-1)!.headers.authorization).toBe('Bearer ' + chatKeys[1])
      expect(calls.at(-1)!.model).toBe('gpt-local')
      expect(calls.at(-1)!.headers['x-preserved']).toBe('chat')
      const messageResponse = await post('/v1/messages', 'messages-account-b/messages-local')
      expect(messageResponse.status, await messageResponse.text()).toBe(200)
      expect(String(calls.at(-1)!.headers['x-api-key'] || calls.at(-1)!.headers.authorization).replace(/^Bearer\s+/i, '')).toBe(messageKeys[1])
      expect(calls.at(-1)!.model).toBe('claude-local')
      expect(calls.at(-1)!.headers['x-preserved']).toBe('messages')
    }
    for (const [path, model] of [['/v1/chat/completions', 'chat-local'], ['/v1/messages', 'messages-local']]) {
      const response = await post(path!, model!)
      expect(response.status, await response.text()).toBe(200)
    }
    const config = await readFile(join(directory!, 'config.yaml'), 'utf8')
    expect(config).toContain('chat-account-b')
    expect(config).toContain('messages-account-b')
  })

  it('does not fall back to a sibling account when the selected compatibility prefix provider is disabled', async () => {
    const groups = parse((await client().request({ path: 'config/api-keys/openai-compatibility' })).body) as Record<string, unknown>[]
    const chosen = groups.find(group => group.prefix === 'chat-account-b')!
    chosen.disabled = true
    expect((await client().request({ path: 'config/api-keys', method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ 'openai-compatibility': groups }) })).status).toBe(200)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const models = await fetch(base + '/v1/models', { headers: cpaHeaders })
      const catalog = await models.json() as { data: { id: string }[] }
      if (!catalog.data.some(model => model.id === 'chat-account-b/chat-local')) break
      await new Promise<void>(finish => setTimeout(finish, 50))
    }
    const initialCalls = calls.length
    const response = await post('/v1/chat/completions', 'chat-account-b/chat-local')
    expect(response.ok).toBe(false)
    await response.arrayBuffer()
    expect(calls.length).toBe(initialCalls)
    const ordinary = await post('/v1/chat/completions', 'chat-local')
    expect(ordinary.status, await ordinary.text()).toBe(200)
    expect(calls.at(-1)!.headers.authorization).toBe('Bearer ' + chatKeys[0])
  })
})
