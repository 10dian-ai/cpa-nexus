import { accountLabels as logiccLabels } from '../modules/logicc/store'

/**
 * Display names for the module accounts that served logged requests. CPA
 * sources are shown by their own source ID; pool modules resolve their
 * account IDs to labels. Accounts deleted since keep their raw ID.
 */
export async function sourceLabels(rows: { module_id?: string | null; source_id?: string | null }[]): Promise<Map<string, string>> {
  const logicc = rows.filter(row => row.module_id === 'logicc' && row.source_id).map(row => String(row.source_id))
  return logicc.length ? logiccLabels([...new Set(logicc)]).catch(() => new Map()) : new Map()
}

export const LOG_SOURCE_FILTERS = ['cpa', 'logicc'] as const
