import { randomUUID } from 'node:crypto'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { migrate } from '../server/lib/migrations'

const fixture = vi.hoisted(() => ({ sql: undefined as Sql | undefined }))
vi.mock('../server/lib/db', () => ({ getDb: () => fixture.sql }))
vi.mock('../server/lib/modules', () => ({ isModuleEnabled: async (id: string) => (await fixture.sql!`SELECT enabled FROM platform_modules WHERE id=${id}`)[0]?.enabled === true }))
vi.mock('../server/lib/cpa/preset-routing', () => ({ ensureCpaPresetAccountRoute: async () => { throw new Error('Native CPA account mutations are outside this database test') } }))
import { createPreset, deletePreset, getPreset, listPresetBindings, listPresets, resetPresetRouteCache, resolvePresetRoute, setPresetBinding, updatePreset } from '../server/lib/presets'

const databaseUrl = process.env.TEST_DATABASE_URL
const schema = 'nexus_presets_test_' + randomUUID().replaceAll('-', '')
const document = { prompts: [{ identifier: 'main', role: 'system', content: '{{char}}' }, { identifier: 'chatHistory', marker: true }, { identifier: 'jailbreak', role: 'system', content: 'Tail' }], prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }, { identifier: 'jailbreak', enabled: true }] }], extensions: {}, retained: { nested: ['original'] } }

describe.skipIf(!databaseUrl)('real PostgreSQL preset persistence and routing constraints', () => {
  let admin: Sql, sql: Sql, created = false
  beforeAll(async () => {
    admin = postgres(databaseUrl!, { max: 1, connect_timeout: 5, onnotice: () => {} })
    await admin`CREATE SCHEMA ${admin(schema)}`; created = true
    sql = postgres(databaseUrl!, { max: 3, connect_timeout: 5, onnotice: () => {}, connection: { search_path: schema } }); fixture.sql = sql
    await migrate(sql)
  }, 30_000)
  afterAll(async () => {
    resetPresetRouteCache()
    if (sql) await sql.end({ timeout: 5 })
    if (admin) { try { if (created && /^nexus_presets_test_[a-f0-9]{32}$/.test(schema)) await admin`DROP SCHEMA ${admin(schema)} CASCADE` } finally { await admin.end({ timeout: 5 }) } }
  }, 30_000)

  it('keeps the module opt-in and stores complete JSON through migration reruns and a fresh database connection', async () => {
    expect((await sql`SELECT enabled FROM platform_modules WHERE id='presets'`)[0]?.enabled).toBe(false)
    const preset = await createPreset({ name: 'Persisted', sourceJson: document, variables: { char: 'Explicit character' }, description: 'Imported JSON' })
    expect(preset.sourceJson).toEqual(document)
    expect(preset.compatibility.supported).toBe(true)
    await migrate(sql)
    await sql.end({ timeout: 5 })
    sql = postgres(databaseUrl!, { max: 3, connect_timeout: 5, onnotice: () => {}, connection: { search_path: schema } }); fixture.sql = sql
    expect(await getPreset(preset.id)).toMatchObject({ name: 'Persisted', sourceJson: document, variables: { char: 'Explicit character' }, description: 'Imported JSON' })
    const edited = await updatePreset(preset.id, { name: 'Edited', sourceJson: { ...document, temperature: 0.8 } })
    expect(edited.updatedAt >= preset.updatedAt).toBe(true)
    expect((await listPresets()).find(item => item.id === preset.id)?.sourceJson).toEqual({ ...document, temperature: 0.8 })
  })

  it('persists module fallback, account override and explicit bypass without making up account identities', async () => {
    const modulePreset = await createPreset({ name: 'Module', sourceJson: document, variables: { char: 'Module' } })
    const accountPreset = await createPreset({ name: 'Account', sourceJson: document, variables: { char: 'Account' } })
    const accountId = randomUUID()
    await sql`INSERT INTO managed_accounts(id,credential_fingerprint,cookie_ciphertext) VALUES(${accountId},${randomUUID()},'test-only-ciphertext')`
    await setPresetBinding({ moduleId: 'commandcode', mode: 'preset', presetId: modulePreset.id })
    expect(await resolvePresetRoute('commandcode', accountId)).toBeNull()
    await sql`UPDATE platform_modules SET enabled=true WHERE id='presets'`; resetPresetRouteCache()
    expect((await resolvePresetRoute('commandcode', accountId))?.id).toBe(modulePreset.id)
    await setPresetBinding({ moduleId: 'commandcode', accountId, mode: 'preset', presetId: accountPreset.id })
    expect((await resolvePresetRoute('commandcode', accountId))?.variables.char).toBe('Account')
    await setPresetBinding({ moduleId: 'commandcode', accountId, mode: 'bypass' })
    expect(await resolvePresetRoute('commandcode', accountId)).toBeNull()
    expect((await listPresetBindings()).find(binding => binding.accountId === accountId)).toMatchObject({ mode: 'bypass', presetId: null })
    await sql`DELETE FROM managed_accounts WHERE id=${accountId}`
    await setPresetBinding({ moduleId: 'commandcode', accountId, mode: 'inherit' })
    expect((await resolvePresetRoute('commandcode', accountId))?.id).toBe(modulePreset.id)
    await expect(setPresetBinding({ moduleId: 'commandcode', accountId, mode: 'bypass' })).rejects.toMatchObject({ statusCode: 404 })
  })

  it('protects bound presets in both API mutations and foreign-key enforcement', async () => {
    const preset = await createPreset({ name: 'Bound', sourceJson: document, variables: { char: 'Bound' } })
    await setPresetBinding({ moduleId: 'cpa', mode: 'preset', presetId: preset.id })
    await expect(deletePreset(preset.id)).rejects.toMatchObject({ statusCode: 409 })
    await expect(sql`DELETE FROM nexus_presets WHERE id=${preset.id}`).rejects.toMatchObject({ code: '23503' })
    await expect(updatePreset(preset.id, { variables: {} })).rejects.toMatchObject({ statusCode: 409 })
    expect((await getPreset(preset.id)).variables).toEqual({ char: 'Bound' })
    await setPresetBinding({ moduleId: 'cpa', mode: 'inherit' })
    await deletePreset(preset.id)
    await expect(getPreset(preset.id)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('serializes incompatible edits with new bindings so no active route points at a broken preset', async () => {
    const preset = await createPreset({ name: 'Concurrent', sourceJson: document, variables: { char: 'Concurrent' } })
    const results = await Promise.allSettled([
      updatePreset(preset.id, { variables: {} }),
      setPresetBinding({ moduleId: 'cpa', mode: 'preset', presetId: preset.id }),
    ])
    expect(results.some(result => result.status === 'rejected')).toBe(true)
    const bindings = await listPresetBindings(), current = await getPreset(preset.id)
    if (bindings.some(binding => binding.presetId === preset.id)) expect(current.compatibility.supported).toBe(true)
    else expect(current.compatibility.supported).toBe(false)
  })
})
