import { getDb } from '../db'
import type { AccountSnapshot } from '../../../shared/types'
import type { UpstreamFailure } from './errors'
import { getRedis } from '../redis'
import { cooldownAccount } from './scheduler'
import { snapshotIsLimited } from './quota'
import { getOfficialCatalog, OfficialCatalogUnavailableError } from '../official-catalog'
import { DEFAULT_GROUP_ID } from '../../../shared/groups'
import { commandcodePlanScope, isProviderModelForPlan } from '../../../shared/official-catalog'
import type { OfficialCatalogView } from '../../../shared/official-catalog'

export interface GatewayAccount { id: string; apiKeyCiphertext: string; limit: number }
export async function listCandidates(model: string, keyId?: string): Promise<GatewayAccount[]> {
  const official = await getOfficialCatalog()
  const metadata = official.models.find(item => item.id === model)
  if (!metadata?.providerAvailable || !metadata.supportedEndpoints.length) return []
  const planIds = Object.keys(metadata.planAccess)
  const sql = getDb()
  const groupScope = keyId ? sql`AND EXISTS (
    SELECT 1 FROM nexus_account_groups ag JOIN nexus_groups g ON g.id=ag.group_id AND g.enabled=true
    WHERE ag.module_id='commandcode' AND ag.account_id=a.id::text AND (
      EXISTS(SELECT 1 FROM nexus_key_groups kg JOIN gateway_keys k ON k.id=kg.key_id AND k.enabled=true WHERE kg.key_id=${keyId} AND kg.group_id=ag.group_id)
      OR (ag.group_id=${DEFAULT_GROUP_ID}::uuid AND EXISTS(SELECT 1 FROM gateway_keys k WHERE k.id=${keyId} AND k.enabled=true AND left(k.prefix,10)='ccm_nexus_'))
    ))` : sql`AND EXISTS (SELECT 1 FROM nexus_account_groups ag JOIN nexus_groups g ON g.id=ag.group_id AND g.enabled=true WHERE ag.module_id='commandcode' AND ag.account_id=a.id::text)`
  const rows = await sql<{ id: string; api_key_ciphertext: string; max_concurrency: number; snapshot: AccountSnapshot | null }[]>`
    SELECT a.id, a.api_key_ciphertext, a.max_concurrency, a.snapshot
    FROM managed_accounts a
    LEFT JOIN account_models m ON m.account_id = a.id AND m.model_id = ${model} AND m.observation_scope='official-provider'
    WHERE a.enabled = TRUE AND a.status = 'ready' AND a.api_key_ciphertext IS NOT NULL
      ${groupScope}
      AND (m.status IS NULL OR m.status <> 'denied')
      AND (m.status IS NULL OR m.status <> 'cooldown' OR m.cooldown_until <= NOW() OR m.cooldown_until IS NULL)
    ORDER BY a.last_used_at ASC NULLS FIRST, a.id
  `
  return rows.filter(row => !snapshotIsLimited(row.snapshot) && isProviderModelForPlan(metadata, commandcodePlanScope(row.snapshot?.subscription.planId, planIds).id)).map(row => ({
    id: row.id, apiKeyCiphertext: row.api_key_ciphertext, limit: row.max_concurrency,
  }))
}
export async function touchAccount(accountId: string) {
  await getDb()`UPDATE managed_accounts SET last_used_at = NOW() WHERE id = ${accountId}`
}
export async function recordModelAllowed(accountId: string, model: string) {
  await getDb()`
    INSERT INTO account_models (account_id, model_id, status, reason, cooldown_until, last_checked_at,observation_scope)
    VALUES (${accountId}, ${model}, 'allowed', NULL, NULL, NOW(),'official-provider')
    ON CONFLICT (account_id, model_id) DO UPDATE
      SET status = 'allowed', reason = NULL, cooldown_until = NULL, last_checked_at = NOW(),observation_scope='official-provider'
  `
}
export async function recordFailure(accountId: string, model: string, failure: UpstreamFailure) {
  if (failure.category === 'model_denied') {
    await getDb()`
      INSERT INTO account_models (account_id, model_id, status, reason, cooldown_until, last_checked_at,observation_scope)
      VALUES (${accountId}, ${model}, 'denied', ${failure.message}, NULL, NOW(),'official-provider')
      ON CONFLICT (account_id, model_id) DO UPDATE
        SET status = 'denied', reason = EXCLUDED.reason, cooldown_until = NULL, last_checked_at = NOW(),observation_scope='official-provider'
    `
  } else if (failure.cooldownSeconds > 0) {
    await cooldownAccount(getRedis(), accountId, failure.cooldownSeconds)
  }
  // A proxy HTTP 401 can mean a model denial. Never abandon/disable the account here.
}
export interface AvailableCommandcodeModel {
  id: string; name: string; observed_allowed: number; observed_denied: number; unknown_accounts: number
  unknown_subscription_accounts: number; eligible_accounts: number; created: number; supported_endpoints: string[]; updated_at: string | null
}
/** The administration list can show confirmed GOAT catalog entries before any account is imported. */
export async function listAvailableCommandcodeModels(keyId?: string, planId?: string, includeWithoutAccounts = false, catalog?: OfficialCatalogView): Promise<AvailableCommandcodeModel[]> {
  const sql = getDb()
  const groupScope = keyId ? sql`AND EXISTS (
    SELECT 1 FROM nexus_account_groups ag JOIN nexus_groups g ON g.id=ag.group_id AND g.enabled=true
    WHERE ag.module_id='commandcode' AND ag.account_id=a.id::text AND (
      EXISTS(SELECT 1 FROM nexus_key_groups kg JOIN gateway_keys k ON k.id=kg.key_id AND k.enabled=true WHERE kg.key_id=${keyId} AND kg.group_id=ag.group_id)
      OR (ag.group_id=${DEFAULT_GROUP_ID}::uuid AND EXISTS(SELECT 1 FROM gateway_keys k WHERE k.id=${keyId} AND k.enabled=true AND left(k.prefix,10)='ccm_nexus_'))
    ))` : sql`AND EXISTS (SELECT 1 FROM nexus_account_groups ag JOIN nexus_groups g ON g.id=ag.group_id AND g.enabled=true WHERE ag.module_id='commandcode' AND ag.account_id=a.id::text)`
  const official = catalog || await getOfficialCatalog()
  const metadata = official.models.filter(model => planId ? isProviderModelForPlan(model, planId)
    : model.providerAvailable && model.supportedEndpoints.length > 0 && Object.keys(model.planAccess).some(id => isProviderModelForPlan(model, id)))
  if (!metadata.length) {
    const confirmed = official.sources?.some(source => source.id === 'provider-models' && !!source.fetchedAt)
      && official.sources.some(source => source.id === 'goat' && !!source.fetchedAt)
      && official.plans?.some(plan => plan.id === 'goat' && plan.scope === 'explicit' && plan.apiAccess === true)
    if (!confirmed) throw new OfficialCatalogUnavailableError()
    return []
  }
  const accounts = await sql<{ id: string; snapshot: AccountSnapshot | null }[]>`
    SELECT a.id,a.snapshot FROM managed_accounts a
    WHERE a.enabled = TRUE AND a.status = 'ready' AND a.api_key_ciphertext IS NOT NULL ${groupScope}
  `
  const planIds = [...new Set(metadata.flatMap(model => Object.keys(model.planAccess)))]
  const eligible = accounts.filter(account => !snapshotIsLimited(account.snapshot)).map(account => {
    const scope = commandcodePlanScope(account.snapshot?.subscription.planId, planIds)
    return { id: account.id, plan_id: scope.id, confirmed: scope.confirmed }
  })
  const permissions = metadata.map(model => ({ id: model.id, name: model.name, allowed_plans: Object.keys(model.planAccess).filter(id => isProviderModelForPlan(model, id)) }))
  const rows = await sql<AvailableCommandcodeModel[]>`
    WITH ready AS (
      SELECT * FROM jsonb_to_recordset(${sql.json(eligible)}) AS account(id uuid,plan_id text,confirmed boolean)
    ), ids AS (
      SELECT * FROM jsonb_to_recordset(${sql.json(permissions)}) AS model(id text,name text,allowed_plans jsonb)
    )
    SELECT ids.id,ids.name,
      COUNT(*) FILTER (WHERE m.status = 'allowed')::int AS observed_allowed,
      COUNT(*) FILTER (WHERE m.status = 'denied')::int AS observed_denied,
      COUNT(*) FILTER (WHERE a.id IS NOT NULL AND (m.status IS NULL OR m.status = 'cooldown'))::int AS unknown_accounts,
      COUNT(*) FILTER (WHERE a.id IS NOT NULL AND a.confirmed = false)::int AS unknown_subscription_accounts,
      COUNT(*) FILTER (WHERE a.id IS NOT NULL AND (m.status IS NULL OR m.status <> 'denied')
        AND (m.status IS NULL OR m.status <> 'cooldown' OR m.cooldown_until <= NOW() OR m.cooldown_until IS NULL))::int AS eligible_accounts,
      COALESCE(EXTRACT(EPOCH FROM MIN(c.updated_at))::bigint, 0)::int AS created,
      MIN(c.updated_at)::text AS updated_at
    FROM ids LEFT JOIN model_catalog c ON c.model_id = ids.id
    LEFT JOIN ready a ON ids.allowed_plans ? a.plan_id
    LEFT JOIN account_models m ON m.account_id = a.id AND m.model_id = ids.id AND m.observation_scope='official-provider'
    GROUP BY ids.id,ids.name
    HAVING COUNT(*) FILTER (WHERE a.id IS NOT NULL AND (m.status IS NULL OR m.status <> 'denied')
      AND (m.status IS NULL OR m.status <> 'cooldown' OR m.cooldown_until <= NOW() OR m.cooldown_until IS NULL)) > 0
      OR (${includeWithoutAccounts} AND COUNT(a.id) = 0)
    ORDER BY ids.id
  `
  const byId = new Map(metadata.map(model => [model.id,model]))
  return rows.map(row => ({ ...row, supported_endpoints: byId.get(row.id)!.supportedEndpoints.map(endpoint => '/provider/v1/' + endpoint) }))
}
export async function listGatewayModels(keyId?: string) {
  const rows = await listAvailableCommandcodeModels(keyId)
  return {
    object: 'list',
    data: rows.map(row => ({
      id: row.id, object: 'model', created: Number(row.created), owned_by: 'commandcode', name: row.name,
      availability: { observedAllowed: row.observed_allowed, observedDenied: row.observed_denied, unknownAccounts: row.unknown_accounts, unknownSubscriptionAccounts: row.unknown_subscription_accounts, eligibleAccounts: row.eligible_accounts },
      supported_endpoints: row.supported_endpoints,
    })),
  }
}
