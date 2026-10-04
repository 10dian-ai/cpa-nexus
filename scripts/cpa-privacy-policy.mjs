// Shared by standalone provisioning and the server adapter. Requests stay on the fixed CPA
// management service; no credential values, documents or configuration are logged or returned.
export const CPA_PRIVACY_USER_AGENT = 'opencode'
const object = value => !!value && typeof value === 'object' && !Array.isArray(value)
const providerName = value => typeof value === 'string' ? value.trim().toLowerCase() : ''
const families = ['gemini', 'interactions', 'claude', 'codex', 'xai', 'meta', 'openai-compatibility', 'vertex']
const identityHeaders = new Set(['user-agent', 'originator', 'x-app', 'x-client-app', 'x-goog-api-client'])
const privateHeader = name => name.startsWith('x-stainless-') || name.startsWith('x-sdk-') || name.startsWith('x-device-')

export function cpaPrivacyHeaders(value, provider = '') {
  const current = object(value) ? value : {}
  const headers = {}
  const normalized = providerName(provider)
  for (const [name, content] of Object.entries(current)) {
    const lower = name.toLowerCase()
    if (privateHeader(lower)) continue
    // The OAuth CLI wire profile owns X-App=cli. Remove a source override rather than
    // relabeling an authentication/profile marker as client software.
    if (lower === 'x-app' && (normalized === 'claude' || normalized === 'anthropic')) continue
    if (identityHeaders.has(lower)) { if (lower !== 'user-agent') headers[name] = CPA_PRIVACY_USER_AGENT; continue }
    headers[name] = content
  }
  headers['User-Agent'] = CPA_PRIVACY_USER_AGENT
  if (normalized === 'codex') headers.Originator = CPA_PRIVACY_USER_AGENT
  if (normalized === 'gemini-cli' || normalized === 'gemini' || normalized === 'interactions') headers['X-Goog-Api-Client'] = CPA_PRIVACY_USER_AGENT
  if (normalized === 'claude' || normalized === 'anthropic') headers['X-Client-App'] = CPA_PRIVACY_USER_AGENT
  return Object.fromEntries(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b)))
}
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered)
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]))
  return value
}
function equal(a, b) { return JSON.stringify(ordered(a)) === JSON.stringify(ordered(b)) }
export function cpaPrivacyDefaultsPatch(config) {
  if (!object(config)) throw Error('CPA privacy configuration is invalid')
  const patch = {}
  const claude = config.upstream?.claude?.['header-defaults']
  const codex = config.oauth?.providers?.codex?.['header-defaults']
  if (claude?.['user-agent'] !== CPA_PRIVACY_USER_AGENT) patch.upstream = { claude: { 'header-defaults': { 'user-agent': CPA_PRIVACY_USER_AGENT } } }
  // Empty native string options fall back to the core's protocol compatibility defaults.
  // Clear old operator-provided device/SDK values, without inventing a replacement version.
  for (const field of ['package-version', 'runtime-version', 'os', 'arch']) if (typeof claude?.[field] === 'string' && claude[field].trim()) {
    patch.upstream ||= {}; patch.upstream.claude ||= {}; patch.upstream.claude['header-defaults'] ||= {}
    patch.upstream.claude['header-defaults'][field] = ''
  }
  if (config.upstream?.codex?.['disable-codex-cloaking'] !== true) {
    patch.upstream ||= {}; patch.upstream.codex = { 'disable-codex-cloaking': true }
  }
  if (codex?.['user-agent'] !== CPA_PRIVACY_USER_AGENT) patch.oauth = { providers: { codex: { 'header-defaults': { 'user-agent': CPA_PRIVACY_USER_AGENT } } } }
  return patch
}
export function cpaPrivacyApiKeysPatch(config) {
  if (config === undefined || config === null) return {}
  if (!object(config)) throw Error('CPA privacy upstream key configuration is invalid')
  const patch = {}
  for (const family of families) {
    if (config[family] === undefined || config[family] === null) continue
    const original = config[family]
    if (!Array.isArray(original) || original.some(group => !object(group) || !Array.isArray(group.keys) || group.keys.some(key => !object(key)))) throw Error('CPA privacy upstream entries are invalid')
    const groups = structuredClone(original)
    for (const group of groups) {
      group.headers = cpaPrivacyHeaders(group.headers, family)
      for (const key of group.keys) {
        // Compatibility custom headers are provider-wide in the pinned v8 schema.
        if (family !== 'openai-compatibility') key.headers = cpaPrivacyHeaders(key.headers, family)
        if (family === 'codex') key['disable-codex-cloaking'] = true
      }
    }
    if (!equal(original, groups)) patch[family] = groups
  }
  return patch
}
export function cpaPrivacyCredentialPatch(document) {
  if (!object(document)) throw Error('CPA privacy credential document is invalid')
  const patch = { headers: cpaPrivacyHeaders(document.headers, document.type) }
  return Object.fromEntries(Object.entries(patch).filter(([name, value]) => !equal(document[name], value)))
}

