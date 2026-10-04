import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_GROUP_ID } from '../shared/groups'

const fixture = vi.hoisted(() => ({ sql: undefined as Sql | undefined }))
vi.mock('../server/lib/db', () => ({ getDb: () => fixture.sql }))
vi.mock('../server/lib/events', () => ({ publishUpdate: async () => {} }))
import { accountGroupBindings, deleteGroup, ensureAccountGroups, getDefaultModelKeyGroupIds, getModuleDefaultGroupIds, keyGroupBindings, patchGroup, setAccountGroups, setKeyGroups } from '../server/lib/groups'

const databaseUrl = process.env.TEST_DATABASE_URL
const schema = 'nexus_module_defaults_' + randomUUID().replaceAll('-', '')
describe.skipIf(!databaseUrl)('module default group upgrade on PostgreSQL', () => {
  let sql: Sql, admin: Sql, created = false, migration: string
  let defaults: { commandcode: string; cpa: string }
  const customGroup = randomUUID(), existingCommandcodeGroup = randomUUID()
  const defaultAccount = randomUUID(), mixedAccount = randomUUID(), customAccount = randomUUID()
  const defaultKey = randomUUID(), customKey = randomUUID(), bridgeKey = randomUUID()
  beforeAll(async () => {
    admin = postgres(databaseUrl!, { max: 1, connect_timeout: 5, onnotice: () => {} })
    await admin`CREATE SCHEMA ${admin(schema)}`; created = true
    sql = postgres(databaseUrl!, { max: 1, connect_timeout: 5, onnotice: () => {}, connection: { search_path: schema } }); fixture.sql = sql
    for (const name of (await readdir('db/migrations')).filter(name => /^\d+.*\.sql$/.test(name) && name < '015').sort()) await sql.unsafe(await readFile(path.resolve('db/migrations', name), 'utf8')).simple()
    await sql`INSERT INTO nexus_groups(id,name) VALUES(${customGroup},'Custom source group'),(${existingCommandcodeGroup},'CommandCode')`
    await sql`INSERT INTO managed_accounts(id,credential_fingerprint,cookie_ciphertext) VALUES
      (${defaultAccount},${randomUUID()},'default-test-cookie'),(${mixedAccount},${randomUUID()},'mixed-test-cookie'),(${customAccount},${randomUUID()},'custom-test-cookie')`
    await sql`INSERT INTO nexus_account_groups(module_id,account_id,group_id) VALUES
      ('commandcode',${mixedAccount},${customGroup}),('commandcode',${customAccount},${customGroup}),
      ('cpa','default-oauth.json',${DEFAULT_GROUP_ID}),('cpa','mixed-oauth.json',${DEFAULT_GROUP_ID}),('cpa','mixed-oauth.json',${customGroup}),('cpa','custom-oauth.json',${customGroup})`
    await sql`DELETE FROM nexus_account_groups WHERE module_id='commandcode' AND account_id=${customAccount} AND group_id=${DEFAULT_GROUP_ID}`
    await sql`INSERT INTO gateway_keys(id,name,prefix,secret_hash,module_id) VALUES
      (${defaultKey},'Old global model key','ccm_oldglobal',${randomUUID()},'auto'),(${customKey},'Custom model key','ccm_custom',${randomUUID()},'auto'),(${bridgeKey},'Internal bridge','ccm_nexus_',${randomUUID()},'commandcode')`
    await sql`INSERT INTO nexus_key_groups(key_id,group_id) VALUES(${defaultKey},${customGroup}),(${customKey},${customGroup})`
    await sql`DELETE FROM nexus_key_groups WHERE key_id=${customKey} AND group_id=${DEFAULT_GROUP_ID}`
    migration = await readFile(path.resolve('db/migrations/015_module_group_defaults.sql'), 'utf8')
    await sql.unsafe(migration).simple()
    defaults = await getModuleDefaultGroupIds()
  }, 30_000)
  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 })
    if (admin) { try { if (created && /^nexus_module_defaults_[a-f0-9]{32}$/.test(schema)) await admin`DROP SCHEMA ${admin(schema)} CASCADE` } finally { await admin.end({ timeout: 5 }) } }
  }, 30_000)

  it('reuses an existing same-named group and splits sources by module without changing credentials', async () => {
    expect(defaults.commandcode).toBe(existingCommandcodeGroup)
    expect(defaults.cpa).not.toBe(defaults.commandcode)
    expect((await accountGroupBindings('commandcode', [defaultAccount])).get(defaultAccount)?.groupIds).toEqual([defaults.commandcode])
    expect((await accountGroupBindings('cpa', ['default-oauth.json'])).get('default-oauth.json')?.groupIds).toEqual([defaults.cpa])
    expect((await sql`SELECT cookie_ciphertext FROM managed_accounts WHERE id=${defaultAccount}`)[0]?.cookie_ciphertext).toBe('default-test-cookie')
    expect((await sql`SELECT count(*)::int AS count FROM nexus_groups WHERE name='CommandCode'`)[0]?.count).toBe(1)
  })
  it('retains custom groups and the old model key union while leaving the internal bridge alone', async () => {
    expect(new Set((await accountGroupBindings('commandcode', [mixedAccount])).get(mixedAccount)?.groupIds)).toEqual(new Set([customGroup,defaults.commandcode]))
    expect((await accountGroupBindings('commandcode', [customAccount])).get(customAccount)?.groupIds).toEqual([customGroup])
    expect(new Set((await accountGroupBindings('cpa', ['mixed-oauth.json'])).get('mixed-oauth.json')?.groupIds)).toEqual(new Set([customGroup,defaults.cpa]))
    expect((await accountGroupBindings('cpa', ['custom-oauth.json'])).get('custom-oauth.json')?.groupIds).toEqual([customGroup])
    expect(new Set((await keyGroupBindings([defaultKey])).get(defaultKey)?.groupIds)).toEqual(new Set([defaults.cpa,defaults.commandcode,customGroup]))
    expect((await keyGroupBindings([customKey])).get(customKey)?.groupIds).toEqual([customGroup])
    expect((await keyGroupBindings([bridgeKey])).has(bridgeKey)).toBe(false)
  })
  it('binds raw imports, discovered CPA sources and omitted API selections to their persistent defaults', async () => {
    const account = randomUUID(), key = randomUUID(), internal = randomUUID()
    await sql`INSERT INTO managed_accounts(id,credential_fingerprint,cookie_ciphertext) VALUES(${account},${randomUUID()},'new-test-cookie')`
    await sql`INSERT INTO gateway_keys(id,name,prefix,secret_hash,module_id) VALUES(${key},'New model key','ccm_new',${randomUUID()},'auto'),(${internal},'New bridge','ccm_nexus_new',${randomUUID()},'commandcode')`
    await ensureAccountGroups(sql, 'cpa', 'new-oauth.json')
    expect((await accountGroupBindings('commandcode', [account])).get(account)?.groupIds).toEqual([defaults.commandcode])
    expect((await accountGroupBindings('cpa', ['new-oauth.json'])).get('new-oauth.json')?.groupIds).toEqual([defaults.cpa])
    expect(new Set((await keyGroupBindings([key])).get(key)?.groupIds)).toEqual(new Set(await getDefaultModelKeyGroupIds()))
    expect((await keyGroupBindings([internal])).has(internal)).toBe(false)
    await setAccountGroups(sql, 'cpa', 'api-default.json')
    await setAccountGroups(sql, 'commandcode', account)
    await setKeyGroups(sql, key)
    expect((await accountGroupBindings('cpa', ['api-default.json'])).get('api-default.json')?.groupIds).toEqual([defaults.cpa])
    expect((await accountGroupBindings('commandcode', [account])).get(account)?.groupIds).toEqual([defaults.commandcode])
    expect(new Set((await keyGroupBindings([key])).get(key)?.groupIds)).toEqual(new Set([defaults.cpa,defaults.commandcode]))
  })
  it('keeps explicit groups reusable across modules and does not overwrite them during source discovery', async () => {
    await setAccountGroups(sql, 'cpa', 'shared-oauth.json', [customGroup,defaults.commandcode])
    await ensureAccountGroups(sql, 'cpa', 'shared-oauth.json')
    expect(new Set((await accountGroupBindings('cpa', ['shared-oauth.json'])).get('shared-oauth.json')?.groupIds)).toEqual(new Set([customGroup,defaults.commandcode]))
  })
  it('preserves group IDs after renaming and safely reapplies the migration without restoring old key permissions', async () => {
    await patchGroup(defaults.commandcode, { name: 'Renamed CommandCode pool' })
    await patchGroup(defaults.cpa, { name: 'Renamed CPA pool' })
    await setKeyGroups(sql, defaultKey, [customGroup])
    const count = (await sql`SELECT count(*)::int AS count FROM nexus_groups`)[0]?.count
    await sql.unsafe(migration).simple()
    expect(await getModuleDefaultGroupIds()).toEqual(defaults)
    expect((await sql`SELECT count(*)::int AS count FROM nexus_groups`)[0]?.count).toBe(count)
    expect((await keyGroupBindings([defaultKey])).get(defaultKey)?.groupIds).toEqual([customGroup])
    await ensureAccountGroups(sql, 'cpa', 'after-rename.json')
    expect((await accountGroupBindings('cpa', ['after-rename.json'])).get('after-rename.json')?.groupIds).toEqual([defaults.cpa])
  })
  it('protects module default groups through the API guard and the database foreign key', async () => {
    await expect(deleteGroup(defaults.commandcode)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('模块默认调用组') })
    await expect(deleteGroup(defaults.cpa)).rejects.toMatchObject({ statusCode: 409 })
    await sql`DELETE FROM nexus_account_groups WHERE group_id=${defaults.cpa}`
    await sql`DELETE FROM nexus_key_groups WHERE group_id=${defaults.cpa}`
    await expect(sql`DELETE FROM nexus_groups WHERE id=${defaults.cpa}`).rejects.toMatchObject({ code: '23503' })
  })
})

