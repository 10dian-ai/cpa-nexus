import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'

export const CPA_VERSION = 'v8.0.11'
export const CPA_IMAGE = 'cpa-nexus-core:v8.0.11-nexus1'
export const CPA_UPSTREAM_REF = 'e2bff0107bb307337aaa19018ccddd55f64253d5'
export const CPA_UPSTREAM_IMAGE = 'eceasy/cli-proxy-api:v8.0.11@sha256:1d7f8c154a9804ba33c5332bf76cdb3a05791d6fd275ccad8f2a63859ab25df9'

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
  // Upgrade only the project's former pinned default after validating its keys.
  if (environment.CPA_IMAGE === CPA_UPSTREAM_IMAGE && environment.CPA_VERSION === CPA_VERSION) {
    environmentText = environmentText.replace(/^(?:export\s+)?CPA_IMAGE\s*=.*$/m, 'CPA_IMAGE=' + CPA_IMAGE)
    environment.CPA_IMAGE = CPA_IMAGE
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
    CPA_COMMANDCODE_BASE_URL: 'http://app:3000/v1',
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
    // v8 layout from the pinned official config.example.yaml. The bridge is
    // registered through authenticated reconciliation after the database exists.
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
