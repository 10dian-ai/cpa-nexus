import type { GroupAccountView } from '#shared/groups'

/**
 * Display names of CPA sources (credential files, configured upstream keys,
 * plugin executors) by their stable source ID, for pages that only store IDs
 * such as request logs. Loaded on the client so a slow kernel never blocks
 * page rendering; unknown IDs fall back to the raw ID.
 */
export function useCpaSourceNames() {
  const { data } = useFetch<{ items: GroupAccountView[] }>('/api/groups/accounts', { query: { moduleId: 'cpa' }, key: 'nexus-cpa-source-names', server: false, lazy: true })
  const names = computed(() => new Map((data.value?.items || []).map(item => [item.sourceId, item.name])))
  return (sourceId?: string | null) => (sourceId && names.value.get(sourceId)) || sourceId || ''
}