const renamedSchema = 'nexus_renamed_defaults_' + randomUUID().replaceAll('-', '')
describe.skipIf(!databaseUrl)('upgrade of the user-renamed commandcode global group', () => {
  let sql: Sql, admin: Sql, created = false, migration: string, cpaDefault: string
  const account = randomUUID(), key = randomUUID()
  beforeAll(async () => {
    admin = postgres(databaseUrl!, { max: 1, connect_timeout: 5, onnotice: () => {} })
    await admin`CREATE SCHEMA ${admin(renamedSchema)}`; created = true
    sql = postgres(databaseUrl!, { max: 1, connect_timeout: 5, onnotice: () => {}, connection: { search_path: renamedSchema } }); fixture.sql = sql
    for (const name of (await readdir('db/migrations')).filter(name => /^\d+.*\.sql$/.test(name) && name < '015').sort()) await sql.unsafe(await readFile(path.resolve('db/migrations', name), 'utf8')).simple()
    await sql`UPDATE nexus_groups SET name='commandcode' WHERE id=${DEFAULT_GROUP_ID}`
    await sql`INSERT INTO managed_accounts(id,credential_fingerprint,cookie_ciphertext) VALUES(${account},${randomUUID()},'renamed-group-test-cookie')`
    await sql`INSERT INTO nexus_account_groups(module_id,account_id,group_id) VALUES('cpa','codex.json',${DEFAULT_GROUP_ID}),('cpa','plugin:google',${DEFAULT_GROUP_ID}),('cpa','plugin:basispoints',${DEFAULT_GROUP_ID})`
    await sql`INSERT INTO gateway_keys(id,name,prefix,secret_hash,module_id) VALUES(${key},'Existing model key','ccm_existing',${randomUUID()},'auto')`
    migration = await readFile(path.resolve('db/migrations/015_module_group_defaults.sql'), 'utf8')
    await sql.unsafe(migration).simple()
    cpaDefault = (await getModuleDefaultGroupIds()).cpa
  }, 30_000)
  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 })
    if (admin) { try { if (created && /^nexus_renamed_defaults_[a-f0-9]{32}$/.test(renamedSchema)) await admin`DROP SCHEMA ${admin(renamedSchema)} CASCADE` } finally { await admin.end({ timeout: 5 }) } }
  }, 30_000)
  it('reuses the renamed global ID for CommandCode and retains both modules on the existing key', async () => {
    expect(await getModuleDefaultGroupIds()).toEqual({ commandcode: DEFAULT_GROUP_ID, cpa: cpaDefault })
    expect(cpaDefault).not.toBe(DEFAULT_GROUP_ID)
    expect((await sql`SELECT count(*)::int AS count FROM nexus_groups WHERE lower(name)='commandcode'`)[0]?.count).toBe(1)
    expect((await accountGroupBindings('commandcode', [account])).get(account)?.groupIds).toEqual([DEFAULT_GROUP_ID])
    const sources = await accountGroupBindings('cpa')
    for (const source of ['codex.json','plugin:google','plugin:basispoints']) expect(sources.get(source)?.groupIds).toEqual([cpaDefault])
    expect(new Set((await keyGroupBindings([key])).get(key)?.groupIds)).toEqual(new Set([DEFAULT_GROUP_ID,cpaDefault]))
  })
  it('does not reinterpret explicit cross-module use or restore key scope when the SQL is run again', async () => {
    await setAccountGroups(sql, 'cpa', 'cross-module.json', [DEFAULT_GROUP_ID])
    await setKeyGroups(sql, key, [DEFAULT_GROUP_ID])
    await sql.unsafe(migration).simple()
    expect((await accountGroupBindings('cpa', ['cross-module.json'])).get('cross-module.json')?.groupIds).toEqual([DEFAULT_GROUP_ID])
    expect((await keyGroupBindings([key])).get(key)?.groupIds).toEqual([DEFAULT_GROUP_ID])
    const newAccount = randomUUID(), newKey = randomUUID()
    await sql`INSERT INTO managed_accounts(id,credential_fingerprint,cookie_ciphertext) VALUES(${newAccount},${randomUUID()},'new-test-cookie')`
    await sql`INSERT INTO gateway_keys(id,name,prefix,secret_hash) VALUES(${newKey},'New default','ccm_newdefault',${randomUUID()})`
    expect((await accountGroupBindings('commandcode', [newAccount])).get(newAccount)?.groupIds).toEqual([DEFAULT_GROUP_ID])
    expect(new Set((await keyGroupBindings([newKey])).get(newKey)?.groupIds)).toEqual(new Set([DEFAULT_GROUP_ID,cpaDefault]))
  })
})
