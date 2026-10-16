import { validateCpaBaseUrl, CPA_DEFAULT_URL } from '../cpa/client'
import type { PoolModuleId } from '../../../shared/modules'
import { listCpaGroupOffers, type CpaGroupOffer } from '../cpa/group-routing'
import type { KeyGroupStrategy } from '../groups'
import { parseRequestedModel, publicModelName, splitLevelSuffix, stripProviderNamespace, type RequestedModel, type ThinkingLevel } from './model-names'

/**
 * Which CPA sources may serve a unified-key request, in the order they are
 * tried. One attempt = one group + one native model ID, restricted to the
 * credentials of that group that publish the model. The serving group also
 * decides the SillyTavern presets applied to that attempt.
 */
export interface CpaRouteAttempt {
  kind: 'cpa'
  groupId: string
  /** CPA's own model ID for this source, e.g. `devin/claude-opus-4-8`. */
  nativeModel: string
  /** Thinking level carried by the client's model name (`…-high`), if any. */
  nameLevel?: ThinkingLevel
  /** CPA `(…)` suffix sent by the client, kept for non-Devin models. */
  parenSuffix?: string
  allowedAuthIDs: string[]
  allowedPluginIDs: string[]
  /** Model not in any source catalog but known to CPA (router alias, plugin). */
  opaque: boolean
}

interface Match { nativeModel: string; rank: number; nameLevel?: ThinkingLevel }

const lower = (value: string) => value.toLowerCase()

/** How one source's catalog can serve the requested name; lower rank wins. */
function matchesForOffer(offer: CpaGroupOffer, requested: RequestedModel): Match[] {
  const wanted = requested.name
  const wantedPublic = stripProviderNamespace(wanted).name
  const level = splitLevelSuffix(wantedPublic)
  const result: Match[] = []
  for (const id of offer.models) {
    const namespaced = !!stripProviderNamespace(id).namespace
    const publicName = publicModelName(id, offer.prefix)
    if (id === wanted) result.push({ nativeModel: id, rank: 0 })
    else if (!namespaced && publicName === wantedPublic) result.push({ nativeModel: id, rank: 1 })
    else if (namespaced && lower(publicName) === lower(wantedPublic)) result.push({ nativeModel: id, rank: 2 })
    // `claude-opus-4-8-high` against Devin's single `devin/claude-opus-4-8`.
    else if (namespaced && level && lower(publicName) === lower(level.base)) result.push({ nativeModel: id, rank: 3, nameLevel: level.level })
  }
  return result
}

function attemptsForGroup(groupId: string, offers: CpaGroupOffer[], requested: RequestedModel): CpaRouteAttempt[] {
  const byModel = new Map<string, { rank: number; nameLevel?: ThinkingLevel; auths: Set<string>; plugins: Set<string> }>()
  for (const offer of offers) {
    for (const match of matchesForOffer(offer, requested)) {
      const entry = byModel.get(match.nativeModel) || { rank: match.rank, nameLevel: match.nameLevel, auths: new Set(), plugins: new Set() }
      if (match.rank < entry.rank) { entry.rank = match.rank; entry.nameLevel = match.nameLevel }
      offer.authIds.forEach(id => entry.auths.add(id))
      if (offer.pluginId) entry.plugins.add(offer.pluginId)
      byModel.set(match.nativeModel, entry)
    }
  }
  return [...byModel.entries()].sort((a, b) => a[1].rank - b[1].rank || a[0].localeCompare(b[0])).map(([nativeModel, entry]) => ({
    kind: 'cpa', groupId, nativeModel, ...(entry.nameLevel ? { nameLevel: entry.nameLevel } : {}),
    ...(requested.parenSuffix !== undefined ? { parenSuffix: requested.parenSuffix } : {}),
    allowedAuthIDs: [...entry.auths], allowedPluginIDs: [...entry.plugins], opaque: false,
  }))
}

const mixedCursors = new Map<string, number>()
/** Groups in the order this request should try them. */
export function orderGroups(groupIds: string[], strategy: KeyGroupStrategy, rotationKey: string): string[] {
  if (strategy !== 'mixed' || groupIds.length < 2) return [...groupIds]
  const cursor = mixedCursors.get(rotationKey) || 0
  if (mixedCursors.size > 10_000) mixedCursors.clear()
  mixedCursors.set(rotationKey, cursor + 1)
  const start = cursor % groupIds.length
  return [...groupIds.slice(start), ...groupIds.slice(0, start)]
}

