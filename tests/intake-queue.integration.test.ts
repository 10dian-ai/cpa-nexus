import { randomUUID } from 'node:crypto'
import postgres, { type Sql } from 'postgres'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { migrate } from '../server/lib/migrations'

const fixture = vi.hoisted(() => ({ sql: undefined as Sql | undefined, jobs: [] as { name: string; data: any; options: any }[] }))
vi.mock('../server/lib/db', () => ({ getDb: () => fixture.sql }))
vi.mock('../server/lib/redis', () => ({ createRedisConnection: () => ({}) }))
vi.mock('../server/lib/crypto', () => ({ encryptSecret: (value: string) => 'enc:' + value }))
vi.mock('bullmq', () => ({ Queue: class { add = async (name: string, data: unknown, options: unknown) => { fixture.jobs.push({ name, data, options }) } } }))
import { submitIntake } from '../server/lib/queues'

const databaseUrl = process.env.TEST_DATABASE_URL
const schema = 'nexus_intake_queue_' + randomUUID().replaceAll('-', '')

describe.skipIf(!databaseUrl)('account intake queueing on PostgreSQL', () => {
  let admin: Sql, sql: Sql, created = false
  beforeAll(async () => {
    admin = postgres(databaseUrl!, { max: 1, onnotice: () => {} })
    await admin`CREATE SCHEMA ${admin(schema)}`; created = true
    sql = postgres(databaseUrl!, { max: 1, onnotice: () => {}, connection: { search_path: schema } }); fixture.sql = sql
    await migrate(sql)
    await sql`INSERT INTO logicc_accounts(id,session_id,client_cookie_ciphertext) VALUES(${randomUUID()},'sess_existing01','x')`
  }, 60_000)
  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 })
    if (admin) { try { if (created) await admin`DROP SCHEMA ${admin(schema)} CASCADE` } finally { await admin.end({ timeout: 5 }) } }
  }, 30_000)

  it('skips sessions that are already in the pool and encrypts queued credentials', async () => {
    const cookie = 'a'.repeat(40)
    const result = await submitIntake('logicc', { text: [`${cookie}----sess_existing01`, `${cookie}----sess_brandnew01`, 'garbage'].join('\n') })
    expect(result).toMatchObject({ moduleId: 'logicc', accepted: 1, duplicates: 1, rejected: 1 })
    expect(result.errors).toEqual([{ line: 3, message: expect.any(String) }])
    const job = fixture.jobs.at(-1)!
    expect(job.options.jobId).toBe(result.jobId)
    expect(job.data.moduleId).toBe('logicc')
    expect(job.data.entries).toHaveLength(1)
    expect(job.data.entries[0].ciphertext.startsWith('enc:')).toBe(true)
    expect(JSON.parse(job.data.entries[0].ciphertext.slice(4))).toMatchObject({ sessionId: 'sess_brandnew01' })
  })

  it('creates no job when nothing in the submission is new', async () => {
    const before = fixture.jobs.length
    const result = await submitIntake('logicc', { text: `${'a'.repeat(40)}----sess_existing01` })
    expect(result).toMatchObject({ accepted: 0, duplicates: 1 })
    expect(fixture.jobs.length).toBe(before)
  })
})
