import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import postgres, { type Sql } from 'postgres'
import Redis from 'ioredis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { migrate } from '../server/lib/migrations'
import { DEFAULT_GROUP_ID } from '../shared/groups'

const fixture = vi.hoisted(() => ({ sql: undefined as Sql | undefined }))
vi.mock('../server/lib/db', () => ({ getDb: () => fixture.sql }))
vi.mock('../server/lib/events', () => ({ publishUpdate: async () => {} }))
vi.mock('../server/lib/official-catalog', () => ({ getOfficialCatalog: async () => ({ models: [
  ...[
    { id: 'same/model', name: 'Shared', providerAvailable: true, supportedEndpoints: ['chat/completions'] },
    { id: 'a/model', name: 'Only A', providerAvailable: true, supportedEndpoints: ['chat/completions'] },
    { id: 'b/model', name: 'Only B', providerAvailable: true, supportedEndpoints: ['messages'] },
  ].map(model => ({ ...model, planAccess: { goat: { included: true, apiAccess: true }, pro: { included: true, apiAccess: true }, go: { included: true, apiAccess: false } } })),
  { id: 'premium/model', name: 'Premium', providerAvailable: true, supportedEndpoints: ['messages'], planAccess: { goat: { included: false, apiAccess: true }, pro: { included: true, apiAccess: true }, go: { included: false, apiAccess: false } } },
] }) }))
import { assertGroupIds, createGroup, deleteGroup, patchGroup, setAccountGroups, setKeyGroups, resolveEnabledKeyGroupIds, accountGroupBindings, keyGroupBindings, getModuleDefaultGroupIds, getDefaultModelKeyGroupIds } from '../server/lib/groups'
import { listAvailableCommandcodeModels, listCandidates, listGatewayModels } from '../server/lib/gateway/accounts'
import { acquireLease, releaseLease } from '../server/lib/gateway/scheduler'
import { attachIdentity, createPendingAccount } from '../server/lib/accounts'