export interface CpaRoutePlan {
  requested: RequestedModel
  /** Attempts per group, best match first; only groups that can serve the model. */
  perGroup: Map<string, CpaRouteAttempt[]>
  offers: CpaGroupOffer[]
}

export async function planCpaRoute(input: { model: string; groupIds: string[] }): Promise<CpaRoutePlan> {
  const requested = parseRequestedModel(input.model)
  const offers = await listCpaGroupOffers(input.groupIds)
  const perGroup = new Map<string, CpaRouteAttempt[]>()
  for (const groupId of input.groupIds) {
    const attempts = attemptsForGroup(groupId, offers.filter(offer => offer.groupId === groupId), requested)
    if (attempts.length) perGroup.set(groupId, attempts)
  }
  if (!perGroup.size && offers.length && await cpaKnowsModel(requested.name)) {
    // Router aliases and plugin executors are resolved by CPA itself; keep the
    // caller's groups as the authorization boundary and let CPA choose.
    for (const groupId of input.groupIds) {
      const groupOffers = offers.filter(offer => offer.groupId === groupId)
      if (!groupOffers.length) continue
      perGroup.set(groupId, [{ kind: 'cpa', groupId, nativeModel: requested.raw, opaque: true,
        allowedAuthIDs: [...new Set(groupOffers.flatMap(offer => offer.authIds))],
        allowedPluginIDs: [...new Set(groupOffers.flatMap(offer => offer.pluginId ? [offer.pluginId] : []))] }])
    }
  }
  return { requested, perGroup, offers }
}

/** An attempt against one account-pool module (Logicc …) within a call group. */
export interface PoolRouteAttempt { kind: 'pool'; moduleId: PoolModuleId; groupId: string; nativeModel: string }
export type RouteAttempt = CpaRouteAttempt | PoolRouteAttempt

/**
 * Final try order. Groups follow the key's order (failover) or rotate per
 * request (mixed); inside a group a pool-module source (its bridge) comes
 * before the CPA credential sources, best name match to weakest. Each pool
 * module is tried once per group.
 */
export function sequenceAttempts(input: {
  groupIds: string[]; strategy: KeyGroupStrategy; rotationKey: string
  perGroup: Map<string, CpaRouteAttempt[]>; poolGroups?: Map<PoolModuleId, Map<string, string>>
}): RouteAttempt[] {
  const poolGroupSet = (groupId: string) => [...(input.poolGroups?.entries() ?? [])].filter(([, groups]) => groups.has(groupId))
  const usable = input.groupIds.filter(id => input.perGroup.has(id) || poolGroupSet(id).length)
  const attempts: RouteAttempt[] = []
  for (const groupId of orderGroups(usable, input.strategy, input.rotationKey)) {
    for (const [moduleId, groups] of poolGroupSet(groupId)) attempts.push({ kind: 'pool', moduleId, groupId, nativeModel: groups.get(groupId)! })
    attempts.push(...input.perGroup.get(groupId) || [])
  }
  return attempts
}

let globalModels: { until: number; value: Promise<Set<string>> } | undefined
export function resetGlobalModelCache() { globalModels = undefined }
/** Whether CPA routes this name at all (its full registry, including router aliases). */
export async function cpaKnowsModel(name: string): Promise<boolean> {
  if (!globalModels || globalModels.until <= Date.now()) {
    const value = (async () => {
      const key = process.env.CPA_CLIENT_KEY?.trim()
      if (!key) return new Set<string>()
      const url = new URL('/v1/models', validateCpaBaseUrl(process.env.CPA_URL?.trim() || CPA_DEFAULT_URL))
      const response = await fetch(url, { headers: { authorization: 'Bearer ' + key }, redirect: 'error', signal: AbortSignal.timeout(8000) })
      if (!response.ok) throw new Error('CPA model list returned HTTP ' + response.status)
      const payload = await response.json() as { data?: Array<{ id?: unknown }> }
      return new Set((payload.data || []).flatMap(item => typeof item.id === 'string' ? [item.id] : []))
    })()
    globalModels = { until: Date.now() + 30_000, value }
    value.catch(() => { if (globalModels?.value === value) globalModels = undefined })
  }
  try { return (await globalModels.value).has(name) }
  // If CPA's list is unavailable, do not turn a possibly valid alias into a 404.
  catch { return true }
}
