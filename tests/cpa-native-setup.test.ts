import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A small success fixture may simulate the verified digest in CI. Negative verification always uses real SHA256.
// When the already downloaded public artifact exists locally, success uses its actual bytes and digest as well.
const digestFixture = vi.hoisted(() => ({ acceptedDigest: undefined as string | undefined }))
vi.mock('node:crypto', async importOriginal => {
  const crypto = await importOriginal<typeof import('node:crypto')>()
  return { ...crypto, createHash: (...args: Parameters<typeof crypto.createHash>) => {
    const hash = crypto.createHash(...args)
    if (!digestFixture.acceptedDigest) return hash
    const wrapper = { update: (data: Parameters<typeof hash.update>[0]) => { hash.update(data); return wrapper }, digest: () => digestFixture.acceptedDigest }
    return wrapper
  } }
})
import { NATIVE_PANEL_SHA256, NATIVE_PANEL_URL, NATIVE_PANEL_VERSION, prepareNativePanel, prepareNativeProviders } from '../scripts/setup-native-cpa.mjs'

const publicPanel = resolve('.runtime/cpa/config/static/management.html')
const fakeLicense = 'MIT License\nCopyright (c) Router-For.ME\nThis is a fixture license response.'
const managementKey = 'fake-native-setup-server-management-key'
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('official native panel assets with preservation and a pinned verification gate', () => {
  let directory: string
  beforeEach(async () => { digestFixture.acceptedDigest = undefined; directory = await mkdtemp(join(tmpdir(), 'nexus-cpa-native-setup-')) })
  afterEach(async () => {
    digestFixture.acceptedDigest = undefined
    const target = resolve(directory), temporaryRoot = resolve(tmpdir())
    if (!target.startsWith(temporaryRoot + sep) || !/^nexus-cpa-native-setup-/.test(basename(target))) throw new Error('Unexpected temporary cleanup path')
    await rm(target, { recursive: true, force: true })
  })
  it('preserves a valid existing customized panel without downloading or replacing it', async () => {
    const folder = join(directory, '.runtime/cpa/config/static')
    await mkdir(folder, { recursive: true })
    const panel = '<html><head></head><body>Existing user-selected panel</body></html>'
    await writeFile(join(folder, 'management.html'), panel)
    const fetcher = vi.fn(async () => { throw new Error('Existing assets must not download') })
    expect(await prepareNativePanel(directory, fetcher)).toEqual({ preserved: true, installed: false })
    expect(fetcher).not.toHaveBeenCalled()
    expect(await readFile(join(folder, 'management.html'), 'utf8')).toBe(panel)
  })
  it('writes only a verified official candidate together with its license and source record', async () => {
    const bytes = existsSync(publicPanel) ? await readFile(publicPanel) : Buffer.from('<html><head></head><body>Known candidate fixture</body></html>')
    if (!existsSync(publicPanel)) digestFixture.acceptedDigest = NATIVE_PANEL_SHA256
    const urls: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input); urls.push(url)
      if (url === NATIVE_PANEL_URL) return new Response(bytes)
      if (url === `https://raw.githubusercontent.com/router-for-me/Cli-Proxy-API-Management-Center/${NATIVE_PANEL_VERSION}/LICENSE`) return new Response(fakeLicense)
      throw new Error('No other asset source may be contacted')
    })
    expect(await prepareNativePanel(directory, fetcher)).toEqual({ preserved: false, installed: true, version: NATIVE_PANEL_VERSION })
    const folder = join(directory, '.runtime/cpa/config/static')
    expect(await readFile(join(folder, 'management.html'))).toEqual(bytes)
    expect(await readFile(join(folder, 'management.LICENSE'), 'utf8')).toBe(fakeLicense)
    expect(JSON.parse(await readFile(join(folder, 'nexus-panel-source.json'), 'utf8'))).toEqual({ repository: 'router-for-me/Cli-Proxy-API-Management-Center', version: NATIVE_PANEL_VERSION, sha256: NATIVE_PANEL_SHA256 })
    expect(existsSync(join(folder, 'management.html.download'))).toBe(false)
    expect(urls).toHaveLength(2)
  })
  it('rejects mismatched asset bytes using real SHA256 before any installation or license request', async () => {
    const fetcher = vi.fn(async () => new Response('<html><head></head><body>Wrong release bytes</body></html>'))
    await expect(prepareNativePanel(directory, fetcher)).rejects.toThrow('digest verification failed')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(existsSync(join(directory, '.runtime/cpa/config/static/management.html'))).toBe(false)
    expect(existsSync(join(directory, '.runtime/cpa/config/static/management.html.download'))).toBe(false)
  })
  it('requires the accompanying official license before publishing the verified panel', async () => {
    const bytes = existsSync(publicPanel) ? await readFile(publicPanel) : Buffer.from('<html><head></head></html>')
    if (!existsSync(publicPanel)) digestFixture.acceptedDigest = NATIVE_PANEL_SHA256
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input) === NATIVE_PANEL_URL ? new Response(bytes) : new Response('Unexpected license'))
    await expect(prepareNativePanel(directory, fetcher)).rejects.toThrow('license verification failed')
    expect(existsSync(join(directory, '.runtime/cpa/config/static/management.html'))).toBe(false)
  })
})

