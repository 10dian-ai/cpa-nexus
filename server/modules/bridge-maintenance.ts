import { isModuleEnabled } from '../lib/modules'
import { poolModule, poolModules } from './registry'
import { pruneStaleBridges, removeBridge } from '../lib/cpa/module-bridges'
import type { PoolModuleId } from '../../shared/modules'

/** Bring one pool module's CPA bridge channel in line with its current catalog. */
export async function reconcileModuleBridge(moduleId: PoolModuleId): Promise<void> {
  if (!await isModuleEnabled(moduleId)) { await removeBridge(moduleId).catch(() => {}); return }
  await poolModule(moduleId).reconcileBridge()
}

/** Periodic maintenance for every enabled pool module's bridge channel. */
export async function maintainModuleBridges(): Promise<void> {
  await pruneStaleBridges().catch(() => {})
  for (const module of poolModules()) {
    try {
      if (await isModuleEnabled(module.id)) await module.reconcileBridge()
      else await removeBridge(module.id as PoolModuleId)
    } catch { /* A transient CPA outage is retried on the next cycle. */ }
  }
}
