import type { CpaStatus } from '#shared/cpa'

export const cpaManagementUrl = (path: string) => `/api/cpa/management/${path.replace(/^\/+/, '')}`

export function useCpaStatus() {
  return useFetch<CpaStatus>('/api/cpa/status', { key: 'nexus-cpa-status' })
}

export function cpaEntries(value: unknown, key: string): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return []
  const rows = (value as Record<string, unknown>)[key]
  return Array.isArray(rows) ? rows.filter(row => row && typeof row === 'object') : []
}

export function cpaDisplay(value: unknown, fallback = '—'): string {
  if (value == null || value === '') return fallback
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

export async function cpaDownload(path: string, name: string) {
  const blob = await $fetch<Blob>(cpaManagementUrl(path), { responseType: 'blob' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}
