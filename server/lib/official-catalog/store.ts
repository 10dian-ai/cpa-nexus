import { createHash } from 'node:crypto'
import type { OfficialCatalogView } from '../../../shared/official-catalog'
import { getDb } from '../db'
import { getRedis } from '../redis'
import type { CatalogStore, SourceState } from './service'
const CACHE_KEY = 'nexus:official:commandcode:catalog'
const LOCK_KEY = 'nexus:official:commandcode:sync-lock'
export const postgresCatalogStore: CatalogStore = {
  async readSources() {
    const rows = await getDb()`SELECT id,url,payload,fetched_at,last_attempt_at,etag,last_modified,error,model_count FROM official_catalog_sources`
    return rows.map(row => ({ id: row.id as string, url: row.url as string, payload: row.payload as SourceState['payload'],
      fetchedAt: row.fetched_at ? new Date(row.fetched_at).toISOString() : null, lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at).toISOString() : null,
      etag: row.etag as string | null, lastModified: row.last_modified as string | null, error: row.error as string | null, modelCount: row.model_count as number | null }))
  },
  async saveSource(source) {
    const db = getDb()
    await db`INSERT INTO official_catalog_sources (id,url,payload,fetched_at,last_attempt_at,etag,last_modified,error,model_count)
      VALUES (${source.id},${source.url},${source.payload === null ? null : db.json(source.payload as never)},${source.fetchedAt},${source.lastAttemptAt},${source.etag},${source.lastModified},${source.error},${source.modelCount})
      ON CONFLICT (id) DO UPDATE SET url=excluded.url,payload=excluded.payload,fetched_at=excluded.fetched_at,last_attempt_at=excluded.last_attempt_at,
        etag=excluded.etag,last_modified=excluded.last_modified,error=excluded.error,model_count=excluded.model_count`
  },
  async readSnapshot() { const rows = await getDb()`SELECT snapshot FROM official_catalog_state WHERE id='commandcode'`; return rows[0]?.snapshot as OfficialCatalogView || null },
  async saveSnapshot(view) {
    // Archive only semantic catalog changes; unchanged polling does not grow the database.
    const hash = createHash('sha256').update(JSON.stringify({ models: view.models.map(model => ({ ...model, planAccess: Object.fromEntries(Object.entries(model.planAccess).map(([id, access]) => [id, { ...access, checkedAt: null }])) })), plans: view.plans.map(plan => ({ ...plan, checkedAt: null })) })).digest('hex')
    await getDb().begin(async db => {
      await db`INSERT INTO official_catalog_state (id,snapshot) VALUES ('commandcode',${db.json(view as never)}) ON CONFLICT (id) DO UPDATE SET snapshot=excluded.snapshot,updated_at=now()`
      await db`INSERT INTO official_catalog_history (content_hash,snapshot) VALUES (${hash},${db.json(view as never)}) ON CONFLICT (content_hash) DO NOTHING`
      await db`DELETE FROM official_catalog_history WHERE id NOT IN (SELECT id FROM official_catalog_history ORDER BY id DESC LIMIT 48)`
    })
  },
  async readCache() { const cached = await getRedis().get(CACHE_KEY); return cached ? JSON.parse(cached) as OfficialCatalogView : null },
  async saveCache(view) { await getRedis().set(CACHE_KEY, JSON.stringify(view), 'EX', 60) },
  async acquireLock(token) { return await getRedis().set(LOCK_KEY, token, 'PX', 120_000, 'NX') === 'OK' },
  async releaseLock(token) { await getRedis().eval("if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end", 1, LOCK_KEY, token) },
}
