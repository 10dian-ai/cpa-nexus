import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_GROUP_ID } from '../shared/groups'

const fixture = vi.hoisted(() => ({ sql: undefined as Sql | undefined }))
vi.mock('../server/lib/db', () => ({ getDb: () => fixture.sql }))
vi.mock('../server/lib/events', () => ({ publishUpdate: async () => {} }))
import { accountGroupBindings, getDefaultModelKeyGroupIds, getModuleDefaultGroupIds, keyGroupBindings } from '../server/lib/groups'

const databaseUrl = process.env.TEST_DATABASE_URL
const migrationsBefore = async (sql: Sql, limit: string) => {
  for (const name of (await readdir('db/migrations')).filter(name => /^\d+.*\.sql$/.test(name) && name < limit).sort())
    await sql.unsafe(await readFile(path.resolve('db/migrations', name), 'utf8')).simple()
}
const run = async (sql: Sql, name: string) => sql.unsafe(await readFile(path.resolve('db/migrations', name), 'utf8')).simple()

function scoped(prefix: string) {
  const schema = prefix + randomUUID().replaceAll('-', '')
  const state = { admin: undefined as Sql | undefined, sql: undefined as Sql | undefined, created: false }
  return {
    schema, state,
    async open() {
      state.admin = postgres(databaseUrl!, { max: 1, connect_timeout: 5, onnotice: () => {} })
      await state.admin`CREATE SCHEMA ${state.admin(schema)}`; state.created = true
      state.sql = postgres(databaseUrl!, { max: 1, connect_timeout: 5, onnotice: () => {}, connection: { search_path: schema } })
      fixture.sql = state.sql
      return state.sql
    },
    async close() {
      if (state.sql) await state.sql.end({ timeout: 5 })
      if (state.admin) { try { if (state.created) await state.admin`DROP SCHEMA ${state.admin(schema)} CASCADE` } finally { await state.admin.end({ timeout: 5 }) } }
    },
  }
}

