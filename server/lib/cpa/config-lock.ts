import { getDb } from '../db'
import type { TransactionSql } from 'postgres'

/**
 * Serializes every platform write to CPA's provider configuration
 * (`config/api-keys`): module bridge channels and remote key intake read the
 * current list, change only their own entries and write it back. CPA's
 * management API has no compare-and-swap, so concurrent writers inside this
 * platform must take this lock; edits made in the native console are outside it.
 */
export const KERNEL_CONFIG_LOCK = 71645210
export function withKernelConfigLock<T>(callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return getDb().begin(async tx => {
    await tx`SELECT pg_advisory_xact_lock(${KERNEL_CONFIG_LOCK})`
    return callback(tx)
  }) as Promise<T>
}
