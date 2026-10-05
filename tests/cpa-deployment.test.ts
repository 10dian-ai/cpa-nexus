import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { createConnection, createServer as createTcpServer, type Socket } from 'node:net'
import { createHash } from 'node:crypto'
import { parse } from 'dotenv'
// @ts-ignore Setup is a plain ESM utility and performs no work when imported.
import { setupCpa, CPA_IMAGE, CPA_VERSION, CPA_UPSTREAM_IMAGE, CPA_UPSTREAM_REF } from '../scripts/setup-cpa.mjs'

describe('CPA Nexus deployment initialization', () => {
  let directory: string
  const temporaryPrefix = join(tmpdir(), 'cpa-nexus-deployment-')
  beforeEach(async () => { directory = await mkdtemp(temporaryPrefix) })
  afterEach(async () => {
    if (!directory.startsWith(temporaryPrefix)) throw new Error('Unexpected test cleanup path')
    await rm(directory, { recursive: true, force: true })
  })

  it('creates a pinned core with distinct client and management keys without printing secrets', async () => {
    const output: string[] = []
    await setupCpa(directory, (message: string) => output.push(message))
    const environment = parse(await readFile(join(directory, '.env.cpa'), 'utf8'))
    const config = await readFile(join(directory, '.runtime/cpa/config/config.yaml'), 'utf8')
    expect(environment.CPA_IMAGE).toBe(CPA_IMAGE)
    expect(environment.CPA_VERSION).toBe(CPA_VERSION)
    expect(CPA_IMAGE).toBe('cpa-nexus-core:v8.0.15-nexus1')
    expect(CPA_UPSTREAM_IMAGE).toMatch(/^eceasy\/cli-proxy-api:v8\.0\.15@sha256:[a-f0-9]{64}$/)
    expect(environment.CPA_MANAGEMENT_KEY.length).toBeGreaterThanOrEqual(32)
    expect(environment.CPA_CLIENT_KEY).not.toBe(environment.CPA_MANAGEMENT_KEY)
    expect(config).toContain('secret-key: ' + JSON.stringify(environment.CPA_MANAGEMENT_KEY))
    expect(config).toContain('- ' + JSON.stringify(environment.CPA_CLIENT_KEY))
    expect(config).toContain('openai-compatibility: []')
    expect(output.join('')).not.toContain(environment.CPA_MANAGEMENT_KEY)
    expect(output.join('')).not.toContain(environment.CPA_CLIENT_KEY)
  })

  it('preserves an existing environment, edited core config and credentials on repeated setup', async () => {
    const originalEnvironment = 'ADMIN_PASSWORD=existing-secret\nPOSTGRES_PASSWORD=old-db-secret\n'
    await writeFile(join(directory, '.env'), originalEnvironment)
    await setupCpa(directory, () => {})
    const environment = await readFile(join(directory, '.env.cpa'), 'utf8')
    const configPath = join(directory, '.runtime/cpa/config/config.yaml')
    const customized = (await readFile(configPath, 'utf8')) + '# administrator custom settings\n'
    await writeFile(configPath, customized)
    await writeFile(join(directory, '.runtime/cpa/auth/fixture.json'), '{"type":"fixture"}')
    await setupCpa(directory, () => {})
    expect(await readFile(join(directory, '.env'), 'utf8')).toBe(originalEnvironment)
    expect(await readFile(join(directory, '.env.cpa'), 'utf8')).toBe(environment)
    expect(await readFile(configPath, 'utf8')).toBe(customized)
    expect(await readFile(join(directory, '.runtime/cpa/auth/fixture.json'), 'utf8')).toBe('{"type":"fixture"}')
  })

  it('fills missing optional settings without replacing provided CPA keys', async () => {
    const original = 'CPA_MANAGEMENT_KEY=fixture-management-key-123456789\nCPA_CLIENT_KEY=fixture-client-key-123456789\nCPA_URL=http://fixture.internal:8317\n'
    await writeFile(join(directory, '.env.cpa'), original)
    await setupCpa(directory, () => {})
    const environment = await readFile(join(directory, '.env.cpa'), 'utf8')
    expect(environment.startsWith(original)).toBe(true)
    expect(parse(environment).CPA_URL).toBe('http://fixture.internal:8317')
    expect(parse(environment).CPA_IMAGE).toBe(CPA_IMAGE)
  })

  it('upgrades only the former pinned image while preserving keys and customized source selection', async () => {
    await setupCpa(directory, () => {})
    const path = join(directory, '.env.cpa')
    const before = parse(await readFile(path, 'utf8'))
    await writeFile(path, (await readFile(path, 'utf8')).replace('CPA_IMAGE=' + CPA_IMAGE, 'CPA_IMAGE=' + CPA_UPSTREAM_IMAGE))
    await setupCpa(directory, () => {})
    const updated = parse(await readFile(path, 'utf8'))
    expect(updated.CPA_IMAGE).toBe(CPA_IMAGE)
    expect(updated.CPA_UPSTREAM_REF).toBe(CPA_UPSTREAM_REF)
    expect(updated.CPA_MANAGEMENT_KEY).toBe(before.CPA_MANAGEMENT_KEY)
    expect(updated.CPA_CLIENT_KEY).toBe(before.CPA_CLIENT_KEY)
    await writeFile(path, (await readFile(path, 'utf8')).replace('CPA_IMAGE=' + CPA_IMAGE, 'CPA_IMAGE=operator/custom-kernel:chosen'))
    await setupCpa(directory, () => {})
    expect(parse(await readFile(path, 'utf8')).CPA_IMAGE).toBe('operator/custom-kernel:chosen')
  })

  for (const legacyImage of [
    'cpa-nexus-core:v8.0.11-nexus1',
    'eceasy/cli-proxy-api:v8.0.11@sha256:1d7f8c154a9804ba33c5332bf76cdb3a05791d6fd275ccad8f2a63859ab25df9',
  ]) {
    it(`migrates an existing v8.0.11 pinned deployment (${legacyImage}) to the current kernel`, async () => {
      const oldEnvironment = [
        'CPA_VERSION=v8.0.11',
        'CPA_IMAGE=' + legacyImage,
        'CPA_UPSTREAM_REF=e2bff0107bb307337aaa19018ccddd55f64253d5',
        'CPA_UPSTREAM_IMAGE=eceasy/cli-proxy-api:v8.0.11@sha256:1d7f8c154a9804ba33c5332bf76cdb3a05791d6fd275ccad8f2a63859ab25df9',
        'CPA_MANAGEMENT_KEY=legacy-management-key-123456789',
        'CPA_CLIENT_KEY=legacy-client-key-123456789',
        '',
      ].join('\n')
      await writeFile(join(directory, '.env.cpa'), oldEnvironment)
      await setupCpa(directory, () => {})
      const updated = parse(await readFile(join(directory, '.env.cpa'), 'utf8'))
      expect(updated.CPA_VERSION).toBe(CPA_VERSION)
      expect(updated.CPA_IMAGE).toBe(CPA_IMAGE)
      expect(updated.CPA_UPSTREAM_REF).toBe(CPA_UPSTREAM_REF)
      expect(updated.CPA_UPSTREAM_IMAGE).toBe(CPA_UPSTREAM_IMAGE)
      expect(updated.CPA_MANAGEMENT_KEY).toBe('legacy-management-key-123456789')
      expect(updated.CPA_CLIENT_KEY).toBe('legacy-client-key-123456789')
    })
  }

  it('refuses to rotate lost keys when existing core state has already been created', async () => {
    await mkdir(join(directory, '.runtime/cpa/config'), { recursive: true })
    const configPath = join(directory, '.runtime/cpa/config/config.yaml')
    await writeFile(configPath, 'management:\n  secret-key: "$2a$fixture-hash"\n')
    await expect(setupCpa(directory, () => {})).rejects.toThrow('Restore .env.cpa')
    expect(await readFile(configPath, 'utf8')).toContain('$2a$fixture-hash')
    await expect(readFile(join(directory, '.env.cpa'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects invalid existing keys before changing files', async () => {
    const original = 'CPA_MANAGEMENT_KEY=short\nCPA_CLIENT_KEY=fixture-client-key-123456789\n'
    await writeFile(join(directory, '.env.cpa'), original)
    await expect(setupCpa(directory, () => {})).rejects.toThrow('at least 24 characters')
    expect(await readFile(join(directory, '.env.cpa'), 'utf8')).toBe(original)
  })

  it('runs the main setup entry point against an existing .env without replacing it', async () => {
    const original = '# original user deployment\nADMIN_PASSWORD=existing-password\n'
    await writeFile(join(directory, '.env'), original)
    const output = execFileSync(process.execPath, [resolve('scripts/setup.mjs')], { cwd: directory, encoding: 'utf8' })
    expect(output).toContain('contents were preserved')
    expect(await readFile(join(directory, '.env'), 'utf8')).toBe(original)
    expect(parse(await readFile(join(directory, '.env.cpa'), 'utf8')).CPA_IMAGE).toBe(CPA_IMAGE)
  })

  it('initializes a fresh deployment without host packages or legacy reverse-proxy settings', async () => {
    const output = execFileSync(process.execPath, [resolve('scripts/setup.mjs')], { cwd: directory, encoding: 'utf8' })
    const environment = parse(await readFile(join(directory, '.env'), 'utf8'))
    expect(environment.COMMANDCODE_API_URL).toBe('https://api.commandcode.ai/provider/v1')
    expect(environment.COMMANDCODE_MANAGEMENT_URL).toBe('https://api.commandcode.ai')
    expect(environment.KERNEL_URL).toBeUndefined()
    expect(environment.APP_ENCRYPTION_KEY).toBeTruthy()
    expect(output).not.toContain(environment.ADMIN_PASSWORD)
    expect(output).not.toContain(environment.APP_ENCRYPTION_KEY)
  })
})

describe('CPA Nexus persistent deployment contract', () => {
  it('keeps existing data volumes while using the official API and independent health checks', async () => {
    const compose = await readFile(resolve('compose.yml'), 'utf8')
    const development = await readFile(resolve('compose.dev.yml'), 'utf8')
    expect(compose).toContain('name: ${NEXUS_COMPOSE_PROJECT:-cpa-nexus}')
    expect(compose).toContain('postgres-data:/var/lib/postgresql/data')
    expect(compose).toContain('redis-data:/data')
    expect(compose).toContain('https://api.commandcode.ai/provider/v1')
    expect(compose).not.toMatch(/^  kernel:/m)
    expect(compose).not.toContain('KERNEL_URL')
    expect(development).not.toContain('kernel:')
    expect(compose).toContain('ccm:worker:heartbeat')
    expect(compose.match(/^    healthcheck:/gm)?.length).toBe(6)
    expect(compose).toContain(CPA_IMAGE)
  })

  it('provides a Docker-only deployment path and durable backup without volume deletion', async () => {
    const script = await readFile(resolve('scripts/deploy.sh'), 'utf8')
    expect(script).toContain('node:24-alpine node scripts/setup.mjs')
    expect(script).toContain('up -d --build --wait')
    expect(script).toContain('pg_dump -U ccm -d commandcode -Fc')
    expect(script).toContain('compose exec -T redis redis-cli SAVE')
    expect(script).toContain('.env .env.cpa .runtime/cpa')
    expect(script).toContain('trap resume EXIT')
    expect(script).not.toMatch(/down\s+.*(?:-v|--volumes)/)
    expect(script).not.toContain('npm install')
    expect(script).not.toContain('git pull')
  })

  it('routes original account endpoints to the app and preserves the complete core namespace', async () => {
    const configuration = await readFile(resolve('ops/nexus-nginx.conf'), 'utf8')
    const appRoutes = configuration.match(/location ~ (\^\/api\/\([^\n]+) \{\n\s+proxy_pass \$nexus_app;/)?.[1]
    expect(appRoutes).toBeTruthy()
    const pattern = new RegExp(appRoutes!)
    for (const route of ['/api/accounts/import', '/api/accounts/actions', '/api/external/accounts', '/api/external/accounts/123', '/api/external/jobs/123', '/api/external/pool', '/api/jobs/123', '/api/keys', '/api/service-keys']) {
      expect(pattern.test(route), route).toBe(true)
    }
    expect(pattern.test('/api/provider/example/v1/models')).toBe(false)
    expect(configuration).toContain('location = /v1/systemone')
    expect(configuration).toContain('location = /cpa-api/v1/systemone')
    expect(configuration).toContain('location ^~ /commandcode/v1/')
    expect(configuration).toContain('proxy_ignore_client_abort off;')
    expect(configuration).toContain('proxy_buffering off;')
  })
})

// Opt-in native proxy integration. This executes the production Nginx rules
// against disposable upstreams, including streaming and connection teardown.
// Run with TEST_NGINX_BINARY pointing to an official Nginx executable.
const nginxBinary = process.env.TEST_NGINX_BINARY
describe.skipIf(!nginxBinary)('CPA Nexus native edge transport', () => {
  let directory: string
  let prefix: string
  let edgeUrl: string
  let cpaUrl: string
  let app: Server
  let cpa: Server
  let nginx: ChildProcess
  let releaseStream: (() => void) | undefined
  let canceled = false
  const sockets = new Set<Socket>()
  const cpaRequests: string[] = []
  const temporaryPrefix = join(tmpdir(), 'cpa-nexus-edge-test-')
  const listen = (server: Server) => new Promise<number>(resolveListen => {
    server.listen(0, '127.0.0.1', () => resolveListen((server.address() as { port: number }).port))
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  })
  const waitFor = async (predicate: () => boolean, timeout = 2000) => {
    const end = Date.now() + timeout
    while (!predicate()) {
      if (Date.now() > end) throw Error('Proxy fixture did not reach the expected state')
      await new Promise(resolveWait => setTimeout(resolveWait, 20))
    }
  }

  beforeAll(async () => {
    directory = await mkdtemp(temporaryPrefix)
    prefix = directory.replaceAll('\\', '/') + '/'
    await mkdir(join(directory, 'logs'))
    await mkdir(join(directory, 'temp'))
    app = createServer(async (request, response) => {
      if (request.url?.startsWith('/nexus/cpa/v1/')) {
        const upstream = await fetch(cpaUrl + request.url.replace('/nexus/cpa', ''), { headers: { authorization: request.headers.authorization || '' } })
        response.writeHead(upstream.status, { 'content-type': 'application/json' })
        response.end(await upstream.text())
        return
      }
      if (request.url === '/cpa' || request.url === '/cpa/providers') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<html>CPA Nexus panel from app</html>')
        return
      }
      const authenticated = request.url?.startsWith('/api/external/')
        ? request.headers.authorization === 'Bearer fixture-service-key'
        : request.headers.cookie === 'fixture-admin'
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      response.writeHead(request.url?.startsWith('/api/') && !authenticated ? 401 : 200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ upstream: 'app', path: request.url, method: request.method, body: Buffer.concat(chunks).toString(), authenticated, headers: request.headers }))
    })
    cpa = createServer((request, response) => {
      cpaRequests.push(request.url || '')
      if (request.url === '/v1/fixture-stream') {
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        response.write('data: first\n\n')
        releaseStream = () => { response.end('data: second\n\n'); releaseStream = undefined }
        return
      }
      if (request.url === '/fixture-release-stream') {
        releaseStream?.()
        response.end('released')
        return
      }
      if (request.url === '/v1/fixture-cancel') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('data: active\n\n')
        const timer = setInterval(() => response.write(': keepalive\n\n'), 50)
        response.once('close', () => { clearInterval(timer); canceled = true })
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ upstream: 'cpa', path: request.url, headers: request.headers }))
    })
    cpa.on('upgrade', (request, socket) => {
      const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    })
    const appPort = await listen(app)
    const cpaPort = await listen(cpa)
    cpaUrl = 'http://127.0.0.1:' + cpaPort
    const reservation = createTcpServer()
    const edgePort = await new Promise<number>(resolvePort => reservation.listen(0, '127.0.0.1', () => {
      const port = (reservation.address() as { port: number }).port
      reservation.close(() => resolvePort(port))
    }))
    edgeUrl = 'http://127.0.0.1:' + edgePort
    const production = await readFile(resolve('ops/nexus-nginx.conf'), 'utf8')
    if (!production.includes('listen 3000;') || !production.includes('http://app:3000') || !production.includes('http://cpa:8317')) {
      throw Error('Production listener contract changed; refusing to start an unadapted test proxy')
    }
    const config = production.replace('listen 3000;', 'listen 127.0.0.1:' + edgePort + ';')
      .replaceAll('http://app:3000', 'http://127.0.0.1:' + appPort).replaceAll('http://cpa:8317', cpaUrl)
    await writeFile(join(directory, 'nexus-nginx.conf'), config)
    await writeFile(join(directory, 'nginx.conf'), 'worker_processes 1;\npid logs/nginx.pid;\nerror_log logs/error.log;\nevents { worker_connections 128; }\nhttp { client_body_temp_path "' + prefix + 'temp/client"; proxy_temp_path "' + prefix + 'temp/proxy"; include "' + prefix + 'nexus-nginx.conf"; }\n')
    execFileSync(nginxBinary!, ['-t', '-p', prefix, '-c', 'nginx.conf'], { windowsHide: true, stdio: 'pipe' })
    nginx = spawn(nginxBinary!, ['-p', prefix, '-c', 'nginx.conf', '-g', 'daemon off;'], { cwd: directory, windowsHide: true, stdio: 'ignore' })
    let ready = false
    for (let index = 0; index < 50; index++) {
      try { ready = (await fetch(edgeUrl + '/health')).ok } catch {}
      if (ready || nginx.exitCode !== null) break
      await new Promise(resolveWait => setTimeout(resolveWait, 20))
    }
    expect(ready).toBe(true)
  })

  afterAll(async () => {
    for (const socket of sockets) socket.destroy()
    if (nginx && nginx.exitCode === null) {
      const masterPid = Number((await readFile(join(directory, 'logs/nginx.pid'), 'utf8')).trim())
      if (masterPid !== nginx.pid) throw Error('Refusing to stop an unexpected Nginx master')
      const exited = new Promise<void>(resolveExit => nginx.once('exit', () => resolveExit()))
      execFileSync(nginxBinary!, ['-s', 'quit', '-p', prefix, '-c', 'nginx.conf'], { windowsHide: true, stdio: 'pipe' })
      await exited
    }
    for (const server of [app, cpa]) {
      if (server?.listening) { server.closeAllConnections(); await new Promise<void>(resolveClose => server.close(() => resolveClose())) }
    }
    if (directory) {
      if (!directory.startsWith(temporaryPrefix)) throw Error('Unexpected edge test cleanup path')
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps panel pages separate from the complete native model namespace', async () => {
    for (const route of ['/cpa', '/cpa/providers']) {
      const response = await fetch(edgeUrl + route)
      expect(response.headers.get('content-type')).toContain('text/html')
      expect(await response.text()).toContain('panel from app')
    }
    for (const route of ['/v1/models', '/v1beta/models', '/openai/v1/videos', '/backend-api/codex/responses', '/api/provider/example/v1/models']) {
      expect((await (await fetch(edgeUrl + route)).json()).upstream).toBe('cpa')
    }
    const escaped = await (await fetch(edgeUrl + '/cpa-api/future-model-path?fixture=1')).json()
    expect(escaped).toMatchObject({ upstream: 'cpa', path: '/future-model-path?fixture=1' })
  })

  it('preserves original image, video and token-count endpoints with private caller headers', async () => {
    for (const path of ['/v1/images/generations', '/v1/images/edits', '/v1/videos', '/v1/messages/count_tokens']) {
      const response = await fetch(edgeUrl + path, { method: 'POST', headers: {
        authorization: 'Bearer local-native-fixture', 'content-type': 'application/json',
        'user-agent': 'claude-code/private-software', originator: 'private-codex', cookie: 'private-visitor=local',
        'x-stainless-os': 'private-device', 'x-opencode-project': 'private-project', traceparent: 'private-trace',
      }, body: '{"model":"local-fixture-only"}' })
      const body = await response.json()
      expect(body.upstream).toBe('cpa'); expect(body.path).toBe(path)
      expect(body.headers.authorization).toBe('Bearer local-native-fixture')
      expect(body.headers['user-agent']).toBe('opencode'); expect(body.headers.originator).toBe('opencode')
      for (const name of ['cookie', 'x-stainless-os', 'x-opencode-project', 'traceparent']) expect(body.headers[name]).toBeUndefined()
    }
  })

  it('blocks native management and credential files before either upstream is called', async () => {
    const count = cpaRequests.length
    for (const route of ['/v0/management/config', '/v8/management/config', '/cpa-api/v8/management/config', '/cpa-api/v0/resource/plugins/logo', '/management.html', '/cpa-api/config.yaml', '/cpa-api/auth/secret.json', '/cpa-api/plugins/example', '/cpa-api/logs/file']) {
      expect((await fetch(edgeUrl + route)).status).toBe(404)
    }
    expect(cpaRequests.length).toBe(count)
  })

  it('keeps account import/add, jobs and pool endpoints behind the app authorization boundary', async () => {
    const count = cpaRequests.length
    for (const route of ['/api/accounts/import', '/api/accounts/actions', '/api/keys', '/api/service-keys']) {
      expect((await fetch(edgeUrl + route, { method: 'POST', body: '{}' })).status).toBe(401)
      const response = await fetch(edgeUrl + route, { method: 'POST', headers: { cookie: 'fixture-admin', 'content-type': 'application/json' }, body: '{"fixture":true}' })
      expect(await response.json()).toMatchObject({ upstream: 'app', path: route, method: 'POST', body: '{"fixture":true}', authenticated: true })
    }
    const add = await fetch(edgeUrl + '/api/external/accounts', { method: 'POST', headers: { authorization: 'Bearer fixture-service-key', 'content-type': 'application/json' }, body: '{"cookies":["fixture"]}' })
    expect(add.status).toBe(200)
    expect(await add.json()).toMatchObject({ upstream: 'app', path: '/api/external/accounts', method: 'POST', body: '{"cookies":["fixture"]}', authenticated: true })
    for (const route of ['/api/external/accounts', '/api/external/accounts/123', '/api/external/jobs/123', '/api/external/pool', '/api/jobs/123']) {
      expect((await fetch(edgeUrl + route)).status).toBe(401)
      const headers = route.startsWith('/api/external/') ? { authorization: 'Bearer fixture-service-key' } : { cookie: 'fixture-admin' }
      expect((await (await fetch(edgeUrl + route, { headers })).json()).upstream).toBe('app')
    }
    expect((await fetch(edgeUrl + '/api/external/accounts', { headers: { cookie: 'fixture-admin' } })).status).toBe(401)
    expect(cpaRequests.length).toBe(count)
  })

  it('preserves native System One and legacy CommandCode module entry points', async () => {
    for (const route of ['/v1/systemone', '/cpa-api/v1/systemone', '/commandcode/v1/systemone']) {
      const response = await fetch(edgeUrl + route, { method: 'POST', headers: { authorization: 'Bearer ccm_fixture' }, body: '{"message":"fixture"}' })
      expect(await response.json()).toMatchObject({ upstream: 'app', path: route.startsWith('/commandcode/')?'/commandcode/v1/systemone':'/v1/systemone', method: 'POST', body: '{"message":"fixture"}' })
    }
    const legacyModels = await (await fetch(edgeUrl + '/commandcode/v1/models')).json()
    expect(legacyModels).toMatchObject({ upstream: 'app', path: '/commandcode/v1/models' })
  })

  it('routes the management adapter to app and preserves outer HTTPS headers', async () => {
    const unauthenticated = await fetch(edgeUrl + '/api/cpa/status')
    expect(unauthenticated.status).toBe(401)
    expect((await unauthenticated.json()).upstream).toBe('app')
    const authenticated = await fetch(edgeUrl + '/api/cpa/status', { headers: { cookie: 'fixture-admin', 'x-forwarded-proto': 'https' } })
    const body = await authenticated.json()
    expect(body.upstream).toBe('app')
    expect(body.headers['x-forwarded-proto']).toBe('https')
    expect(body.headers['x-forwarded-host']).toBe(new URL(edgeUrl).host)
    const fallback = await (await fetch(edgeUrl + '/api/echo', { headers: { 'x-forwarded-proto': 'unexpected' } })).json()
    expect(fallback.headers['x-forwarded-proto']).toBe('http')
  })

  it('delivers SSE data before the upstream completes', async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2000)
    try {
      const response = await fetch(edgeUrl + '/v1/fixture-stream', { signal: controller.signal })
      const reader = response.body!.getReader()
      const first = await reader.read()
      expect(Buffer.from(first.value!).toString()).toContain('data: first')
      expect(releaseStream).toBeTypeOf('function')
      await fetch(cpaUrl + '/fixture-release-stream')
      let rest = ''
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; rest += Buffer.from(chunk.value).toString() }
      expect(rest).toContain('data: second')
    } finally { clearTimeout(timeout); controller.abort(); releaseStream?.() }
  })

  it('preserves WebSocket upgrade on native Responses routes', async () => {
    const target = new URL(edgeUrl)
    const socket = createConnection({ host: target.hostname, port: Number(target.port) })
    try {
      const handshake = await new Promise<string>((resolveHandshake, reject) => {
        let text = ''
        socket.setTimeout(2000, () => reject(Error('WebSocket handshake timed out')))
        socket.once('error', reject)
        socket.on('data', chunk => { text += chunk.toString(); if (text.includes('\r\n\r\n')) resolveHandshake(text) })
        socket.once('connect', () => socket.write('GET /v1/responses HTTP/1.1\r\nHost: ' + target.host + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'))
      })
      expect(handshake).toContain('101 Switching Protocols')
      expect(handshake.toLowerCase()).toContain('upgrade: websocket')
      expect(handshake).toContain('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=')
    } finally { socket.destroy() }
  })

  it('closes the upstream stream when the downstream client cancels', async () => {
    const controller = new AbortController()
    const response = await fetch(edgeUrl + '/v1/fixture-cancel', { signal: controller.signal })
    expect(Buffer.from((await response.body!.getReader().read()).value!).toString()).toContain('active')
    controller.abort()
    await waitFor(() => canceled)
    expect(canceled).toBe(true)
  })
})