describe.skipIf(!databaseUrl)('migration 021: CommandCode removed, Logicc added (PostgreSQL)', () => {
  const db = scoped('nexus_logicc_upgrade_')
  let sql: Sql, commandcodeGroup: string, cpaGroup: string
  const account = randomUUID(), clientKey = randomUUID(), cpaKey = randomUUID(), bridgeKey = randomUUID(), serviceKey = randomUUID()
  const ccLog = randomUUID(), oldCpaLog = randomUUID(), cpaLog = randomUUID(), customGroup = randomUUID()
  beforeAll(async () => {
    sql = await db.open()
    await migrationsBefore(sql, '021')
    const defaults = await sql`SELECT module_id,group_id FROM nexus_module_group_defaults`
    commandcodeGroup = String(defaults.find(row => row.module_id === 'commandcode')!.group_id)
    cpaGroup = String(defaults.find(row => row.module_id === 'cpa')!.group_id)
    await sql`INSERT INTO nexus_groups(id,name) VALUES(${customGroup},'Team')`
    await sql`INSERT INTO managed_accounts(id,credential_fingerprint,cookie_ciphertext) VALUES(${account},${randomUUID()},'cc-cookie')`
    await sql`INSERT INTO nexus_account_groups(module_id,account_id,group_id) VALUES('cpa','codex.json',${cpaGroup}),('cpa','codex.json',${customGroup})`
    await sql`INSERT INTO gateway_keys(id,name,prefix,secret_hash,module_id) VALUES
      (${clientKey},'client','ccm_client',${randomUUID()},'commandcode'),(${cpaKey},'cpa','ccm_cpa',${randomUUID()},'cpa'),
      (${bridgeKey},'bridge','ccm_nexus_abc',${randomUUID()},'commandcode')`
    await sql`DELETE FROM nexus_key_groups WHERE key_id=${clientKey}`
    await sql`INSERT INTO nexus_key_groups(key_id,group_id,position) VALUES(${clientKey},${commandcodeGroup},0),(${clientKey},${customGroup},1)`
    await sql`INSERT INTO request_logs(id,key_id,account_id,model,protocol,status,duration_ms) VALUES(${ccLog},${clientKey},${account},'cc','chat/completions','success',1)`
    await sql`INSERT INTO request_logs(id,key_id,model,protocol,status,duration_ms) VALUES(${oldCpaLog},${cpaKey},'old-cpa','chat/completions','success',1)`
    await sql`INSERT INTO request_logs(id,key_id,model,protocol,status,duration_ms,module_id,source_id) VALUES(${cpaLog},${cpaKey},'cpa','chat/completions','success',1,'cpa','codex.json')`
    await sql`INSERT INTO service_keys(id,name,prefix,secret_hash) VALUES(${serviceKey},'importer','ccm_service_x',${randomUUID()})`
    await run(sql, '021_logicc_module.sql')
  }, 60_000)
  afterAll(() => db.close(), 30_000)

  it('turns the CommandCode default group into the Logicc group, keeping its ID and every key that used it', async () => {
    const defaults = await getModuleDefaultGroupIds()
    expect(defaults).toEqual({ cpa: cpaGroup, logicc: commandcodeGroup })
    expect((await sql`SELECT name FROM nexus_groups WHERE id=${commandcodeGroup}`)[0]?.name).toBe('Logicc')
    expect(new Set((await keyGroupBindings([clientKey])).get(clientKey)?.groupIds)).toEqual(new Set([commandcodeGroup, customGroup]))
    expect(new Set(await getDefaultModelKeyGroupIds())).toEqual(new Set([cpaGroup, commandcodeGroup]))
  })

  it('removes CommandCode data but keeps CPA sources, CPA history and every client key', async () => {
    expect((await sql`SELECT to_regclass('managed_accounts') AS table`)[0]?.table).toBeNull()
    expect((await sql`SELECT count(*)::int AS count FROM nexus_account_groups WHERE module_id='commandcode'`)[0]?.count).toBe(0)
    expect(new Set((await accountGroupBindings('cpa', ['codex.json'])).get('codex.json')?.groupIds)).toEqual(new Set([cpaGroup, customGroup]))
    expect((await sql`SELECT id FROM request_logs ORDER BY model`).map(row => row.id).sort()).toEqual([oldCpaLog, cpaLog].sort())
    const keys = await sql`SELECT id,module_id FROM gateway_keys ORDER BY name`
    expect(keys.map(row => [row.id, row.module_id])).toEqual([[clientKey, 'auto'], [cpaKey, 'cpa']])
    expect((await sql`SELECT module_ids FROM service_keys WHERE id=${serviceKey}`)[0]?.module_ids).toEqual(['logicc', 'cpa'])
  })

  it('binds new Logicc accounts to the Logicc group and cleans up after deletion', async () => {
    const id = randomUUID()
    await sql`INSERT INTO logicc_accounts(id,session_id,client_cookie_ciphertext) VALUES(${id},'sess_abcdefgh','encrypted')`
    expect((await accountGroupBindings('logicc', [id])).get(id)?.groupIds).toEqual([commandcodeGroup])
    await sql`DELETE FROM logicc_accounts WHERE id=${id}`
    expect((await accountGroupBindings('logicc', [id])).has(id)).toBe(false)
    await expect(sql`INSERT INTO logicc_accounts(id,session_id) VALUES(${randomUUID()},'sess_nocredential')`).rejects.toMatchObject({ code: '23514' })
    await expect(sql`INSERT INTO nexus_account_groups(module_id,account_id,group_id) VALUES('commandcode','x',${DEFAULT_GROUP_ID})`).rejects.toMatchObject({ code: '23514' })
  })
})

describe.skipIf(!databaseUrl)('fresh install creates the Logicc group (PostgreSQL)', () => {
  const db = scoped('nexus_logicc_fresh_')
  let sql: Sql
  beforeAll(async () => { sql = await db.open(); await migrationsBefore(sql, '999') }, 60_000)
  afterAll(() => db.close(), 30_000)

  it('has CPA and Logicc default groups and gives new model keys both', async () => {
    const defaults = await getModuleDefaultGroupIds()
    expect((await sql`SELECT name FROM nexus_groups WHERE id=${defaults.logicc}`)[0]?.name).toBe('Logicc')
    expect(defaults.cpa).not.toBe(defaults.logicc)
    expect(new Set(await getDefaultModelKeyGroupIds())).toEqual(new Set([defaults.cpa, defaults.logicc]))
  })
})