describe('known official Google provider provisioning without OAuth or model calls', () => {
  it('installs only the canonical gemini-cli entry from the official registry and reports that activation still needs verification', async () => {
    const operations: { url: URL; init: RequestInit }[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input)); operations.push({ url, init: init || {} })
      if (url.pathname === '/v8/management/plugins') return json({ plugins_enabled: true, plugins: [] })
      if (url.pathname === '/v8/management/plugins/store') return json({ plugins: [
        { id: 'gemini-cli', source_id: 'community', repository: 'https://github.com/router-for-me/cpa-plugin-gemini-cli' },
        { id: 'other-plugin', source_id: 'official', repository: 'https://github.com/router-for-me/other' },
        { id: 'gemini-cli', source_id: 'official', repository: 'https://github.com/router-for-me/cpa-plugin-gemini-cli' },
      ] })
      if (url.pathname === '/v8/management/plugins/store/gemini-cli/install') return json({ status: 'ok', restart_required: true })
      throw new Error('Unexpected provider operation')
    })
    expect(await prepareNativeProviders({ baseUrl: 'http://127.0.0.1:8317', managementKey, fetch: fetcher })).toEqual({ installed: true, pluginsEnabled: true, googleReady: false, restartRequired: true })
    expect(operations).toHaveLength(3)
    expect(operations[2]!.url.search).toBe('?source=official')
    expect(operations[2]!.init.method).toBe('POST'); expect(operations[2]!.init.body).toBe('{}')
    for (const operation of operations) expect(new Headers(operation.init.headers).get('authorization')).toBe('Bearer ' + managementKey)
    expect(operations.every(operation => operation.url.origin === 'http://127.0.0.1:8317')).toBe(true)
    expect(operations.every(operation => !/oauth|chat\/completions|quota/.test(operation.url.pathname))).toBe(true)
  })
  it('refuses lookalike repository metadata or a third-party source without making any installation request', async () => {
    for (const entry of [
      { id: 'gemini-cli', source_id: 'official', repository: 'https://github.com.evil.invalid/router-for-me/cpa-plugin-gemini-cli' },
      { id: 'gemini-cli', source_id: 'community', repository: 'https://github.com/router-for-me/cpa-plugin-gemini-cli' },
    ]) {
      const operations: RequestInit[] = []
      const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { operations.push(init || {}); return json(new URL(String(input)).pathname.endsWith('/store') ? { plugins: [entry] } : { plugins_enabled: false, plugins: [] }) })
      await expect(prepareNativeProviders({ baseUrl: 'http://127.0.0.1:8317', managementKey, fetch: fetcher })).rejects.toThrow('unavailable in the official CPA store')
      expect(operations.every(operation => operation.method === 'GET')).toBe(true)
    }
  })
  it('preserves existing explicitly disabled plugin settings and does not force the global switch on', async () => {
    const fetcher = vi.fn(async () => json({ plugins_enabled: false, plugins: [{ id: 'gemini-cli', configured: true, registered: false, enabled: false, effective_enabled: false }] }))
    expect(await prepareNativeProviders({ baseUrl: 'http://127.0.0.1:8317', managementKey, fetch: fetcher })).toEqual({ installed: false, pluginsEnabled: false, googleReady: false, restartRequired: false })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('reports the already registered active provider without reinstalling or claiming an inactive one is ready', async () => {
    const fetcher = vi.fn(async () => json({ plugins_enabled: true, plugins: [{ id: 'gemini-cli', configured: true, registered: true, enabled: true, effective_enabled: true }] }))
    expect(await prepareNativeProviders({ baseUrl: 'http://127.0.0.1:8317', managementKey, fetch: fetcher })).toEqual({ installed: false, pluginsEnabled: true, googleReady: true, restartRequired: false })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('rejects addresses with schemes, credentials, paths or query overrides before network activity', async () => {
    for (const baseUrl of ['file:///tmp/core', 'http://user:password@127.0.0.1:8317', 'http://127.0.0.1:8317/other', 'http://127.0.0.1:8317?url=evil']) {
      const fetcher = vi.fn(async () => json({}))
      await expect(prepareNativeProviders({ baseUrl, managementKey, fetch: fetcher })).rejects.toThrow('Invalid CPA core address')
      expect(fetcher).not.toHaveBeenCalled()
    }
  })
})