const databaseUrl = process.env.TEST_DATABASE_URL
const redisUrl = process.env.TEST_REDIS_URL
const schema = 'nexus_groups_test_' + randomUUID().replaceAll('-', '')
describe.skipIf(!databaseUrl)('group routing on real PostgreSQL data', () => {
  let sql: Sql, admin: Sql, created = false
  let accountA: string, accountB: string, accountDefault: string, keyA: string, keyB: string, groupA: string, groupB: string, bridge: string
  beforeAll(async () => {
    admin = postgres(databaseUrl!, { max: 1, connect_timeout: 5, onnotice: () => {} })
    await admin`CREATE SCHEMA ${admin(schema)}`; created = true
    sql = postgres(databaseUrl!, { max: 1, connect_timeout: 5, onnotice: () => {}, connection: { search_path: schema } }); fixture.sql = sql
    // Exercise migration against existing accounts, separately bound legacy keys and an internal bridge.
    for (const name of (await readdir('db/migrations')).filter(name => /^\d+.*\.sql$/.test(name) && name < '013').sort()) await sql.unsafe(await readFile(path.resolve('db/migrations', name), 'utf8')).simple()
    accountDefault = randomUUID(); keyA = randomUUID(); keyB = randomUUID(); bridge = randomUUID()
    await sql`INSERT INTO managed_accounts(id,credential_fingerprint,cookie_ciphertext,api_key_ciphertext,status) VALUES(${accountDefault},${randomUUID()},'test-cookie','default-key','ready')`
    await sql`INSERT INTO gateway_keys(id,name,prefix,secret_hash,module_id) VALUES
      (${keyA},'A key','ccm_A',${randomUUID()},'commandcode'),(${keyB},'B key','ccm_B',${randomUUID()},'cpa'),(${bridge},'Bridge','ccm_nexus_',${randomUUID()},'commandcode')`
    await migrate(sql)
    expect((await sql`SELECT module_id FROM gateway_keys WHERE id IN (${keyA},${keyB})`).map(row => row.module_id)).toEqual(['auto','auto'])
    expect((await sql`SELECT module_id FROM gateway_keys WHERE id=${bridge}`)[0]?.module_id).toBe('commandcode')
    expect(new Set((await keyGroupBindings([keyA])).get(keyA)?.groupIds)).toEqual(new Set(await getDefaultModelKeyGroupIds()))
    expect((await accountGroupBindings('commandcode', [accountDefault])).get(accountDefault)?.groupIds).toEqual([(await getModuleDefaultGroupIds()).commandcode])
    groupA = (await createGroup({ name: 'Account A group' })).id; groupB = (await createGroup({ name: 'Account B group' })).id
    accountA = randomUUID(); accountB = randomUUID()
    await sql`INSERT INTO managed_accounts(id,credential_fingerprint,cookie_ciphertext,api_key_ciphertext,status,group_name) VALUES
      (${accountA},${randomUUID()},'test-cookie','A-upstream-key','ready','same-legacy-label'),
      (${accountB},${randomUUID()},'test-cookie','B-upstream-key','ready','same-legacy-label')`
    await sql.begin(async tx => {
      await setAccountGroups(tx, 'commandcode', accountA, [groupA]); await setAccountGroups(tx, 'commandcode', accountB, [groupB])
      await setKeyGroups(tx, keyA, [groupA]); await setKeyGroups(tx, keyB, [groupB])
    })
    await sql`INSERT INTO model_catalog(model_id,name) VALUES('same/model','Shared'),('a/model','Only A'),('b/model','Only B')`
    await sql`INSERT INTO account_models(account_id,model_id,status,observation_scope) VALUES
      (${accountA},'b/model','denied','official-provider'),(${accountB},'a/model','denied','official-provider')`
  }, 30_000)
  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 })
    if (admin) { try { if (created && /^nexus_groups_test_[a-f0-9]{32}$/.test(schema)) await admin`DROP SCHEMA ${admin(schema)} CASCADE` } finally { await admin.end({ timeout: 5 }) } }
  }, 30_000)
  it('routes two keys to separate accounts even with identical legacy group labels', async () => {
    expect((await listCandidates('same/model', keyA)).map(account => account.id)).toEqual([accountA])
    expect((await listCandidates('same/model', keyB)).map(account => account.id)).toEqual([accountB])
    expect((await listCandidates('same/model', bridge)).map(account => account.id)).toEqual([accountDefault])
  })
  it('returns only the models callable by accounts inside the selected key groups', async () => {
    expect((await listGatewayModels(keyA)).data.map(model => model.id)).toEqual(['a/model','same/model'])
    expect((await listGatewayModels(keyB)).data.map(model => model.id)).toEqual(['b/model','same/model'])
  })
  it('applies the confirmed subscription scope inside each group without granting premium models to GOAT or unknown plans', async () => {
    expect(await listCandidates('premium/model', keyA)).toEqual([])
    expect(await listCandidates('premium/model', keyB)).toEqual([])
    await sql`UPDATE managed_accounts SET snapshot=${sql.json({ subscription: { planId: 'individual-pro' }, credits: {}, windowLimits: null })} WHERE id=${accountB}`
    expect((await listCandidates('premium/model', keyB)).map(account => account.id)).toEqual([accountB])
    expect(await listCandidates('premium/model', keyA)).toEqual([])
    expect((await listGatewayModels(keyB)).data.map(model => model.id)).toEqual(['b/model','premium/model','same/model'])
    await sql`UPDATE managed_accounts SET snapshot=${sql.json({ subscription: { planId: 'individual-go' }, credits: {}, windowLimits: null })} WHERE id=${accountB}`
    expect(await listCandidates('same/model', keyB)).toEqual([])
    expect((await listGatewayModels(keyB)).data).toEqual([])
    await sql`UPDATE managed_accounts SET snapshot=NULL WHERE id=${accountB}`
    expect((await listGatewayModels(keyB)).data.find(model => model.id === 'same/model')?.availability.unknownSubscriptionAccounts).toBe(1)
  })
  it('keeps official reference models separate from actual candidates and drops models denied by every eligible account', async () => {
    const rows = await listAvailableCommandcodeModels(keyA, 'goat', true)
    expect(rows.map(model => model.id)).toEqual(['a/model','same/model'])
    expect(rows.find(model => model.id === 'same/model')).toMatchObject({ eligible_accounts: 1, unknown_accounts: 1, observed_allowed: 0, unknown_subscription_accounts: 1 })
    await sql`UPDATE managed_accounts SET enabled=false WHERE id=${accountA}`
    const reference = await listAvailableCommandcodeModels(keyA, 'goat', true)
    expect(reference.map(model => model.id)).toEqual(['a/model','b/model','same/model'])
    expect(reference.every(model => model.eligible_accounts === 0)).toBe(true)
    expect((await listGatewayModels(keyA)).data).toEqual([])
    await sql`UPDATE managed_accounts SET enabled=true WHERE id=${accountA}`
  })
  it('uses the union of multiple key and account groups and never returns duplicate candidates', async () => {
    await sql.begin(async tx => { await setKeyGroups(tx, keyA, [groupA, groupB]); await setAccountGroups(tx, 'commandcode', accountA, [groupA, groupB]) })
    expect(new Set((await listCandidates('same/model', keyA)).map(account => account.id))).toEqual(new Set([accountA,accountB]))
    expect(await listCandidates('same/model', keyA)).toHaveLength(2)
    await sql.begin(async tx => { await setKeyGroups(tx, keyA, [groupA]); await setAccountGroups(tx, 'commandcode', accountA, [groupA]) })
  })
  it('takes group edits immediately and fails closed without falling back to other groups', async () => {
    await patchGroup(groupA, { enabled: false })
    expect(await resolveEnabledKeyGroupIds(keyA)).toEqual([])
    expect(await listCandidates('same/model', keyA)).toEqual([])
    expect((await listGatewayModels(keyA)).data).toEqual([])
    expect((await listCandidates('same/model', keyB)).map(account => account.id)).toEqual([accountB])
    await patchGroup(groupA, { enabled: true })
    await sql`UPDATE managed_accounts SET enabled=false WHERE id=${accountA}`
    expect(await listCandidates('same/model', keyA)).toEqual([])
    await sql`UPDATE managed_accounts SET enabled=true WHERE id=${accountA}`
    await sql`UPDATE gateway_keys SET enabled=false WHERE id=${keyA}`
    expect(await listCandidates('same/model', keyA)).toEqual([])
    await sql`UPDATE gateway_keys SET enabled=true WHERE id=${keyA}`
  })
  it('rejects empty or unknown bindings atomically and prevents deleting referenced groups', async () => {
    await expect(assertGroupIds([])).rejects.toMatchObject({ statusCode: 400 })
    await expect(sql.begin(tx => setAccountGroups(tx, 'commandcode', accountA, [randomUUID()]))).rejects.toMatchObject({ statusCode: 400 })
    expect((await accountGroupBindings('commandcode', [accountA])).get(accountA)?.groupIds).toEqual([groupA])
    await expect(deleteGroup(groupA)).rejects.toMatchObject({ statusCode: 409 })
    await expect(deleteGroup(DEFAULT_GROUP_ID)).rejects.toMatchObject({ statusCode: 409 })
    const unused = await createGroup({ name: 'Unused group' }); await deleteGroup(unused.id)
  })
  it('keeps new raw accounts and model keys compatible with default bindings, but never binds service keys', async () => {
    const account = randomUUID(), key = randomUUID(), service = randomUUID()
    await sql`INSERT INTO managed_accounts(id,credential_fingerprint,cookie_ciphertext) VALUES(${account},${randomUUID()},'test-cookie')`
    await sql`INSERT INTO gateway_keys(id,name,prefix,secret_hash) VALUES(${key},'Default','ccm_default',${randomUUID()})`
    await sql`INSERT INTO service_keys(id,name,prefix,secret_hash) VALUES(${service},'Service','ccm_service_',${randomUUID()})`
    expect((await accountGroupBindings('commandcode', [account])).get(account)?.groupIds).toEqual([(await getModuleDefaultGroupIds()).commandcode])
    expect(new Set((await keyGroupBindings([key])).get(key)?.groupIds)).toEqual(new Set(await getDefaultModelKeyGroupIds()))
    expect((await keyGroupBindings([service])).has(service)).toBe(false)
    await sql`DELETE FROM managed_accounts WHERE id=${account}`; await sql`DELETE FROM gateway_keys WHERE id=${key}`
    expect((await accountGroupBindings('commandcode', [account])).has(account)).toBe(false)
    expect((await keyGroupBindings([key])).has(key)).toBe(false)
  })
  it('keeps source groups when refreshing a known identity and applies explicit groups during re-import', async () => {
    const identity = { id: 'reimport-user-' + randomUUID(), name: 'Imported', email: null }
    const first = await createPendingAccount(randomUUID(), 'test-cookie', undefined, [groupA,groupB])
    await attachIdentity(first.id, identity, first.credential_fingerprint, 'test-cookie', undefined, [groupA,groupB])
    const rotated = await createPendingAccount(randomUUID(), 'rotated-cookie')
    const merged = await attachIdentity(rotated.id, identity, rotated.credential_fingerprint, 'rotated-cookie')
    expect(merged.account.id).toBe(first.id)
    expect((await accountGroupBindings('commandcode', [first.id])).get(first.id)?.groupIds).toEqual([groupA,groupB])
    expect((await accountGroupBindings('commandcode', [rotated.id])).has(rotated.id)).toBe(false)
    const explicit = await createPendingAccount(randomUUID(), 'explicit-cookie', undefined, [groupB])
    const reassigned = await attachIdentity(explicit.id, identity, explicit.credential_fingerprint, 'explicit-cookie', undefined, [groupB])
    expect(reassigned.account.id).toBe(first.id)
    expect((await accountGroupBindings('commandcode', [first.id])).get(first.id)?.groupIds).toEqual([groupB])
    await sql`DELETE FROM managed_accounts WHERE id=${first.id}`
  })
  it.skipIf(!redisUrl)('ignores an old affinity assignment after a key changes groups', async () => {
    const prefix = 'nexus-groups-lease:' + randomUUID() + ':', redis = new Redis(redisUrl!, { lazyConnect: true, keyPrefix: prefix, maxRetriesPerRequest: 1 })
    const raw = new Redis(redisUrl!, { lazyConnect: true, maxRetriesPerRequest: 1 })
    await Promise.all([redis.connect(), raw.connect()])
    try {
      const affinityHash = 'group-change-session'
      const first = await acquireLease(redis, { candidates: await listCandidates('same/model', keyA), globalLimit: 10, affinityHash, affinityTtlSeconds: 60 })
      expect(first.ok).toBe(true); if (!first.ok) return
      expect(first.lease.accountId).toBe(accountA); await releaseLease(redis, first.lease)
      await sql.begin(tx => setKeyGroups(tx, keyA, [groupB]))
      const second = await acquireLease(redis, { candidates: await listCandidates('same/model', keyA), globalLimit: 10, affinityHash, affinityTtlSeconds: 60 })
      expect(second.ok).toBe(true); if (!second.ok) return
      expect(second.lease.accountId).toBe(accountB); await releaseLease(redis, second.lease)
    } finally {
      await sql.begin(tx => setKeyGroups(tx, keyA, [groupA]))
      let cursor = '0'; do { const result = await raw.scan(cursor, 'MATCH', prefix + '*', 'COUNT', 100); cursor = result[0]; if (result[1].length) await raw.unlink(...result[1]) } while (cursor !== '0')
      redis.disconnect(); raw.disconnect()
    }
  })
})
