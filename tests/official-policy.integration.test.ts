import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { OfficialCatalogView } from '../shared/official-catalog'
import { migrate } from '../server/lib/migrations'
import { buildCatalog, OFFICIAL_SOURCES, type SourceState } from '../server/lib/official-catalog/service'
import { parseOfficialDocument, parseProviderModels, parseWebsiteModels } from '../server/lib/official-catalog/parser'

const fixture = vi.hoisted(() => ({ sql: undefined as Sql | undefined }))
vi.mock('../server/lib/db', () => ({ getDb: () => fixture.sql }))
vi.mock('../server/lib/redis', () => ({ getRedis: () => ({ set: async () => 'OK' }) }))
vi.mock('../server/lib/events', () => ({ publishUpdate: async () => {} }))
import { materializeGoatCatalog } from '../server/lib/official-catalog/refresh'

const databaseUrl = process.env.TEST_DATABASE_URL
const schema = 'nexus_official_policy_' + randomUUID().replaceAll('-', '')
const cutoff = '2026-10-04T04:00:00.000Z'
function sources(): SourceState[] {
  const read = (name: string) => readFileSync(new URL('./fixtures/official-catalog/' + name, import.meta.url), 'utf8')
  return OFFICIAL_SOURCES.map(definition => {
    const payload = definition.kind === 'provider-models' ? parseProviderModels(read('provider-models.json')) : definition.kind === 'website-models' ? parseWebsiteModels(read('models.html')) : parseOfficialDocument(read(definition.kind + '.html'), definition.kind)
    return { id: definition.id, url: definition.url, payload, fetchedAt: cutoff, lastAttemptAt: cutoff, etag: null, lastModified: null, error: null, modelCount: null }
  })
}

describe.skipIf(!databaseUrl)('official scope changes on real PostgreSQL observations', () => {
  let admin: Sql, sql: Sql, created = false, previous: OfficialCatalogView, updated: OfficialCatalogView
  let oldGoat: string, freshGoat: string, pro: string, unknown: string
  const newlyIncluded = 'claude-opus-5-5', stillExcluded = 'claude-opus-5'
  beforeAll(async () => {
    admin = postgres(databaseUrl!, { max: 1, onnotice: () => {} }); await admin`CREATE SCHEMA ${admin(schema)}`; created = true
    sql = postgres(databaseUrl!, { max: 1, onnotice: () => {}, connection: { search_path: schema } }); fixture.sql = sql
    await migrate(sql)
    const parsed = sources(); previous = buildCatalog(parsed, Date.parse(cutoff))
    parsed.find(source => source.id === 'goat')!.payload!.scope!.push(newlyIncluded)
    updated = buildCatalog(parsed, Date.parse(cutoff))
    oldGoat = randomUUID(); freshGoat = randomUUID(); pro = randomUUID(); unknown = randomUUID()
    for (const [id, planId] of [[oldGoat, 'individual-goat'], [freshGoat, 'goat'], [pro, 'individual-pro'], [unknown, null]] as const) {
      await sql`INSERT INTO managed_accounts(id,credential_fingerprint,cookie_ciphertext,api_key_ciphertext,status,snapshot)
        VALUES(${id},${randomUUID()},'test-cookie','test-key','ready',${sql.json({ subscription: { planId }, credits: {}, windowLimits: null })})`
      await sql`INSERT INTO account_models(account_id,model_id,status,observation_scope,last_checked_at)
        VALUES(${id},${newlyIncluded},'denied','official-provider',${id === freshGoat ? '2026-10-04T04:00:01.000Z' : '2026-10-04T03:59:59.000Z'})`
    }
    await sql`INSERT INTO account_models(account_id,model_id,status,observation_scope,last_checked_at)
      VALUES(${oldGoat},${stillExcluded},'denied','official-provider','2026-10-04T03:59:59.000Z')`
  }, 30_000)
  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 })
    if (admin) { try { if (created && /^nexus_official_policy_[a-f0-9]{32}$/.test(schema)) await admin`DROP SCHEMA ${admin(schema)} CASCADE` } finally { await admin.end({ timeout: 5 }) } }
  }, 30_000)
  it('reconsiders old denials only for accounts whose effective plan gained the exact model', async () => {
    expect(await materializeGoatCatalog(updated, previous)).toBe(64)
    const rows = await sql`SELECT account_id,observation_scope FROM account_models WHERE model_id=${newlyIncluded}`
    const scope = new Map(rows.map(row => [row.account_id, row.observation_scope]))
    expect(scope.get(oldGoat)).toBe('superseded-official-scope')
    expect(scope.get(unknown)).toBe('superseded-official-scope')
    expect(scope.get(freshGoat)).toBe('official-provider')
    expect(scope.get(pro)).toBe('official-provider')
    expect((await sql`SELECT observation_scope FROM account_models WHERE model_id=${stillExcluded}`)[0]?.observation_scope).toBe('official-provider')
    expect((await sql`SELECT model_id FROM model_catalog WHERE model_id=${newlyIncluded}`)[0]?.model_id).toBe(newlyIncluded)
  })
  it('keeps a new real denial after the permission change and preserves native account data', async () => {
    await sql`UPDATE account_models SET observation_scope='official-provider',last_checked_at='2026-10-04T04:00:02.000Z' WHERE account_id=${oldGoat} AND model_id=${newlyIncluded}`
    await materializeGoatCatalog(updated, previous)
    expect((await sql`SELECT observation_scope FROM account_models WHERE account_id=${oldGoat} AND model_id=${newlyIncluded}`)[0]?.observation_scope).toBe('official-provider')
    expect((await sql`SELECT COUNT(*)::int AS total FROM managed_accounts`)[0]?.total).toBe(4)
  })
})
