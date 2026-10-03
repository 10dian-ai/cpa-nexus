import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const NATIVE_PANEL_VERSION = 'v1.25.2'
export const NATIVE_PANEL_SHA256 = 'b6ea0bbd1f7bdb2a3da5d960a5ad71bc89f33212ece21124c390511eef7ce041'
export const NATIVE_PANEL_URL = `https://github.com/router-for-me/Cli-Proxy-API-Management-Center/releases/download/${NATIVE_PANEL_VERSION}/management.html`
const NATIVE_PANEL_LICENSE_URL = `https://raw.githubusercontent.com/router-for-me/Cli-Proxy-API-Management-Center/${NATIVE_PANEL_VERSION}/LICENSE`
const GOOGLE_REPOSITORY = 'https://github.com/router-for-me/cpa-plugin-gemini-cli'

export async function prepareNativePanel(directory = process.cwd(), fetcher = fetch) {
  const folder = resolve(directory, '.runtime/cpa/config/static'), target = resolve(folder, 'management.html')
  try {
    const existing = await readFile(target)
    if (existing.byteLength && /<html[\s>]/i.test(existing.toString('utf8'))) return { preserved: true, installed: false }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const response = await fetcher(NATIVE_PANEL_URL, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw Error('Official CPA panel download failed')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > 16 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== NATIVE_PANEL_SHA256) throw Error('Official CPA panel digest verification failed')
  const license = await fetcher(NATIVE_PANEL_LICENSE_URL, { signal: AbortSignal.timeout(30_000) })
  if (!license.ok) throw Error('Official CPA panel license download failed')
  const text = await license.text()
  if (!text.includes('MIT License') || !text.includes('Router-For.ME')) throw Error('Official CPA panel license verification failed')
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const partial = target + '.download'
  await writeFile(partial, bytes, { mode: 0o600 })
  await rename(partial, target)
  await writeFile(resolve(folder, 'management.LICENSE'), text, { mode: 0o600 })
  await writeFile(resolve(folder, 'nexus-panel-source.json'), JSON.stringify({ repository: 'router-for-me/Cli-Proxy-API-Management-Center', version: NATIVE_PANEL_VERSION, sha256: NATIVE_PANEL_SHA256 }), { mode: 0o600 })
  return { preserved: false, installed: true, version: NATIVE_PANEL_VERSION }
}

export async function prepareNativeProviders(options = {}) {
  const url = new URL(options.baseUrl || process.env.CPA_URL || 'http://cpa:8317')
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw Error('Invalid CPA core address')
  const managementKey = options.managementKey || process.env.CPA_MANAGEMENT_KEY
  if (!managementKey || /[\r\n]/.test(managementKey)) throw Error('Missing CPA server management credential')
  const fetcher = options.fetch || fetch
  const api = async (path, method = 'GET', body) => {
    const response = await fetcher(new URL('/v8/management/' + path, url), { method, headers: { authorization: 'Bearer ' + managementKey, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: AbortSignal.timeout(120_000) })
    if (!response.ok) throw Error('CPA native provider operation failed: HTTP ' + response.status)
    return response.json()
  }
  const discovery = await api('plugins')
  const google = discovery.plugins?.find(plugin => plugin.id === 'gemini-cli')
  if (google?.registered || google?.configured) return { installed: false, pluginsEnabled: !!discovery.plugins_enabled, googleReady: !!google.effective_enabled, restartRequired: !!discovery.plugins_enabled && !!google.enabled && !google.registered }
  // Install only the known Google provider from CPA's official registry. Other
  // community plugins and explicitly disabled settings are left unchanged.
  const store = await api('plugins/store')
  const target = store.plugins?.find(plugin => plugin.id === 'gemini-cli' && plugin.source_id === 'official' && plugin.repository?.replace(/\/$/, '') === GOOGLE_REPOSITORY)
  if (!target) throw Error('Official Google Gemini CLI provider is unavailable in the official CPA store')
  const installed = await api('plugins/store/gemini-cli/install?source=official', 'POST', {})
  return { installed: true, pluginsEnabled: !!discovery.plugins_enabled, googleReady: false, restartRequired: !!discovery.plugins_enabled && (installed.restart_required !== false) }
}

export async function main(mode = process.argv[2]) {
  const result = mode === 'assets' ? await prepareNativePanel() : mode === 'providers' ? await prepareNativeProviders() : undefined
  if (!result) throw Error('Expected assets or providers mode')
  console.log(JSON.stringify(result))
  if (result.restartRequired) process.exitCode = 10
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { console.error('CPA native provisioning failed; existing accounts and configuration were preserved.'); process.exitCode = 1 })
