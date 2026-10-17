import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'

export const CPA_VERSION = 'v8.0.32'
export const CPA_IMAGE = 'cpa-nexus-core:v8.0.32-nexus1'
export const CPA_UPSTREAM_REF = '911f49cbd49f4fe2516979754a7488a3fd14fe64'
export const CPA_UPSTREAM_IMAGE = 'eceasy/cli-proxy-api:v8.0.32@sha256:68f6e2d691f7b71aca21cfe87c77b7076cbea26c8ef490b15619b1623a7c0699'

// Pins of previously published CPA Nexus cores. Existing deployments keep their
// .env.cpa across updates, so the migration must recognize each old pinned tuple
// before applying the new defaults. Without this, update keeps building the old
// upstream commit, and the adapter patches (made for the current commit) no longer
// apply. Add the outgoing pin here whenever the defaults above change.
export const LEGACY_CPA_PINS = Object.freeze([
  {
    version: 'v8.0.11',
    ref: 'e2bff0107bb307337aaa19018ccddd55f64253d5',
    upstreamImage: 'eceasy/cli-proxy-api:v8.0.11@sha256:1d7f8c154a9804ba33c5332bf76cdb3a05791d6fd275ccad8f2a63859ab25df9',
    image: 'cpa-nexus-core:v8.0.11-nexus1',
  },
  {
    version: 'v8.0.15',
    ref: 'a4acc9f752bd46571f737a10c04bf413656ab06b',
    upstreamImage: 'eceasy/cli-proxy-api:v8.0.15@sha256:ebc2ffc189cf241ff589cd9237c63ca9feba3c9b87fe6213ab9a0b642df132ae',
    image: 'cpa-nexus-core:v8.0.15-nexus1',
  },
])

async function readOptional(path) {
  try { return await readFile(path, 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

export async function setupCpa(directory = process.cwd(), log = console.log) {
  const environmentPath = resolve(directory, '.env.cpa')
  const configurationPath = resolve(directory, '.runtime/cpa/config/config.yaml')
  let environmentText = await readOptional(environmentPath)
  const existingConfiguration = await readOptional(configurationPath)
  // Native parsing keeps initial Docker setup independent of npm/node_modules.
  const environment = parseEnv(environmentText ?? '')
  // A running core hashes the management key in YAML. Recreating its lost key
  // would silently disconnect Nexus from that core, so recovery must be explicit.
  if (existingConfiguration !== null && (!environment.CPA_MANAGEMENT_KEY || !environment.CPA_CLIENT_KEY)) {
    throw new Error('Existing CPA config found without its .env.cpa keys. Restore .env.cpa from your backup; existing files were preserved.')
  }
  for (const key of ['CPA_MANAGEMENT_KEY', 'CPA_CLIENT_KEY']) {
    if (environment[key] !== undefined && environment[key].trim().length < 24) {
      throw new Error(`${key} in .env.cpa must contain at least 24 characters. Existing files were preserved.`)
    }
  }
  // Upgrade only the project's former pinned defaults after validating its keys.
  // Leave an operator-selected image/source untouched.
  // An old deployment may name either the built Nexus image or the bare official image.
  const isLegacyPinnedDeployment = LEGACY_CPA_PINS.some(pin => environment.CPA_VERSION === pin.version &&
    (environment.CPA_IMAGE === pin.image || environment.CPA_IMAGE === pin.upstreamImage) &&
    environment.CPA_UPSTREAM_REF === pin.ref &&
    environment.CPA_UPSTREAM_IMAGE === pin.upstreamImage)
  const isFormerUnbuiltPinnedImage = environment.CPA_VERSION === CPA_VERSION &&
    environment.CPA_IMAGE === CPA_UPSTREAM_IMAGE
  if (isLegacyPinnedDeployment || isFormerUnbuiltPinnedImage) {
    const replacements = isLegacyPinnedDeployment ? {
      CPA_VERSION,
      CPA_IMAGE,
      CPA_UPSTREAM_REF,
      CPA_UPSTREAM_IMAGE,
    } : { CPA_IMAGE }
    for (const [key, value] of Object.entries(replacements)) {
      const line = new RegExp(`^(?:export\\s+)?${key}\\s*=.*$`, 'm')
      environmentText = environmentText.replace(line, `${key}=${value}`)
      environment[key] = value
    }
    await writeFile(environmentPath, environmentText, { mode: 0o600 })
  }

  const defaults = {
    CPA_VERSION,
    CPA_IMAGE,
    CPA_UPSTREAM_REF,
    CPA_UPSTREAM_IMAGE,
    CPA_URL: 'http://127.0.0.1:8317',
    CPA_MANAGEMENT_KEY: randomBytes(32).toString('base64url'),
    CPA_CLIENT_KEY: 'nexus_' + randomBytes(32).toString('base64url'),
  }
  const missing = Object.entries(defaults).filter(([key]) => environment[key] === undefined)
  if (missing.length > 0) {
    const prefix = environmentText === null
      ? '# CPA Nexus core settings. Server-only management key; do not commit this file.\n'
      : environmentText + (environmentText.endsWith('\n') ? '' : '\n')
    await writeFile(environmentPath, prefix + missing.map(([key, value]) => `${key}=${value}`).join('\n') + '\n', {
      mode: 0o600, flag: environmentText === null ? 'wx' : 'w',
    })
  }
  Object.assign(defaults, environment)
  for (const folder of ['config', 'auth', 'plugins', 'logs']) {
    await mkdir(resolve(directory, '.runtime/cpa', folder), { recursive: true, mode: 0o700 })
  }
  if (existingConfiguration === null) {
    // v8 layout from the pinned official config.example.yaml. Module bridge
    // channels are registered by the kernel layer after the database exists.
    const yaml = [
      '# CPA Nexus: managed through the admin adapter. Existing config is never reset by setup.',
      'config-version: 8',
      'server:',
      '  host: ""',
      '  port: 8317',
      'management:',
      '  allow-remote: true',
      '  secret-key: ' + JSON.stringify(defaults.CPA_MANAGEMENT_KEY),
      '  disable-control-panel: false',
      '  disable-auto-update-panel: true',
      'access:',
      '  api-keys:',
      '    - ' + JSON.stringify(defaults.CPA_CLIENT_KEY),
      'oauth:',
      '  auth-dir: "/root/.cli-proxy-api"',
      'api-keys:',
      '  openai-compatibility: []',
      'plugins:',
      '  enabled: true',
      '  dir: "/CLIProxyAPI/plugins"',
      'observability:',
      '  logs:',
      '    logging-to-file: false',
      '    request-log: false',
      '    logs-max-total-size-mb: 100',
      '    error-logs-max-files: 10',
      '  usage:',
      '    usage-statistics-enabled: true',
      '',
    ].join('\n')
    await writeFile(configurationPath, yaml, { mode: 0o600, flag: 'wx' })
  }
  log('CPA setup complete. Existing .env, credentials, config and data were preserved. CPA credentials are in .env.cpa; no secret was printed.')
  return { environmentPath, configurationPath }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  setupCpa().catch(error => { console.error(error.message); process.exitCode = 1 })
}
