import type { GroupAccountView } from '../../shared/groups'

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''
const basename = (value: string): string => value.split(/[\\/]/).pop() || ''

/** Match only inventory identities; labels, emails and model prefixes are never source IDs. */
export function credentialGroupSource(credential: Record<string, unknown>, sources: GroupAccountView[]): GroupAccountView | null {
  const available = sources.filter(source => source.moduleId === 'cpa' && !source.missing)
  const identity = text(credential.id) || text(credential.name)
  const exact = identity ? available.filter(source => source.credentialIds?.includes(identity)) : []
  if (exact.length) return exact.length === 1 ? exact[0]! : null

  const index = text(credential.auth_index)
  const indexed = index ? available.filter(source => source.sourceId === 'config:' + index || source.sourceId === 'runtime:' + index) : []
  if (indexed.length) return indexed.length === 1 ? indexed[0]! : null

  const path = text(credential.path)
  const file = path ? basename(path) : credential.source === 'file' ? basename(text(credential.name)) : ''
  if (!file) return null
  const physical = available.filter(source => source.sourceId === file)
  return physical.length === 1 ? physical[0]! : null
}
