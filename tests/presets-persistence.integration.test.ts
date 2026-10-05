import { randomUUID } from 'node:crypto'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { migrate } from '../server/lib/migrations'

const fixture = vi.hoisted(() => ({ sql: undefined as Sql | undefined }))
vi.mock('../server/lib/db', () => ({ getDb: () => fixture.sql }))
vi.mock('../server/lib/modules', () => ({ isModuleEnabled: async (id: string) => (await fixture.sql!`SELECT enabled FROM platform_modules WHERE id=${id}`)[0]?.enabled === true }))
vi.mock('../server/lib/cpa/preset-routing', () => ({ ensureCpaPresetAccountRoute: async () => { throw new Error('Native CPA account mutations are outside this database test') } }))
import { createPreset, deletePreset, getGroupPreset, getPreset, listKeyPresetBindings, listPresetBindings, listPresets, reorderGroupPresets, reorderPresets, resetPresetRouteCache, resolveKeyPresetRoute, resolveKeyPresetStack, resolvePresetRoute, saveKeyPresetMode, setGroupPresetBinding, setKeyPresetBinding, setPresetBinding, updatePreset } from '../server/lib/presets'
import { setKeyGroups } from '../server/lib/groups'

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

  it('persists key-specific routing, follows a changed module and cascades revoked keys', async () => {
    const keyA = randomUUID(), keyB = randomUUID()
    for (const [id, name] of [[keyA, 'KA'], [keyB, 'KB']]) {
      await sql`INSERT INTO gateway_keys(id,name,prefix,secret_hash,module_id) VALUES(${id!},${name!},'ccm_test',${randomUUID()},'commandcode')`
    }
    const preset = await createPreset({ name: 'Only KB', sourceJson: document, variables: { char: 'KB' } })
    await setKeyPresetBinding({ keyId: keyB, mode: 'preset', presetId: preset.id })
    expect(await resolveKeyPresetRoute(keyA)).toBeNull()
    expect((await resolveKeyPresetRoute(keyB))?.id).toBe(preset.id)
    await sql`UPDATE gateway_keys SET module_id='cpa' WHERE id=${keyB}`
    expect((await listKeyPresetBindings()).find(binding => binding.keyId === keyB)).toMatchObject({ moduleId: 'cpa', presetId: preset.id })
    await expect(deletePreset(preset.id)).rejects.toMatchObject({ statusCode: 409 })
    await expect(sql`DELETE FROM nexus_presets WHERE id=${preset.id}`).rejects.toMatchObject({ code: '23503' })
    await sql`DELETE FROM gateway_keys WHERE id=${keyB}`
    expect((await listKeyPresetBindings()).some(binding => binding.keyId === keyB)).toBe(false)
    resetPresetRouteCache()
    expect(await resolveKeyPresetRoute(keyB)).toBeNull()
    await deletePreset(preset.id)
  })

  it('archives previous account choices without leaving an uneditable preset deletion constraint', async () => {
    const preset = await createPreset({ name: 'Legacy archived', sourceJson: document, variables: { char: 'Legacy' } })
    await setPresetBinding({ moduleId: 'commandcode', mode: 'preset', presetId: preset.id })
    await sql`DELETE FROM schema_migrations WHERE name='010_key_preset_bindings.sql'`
    await migrate(sql)
    expect(await listPresetBindings()).toEqual([])
    expect((await sql`SELECT preset_id FROM nexus_legacy_preset_bindings WHERE module_id='commandcode' AND account_id=''`)[0]?.preset_id).toBe(preset.id)
    await deletePreset(preset.id)
    expect((await sql`SELECT preset_id FROM nexus_legacy_preset_bindings WHERE module_id='commandcode' AND account_id=''`)[0]?.preset_id).toBe(preset.id)
  })

  it('retains preset routing on cross-module group keys', async () => {
    const preset = await createPreset({ name: 'Auto key stack', sourceJson: document, variables: { char: 'Grouped' }, enabled: true })
    const keyId = randomUUID()
    await sql`INSERT INTO gateway_keys(id,name,prefix,secret_hash,module_id) VALUES(${keyId},'Cross-module key','ccm_test',${randomUUID()},'auto')`
    await setKeyPresetBinding({ keyId, mode: 'stack' })
    expect((await listKeyPresetBindings()).find(binding => binding.keyId === keyId)).toMatchObject({ moduleId: 'auto', mode: 'stack' })
    expect((await resolveKeyPresetStack(keyId)).some(item => item.id === preset.id)).toBe(true)
    await setKeyPresetBinding({ keyId, mode: 'bypass' })
    expect(await resolveKeyPresetStack(keyId)).toEqual([])
    await sql`DELETE FROM gateway_keys WHERE id=${keyId}`
    await deletePreset(preset.id)
  })

  it('persists shared enabled stack ordering and model-key choices atomically', async () => {
    const first = await createPreset({ name: 'Stack A', sourceJson: document, variables: { char: 'A' }, enabled: true })
    const second = await createPreset({ name: 'Stack B', sourceJson: document, variables: { char: 'B' }, enabled: true })
    const keyId = randomUUID()
    try {
      await sql.begin(async tx => {
        await tx`INSERT INTO gateway_keys(id,name,prefix,secret_hash,module_id) VALUES(${keyId},'Stack key','ccm_test',${randomUUID()},'cpa')`
        await saveKeyPresetMode(tx, keyId, true)
      })
      resetPresetRouteCache()
      expect((await resolveKeyPresetStack(keyId)).map(item => item.id)).toEqual([first.id, second.id])
      const library = await listPresets(), ids = [second.id, first.id, ...library.filter(item => ![first.id, second.id].includes(item.id)).map(item => item.id)]
      const ordered = await reorderPresets(ids)
      expect(ordered.map(item => item.id)).toEqual(ids)
      expect(ordered.every((item, index) => item.sortOrder === index)).toBe(true)
      expect((await resolveKeyPresetStack(keyId)).map(item => item.id)).toEqual([second.id, first.id])
      await expect(reorderPresets(ids.slice(1))).rejects.toMatchObject({ statusCode: 409 })
      await updatePreset(second.id, { enabled: false })
      expect((await resolveKeyPresetStack(keyId)).map(item => item.id)).toEqual([first.id])
      await expect(updatePreset(first.id, { variables: {} })).rejects.toMatchObject({ statusCode: 409 })
      await sql.begin(tx => saveKeyPresetMode(tx, keyId, false))
      resetPresetRouteCache()
      expect(await resolveKeyPresetStack(keyId)).toEqual([])
    } finally {
      await sql`DELETE FROM gateway_keys WHERE id=${keyId}`
      await deletePreset(first.id); await deletePreset(second.id)
    }
  })

  it('upgrades stored single-preset key choices to the shared stack and leaves bypass choices intact', async () => {
    const preset = await createPreset({ name: 'Before stack migration', sourceJson: document, variables: { char: 'Legacy key' } })
    const keyId = randomUUID(), directKeyId = randomUUID()
    try {
      for (const id of [keyId, directKeyId]) await sql`INSERT INTO gateway_keys(id,name,prefix,secret_hash,module_id) VALUES(${id},'Migration key','ccm_test',${randomUUID()},'cpa')`
      await setKeyPresetBinding({ keyId, mode: 'preset', presetId: preset.id })
      await setKeyPresetBinding({ keyId: directKeyId, mode: 'bypass' })
      await sql`DELETE FROM schema_migrations WHERE name='012_preset_stacks.sql'`
      await migrate(sql)
      resetPresetRouteCache()
      expect((await getPreset(preset.id)).enabled).toBe(true)
      expect((await listKeyPresetBindings()).find(item => item.keyId === keyId)).toMatchObject({ mode: 'stack', presetId: null })
      expect((await resolveKeyPresetStack(keyId)).map(item => item.id)).toEqual([preset.id])
      expect(await resolveKeyPresetStack(directKeyId)).toEqual([])
      await expect(sql`UPDATE nexus_key_preset_bindings SET preset_id=${preset.id} WHERE key_id=${keyId}`).rejects.toMatchObject({ code: '23514' })
    } finally {
      await sql`DELETE FROM gateway_keys WHERE id IN (${keyId},${directKeyId})`
      await deletePreset(preset.id)
    }
  })

  it('resolves independent group stacks and preserves group-specific prompt variables', async () => {
    const groupA = randomUUID(), groupB = randomUUID(), keyId = randomUUID()
    const first = await createPreset({ name: 'Group A preset', sourceJson: document, variables: { char: 'global' }, enabled: true })
    const second = await createPreset({ name: 'Group B preset', sourceJson: document, variables: { char: 'global-b' }, enabled: false })
    try {
      await sql`INSERT INTO nexus_groups(id,name) VALUES(${groupA},${'Group A ' + groupA.slice(0, 8)}),(${groupB},${'Group B ' + groupB.slice(0, 8)})`
      await sql`INSERT INTO gateway_keys(id,name,prefix,secret_hash,module_id) VALUES(${keyId},'Group stack key','ccm_test',${randomUUID()},'cpa')`
      await sql.begin(async tx => setKeyGroups(tx, keyId, [groupA, groupB]))
      await setKeyPresetBinding({ keyId, mode: 'stack' })
      await sql`UPDATE platform_modules SET enabled=true WHERE id='presets'`
      await setGroupPresetBinding({ groupId: groupA, presetId: first.id, enabled: true, sortOrder: 0, variables: { char: 'A only' } })
      await setGroupPresetBinding({ groupId: groupB, presetId: first.id, enabled: false, sortOrder: 0 })
      await setGroupPresetBinding({ groupId: groupB, presetId: second.id, enabled: true, sortOrder: 1, variables: { char: 'B only' } })
      resetPresetRouteCache()
      expect((await resolveKeyPresetStack(keyId)).map(item => item.id)).toEqual([first.id, second.id])
      expect((await getGroupPreset(groupA, first.id)).variables).toEqual({ char: 'A only' })
      expect((await listPresets(groupB)).find(item => item.id === second.id)).toMatchObject({ enabled: true, inherited: false })
      const groupLibrary = await listPresets()
      const groupOrder = [second.id, first.id, ...groupLibrary.map(item => item.id).filter(id => id !== first.id && id !== second.id)]
      await reorderGroupPresets(groupB, groupOrder)
      expect((await resolveKeyPresetStack(keyId)).map(item => item.id)).toEqual([first.id, second.id])
    } finally {
      await sql`DELETE FROM nexus_group_preset_bindings WHERE group_id IN (${groupA},${groupB})`
      await sql`DELETE FROM gateway_keys WHERE id=${keyId}`
      await sql`DELETE FROM nexus_groups WHERE id IN (${groupA},${groupB})`
      await deletePreset(first.id); await deletePreset(second.id)
      resetPresetRouteCache()
    }
  })
})