async function readJson(client, path, query) {
  const response = await client.request({ path, ...(query ? { query } : {}) })
  if (response.status !== 200) throw Error('CPA privacy read failed: ' + path)
  try { return JSON.parse(new TextDecoder().decode(response.body)) } catch { throw Error('CPA privacy response is invalid') }
}
async function writeJson(client, path, body, method = 'PATCH', query) {
  const response = await client.request({ path, method, ...(query ? { query } : {}), headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (response.status < 200 || response.status >= 300) throw Error('CPA privacy update failed: ' + path)
  return response
}

/** Caller serializes CPA configuration writes with the existing shared advisory lock. */
export async function applyCpaPrivacyPolicy(client, options = {}) {
  let changed = false, updatedFiles = 0
  const config = await readJson(client, 'config')
  const defaults = cpaPrivacyDefaultsPatch(config)
  if (Object.keys(defaults).length) { await writeJson(client, 'config', defaults); changed = true }
  // Read the arrays again after the scalar patch to preserve concurrent reload normalization.
  const current = await readJson(client, 'config')
  const upstream = object(current) ? current['api-keys'] : undefined
  const apiPatch = cpaPrivacyApiKeysPatch(upstream)
  if (Object.keys(apiPatch).length) { await writeJson(client, 'config/api-keys', apiPatch); changed = true }
  let fileNames = options.fileNames
  if (!fileNames) {
    const listing = await readJson(client, 'credentials')
    const files = Array.isArray(listing?.files) ? listing.files : listing?.items
    if (!Array.isArray(files)) throw Error('CPA privacy credential inventory is invalid')
    fileNames = [...new Set(files.filter(file => file?.source === 'file').map(file => String(file.path || file.name || '').split(/[\\/]/).pop()).filter(Boolean))]
  }
  for (const name of fileNames) {
    const document = await readJson(client, 'credentials/download', { name })
    const patch = cpaPrivacyCredentialPatch(document)
    if (!Object.keys(patch).length) continue
    const wirePatch = structuredClone(patch)
    if (object(wirePatch.headers) && object(document.headers)) {
      // v8 fields merges header maps. Explicit empty tombstones remove obsolete casing and
      // configured device/SDK fields; source re-upload below uses the semantic map instead.
      for (const key of Object.keys(document.headers)) if (!Object.hasOwn(wirePatch.headers, key)) wirePatch.headers[key] = ''
    }
    const response = await client.request({ path: 'credentials/fields', method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, ...wirePatch }) })
    if (response.status === 409 || response.status === 404) {
      // Virtual children cannot be patched; the physical source is re-synthesized instead.
      // Read immediately before writing so all latest token and unknown fields survive.
      const current = await readJson(client, 'credentials/download', { name })
      await writeJson(client, 'credentials', { ...current, ...cpaPrivacyCredentialPatch(current) }, 'POST', { name })
    } else if (response.status !== 200) throw Error('CPA privacy credential update failed')
    const saved = await readJson(client, 'credentials/download', { name })
    if (Object.keys(cpaPrivacyCredentialPatch(saved)).length) throw Error('CPA privacy credential update was not persisted')
    changed = true; updatedFiles++
  }
  return { changed, updatedFiles }
}
