import type { OfficialCatalogView } from '../../../shared/official-catalog'
import { isProviderModelForPlan } from '../../../shared/official-catalog'
import { getDb } from '../db'
import { getRedis } from '../redis'
import { publishUpdate } from '../events'
import { platformError as createError } from '../platform-error'
import { getOfficialCatalog, syncOfficialCatalog } from './index'

export interface CatalogAvailabilitySync {
  updatedAt: string
  modelCount: number
  bridgeUpdated: boolean
  bridgeError: string | null
}

/** A trusted empty list revokes old catalog entries; a missing source never does. */
export function hasConfirmedGoatCatalog(catalog: OfficialCatalogView): boolean {
  return ['goat', 'provider-models', 'provider'].every(id => catalog.sources.some(source => source.id === id && !!source.fetchedAt))
    && catalog.plans.some(plan => plan.id === 'goat' && plan.scope === 'explicit' && plan.apiAccess === true)
}

export async function materializeGoatCatalog(catalog: OfficialCatalogView, previous?: OfficialCatalogView): Promise<number> {
  if (!hasConfirmedGoatCatalog(catalog)) throw createError({ statusCode: 503, message: 'GOAT 套餐与官方 API 目录尚未完成同步，请刷新后重试' })
  const models = catalog.models.filter(model => isProviderModelForPlan(model))
  const sql = getDb()
  await sql.begin(async tx => {
    // Reconsider only denials recorded before an exact official exclusion became inclusion.
    // Recent real denials remain authoritative even after a concurrent catalog refresh.
    if (previous) {
      const oldModels = new Map(previous.models.map(model => [model.id, model]))
      const knownAliases = [...new Set(catalog.plans.flatMap(plan => [plan.id, `individual-${plan.id}`]))]
      for (const model of catalog.models) for (const [planId, access] of Object.entries(model.planAccess)) {
        if (oldModels.get(model.id)?.planAccess[planId]?.included !== false || !isProviderModelForPlan(model, planId) || !access.checkedAt) continue
        await tx`UPDATE account_models m SET observation_scope='superseded-official-scope'
          FROM managed_accounts a WHERE a.id=m.account_id AND m.model_id=${model.id}
          AND m.observation_scope='official-provider' AND m.status='denied' AND m.last_checked_at < ${access.checkedAt}::timestamptz
          AND (lower(trim(coalesce(a.snapshot->'subscription'->>'planId',''))) IN ${sql([planId, `individual-${planId}`])}
            OR (${planId === 'goat'} AND lower(trim(coalesce(a.snapshot->'subscription'->>'planId',''))) NOT IN ${sql(knownAliases)}))`
      }
    }
    for (const model of models) {
      const metadata = { ...model, supported_endpoints: model.supportedEndpoints.map(endpoint => '/provider/v1/' + endpoint) }
      await tx`INSERT INTO model_catalog(model_id,name,metadata) VALUES(${model.id},${model.name},${sql.json(metadata as never)})
        ON CONFLICT(model_id) DO UPDATE SET name=EXCLUDED.name,metadata=EXCLUDED.metadata,updated_at=now()
        WHERE model_catalog.name IS DISTINCT FROM EXCLUDED.name OR model_catalog.metadata IS DISTINCT FROM EXCLUDED.metadata`
    }
    if (models.length) await tx`DELETE FROM model_catalog WHERE model_id NOT IN ${sql(models.map(model => model.id))}`
    else await tx`DELETE FROM model_catalog`
  })
  await getRedis().set('ccm:catalog:updatedAt', catalog.fetchedAt || new Date().toISOString())
  await publishUpdate({ type: 'models' })
  return models.length
}

/** Manual and scheduled refresh update the same authoritative directory and managed CPA channels. */
export async function refreshOfficialAvailability(force = false): Promise<OfficialCatalogView> {
  const previous = await getOfficialCatalog()
  const catalog = await syncOfficialCatalog(force)
  if (catalog.refreshInProgress) return catalog
  const modelCount = await materializeGoatCatalog(catalog, previous)
  let bridgeUpdated = false, bridgeError: string | null = null
  try {
    const { refreshCommandcodeBridge } = await import('../commandcode-bridge')
    await refreshCommandcodeBridge()
    bridgeUpdated = true
  } catch {
    bridgeError = '官方可用列表已更新，CPA 中的 CommandCode 渠道暂未同步，请检查核心连接或重新接入'
  }
  return { ...catalog, availabilitySync: { updatedAt: new Date().toISOString(), modelCount, bridgeUpdated, bridgeError } }
}
