import type { IntakeModuleId, IntakeModuleView, IntakeRequest } from '../../../shared/intake'
import type { ImportIssue } from '../../../shared/types'

/**
 * Account intake for one source module. The platform owns the transport
 * (external API, admin import, the public intake page), queueing and
 * progress; each module owns its formats and how an item becomes an account.
 */
export interface IntakeItem {
  /** Position in the submission, for error messages (text lines, then files, then items). */
  line: number
  /** Stable identity used to drop duplicates within one submission. */
  fingerprint: string
  /** Normalized credential. Encrypted while it waits in the queue. */
  payload: Record<string, unknown>
}
export interface ParsedIntake { items: IntakeItem[]; errors: ImportIssue[] }
export type IntakeOutcome = { result: 'imported' | 'updated' | 'skipped'; warning?: string }

export interface IntakeHandler {
  id: IntakeModuleId
  describe(): Omit<IntakeModuleView, 'enabled'>
  parse(request: IntakeRequest): ParsedIntake
  process(payload: Record<string, unknown>, options: { groupIds?: string[] }): Promise<IntakeOutcome>
  /** Sanitized account list for the external API: never credentials. */
  listAccounts(query: { page: number; pageSize: number; q?: string }): Promise<{ items: Record<string, unknown>[]; total: number }>
  pool(): Promise<Record<string, unknown>>
}

export interface IntakeSegment { line: number; source: string; value: string | Record<string, unknown> | unknown[] }
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
/** A browser cookie export (`[{ name, value, domain }]`) describes one login, not one account per cookie. */
export const isCookieExport = (value: unknown): value is Record<string, unknown>[] =>
  Array.isArray(value) && value.length > 0 && value.every(item => isObject(item) && typeof item.name === 'string' && typeof item.value === 'string')

function splitText(text: string, source: string, next: () => number, into: IntakeSegment[]) {
  const trimmed = text.trim()
  if (!trimmed) return
  if (/^[[{]/.test(trimmed)) {
    try {
      const value: unknown = JSON.parse(trimmed)
      const list = isObject(value) && Array.isArray(value.accounts) ? value.accounts : isObject(value) && Array.isArray(value.items) ? value.items : value
      if (Array.isArray(list) && !isCookieExport(list)) { for (const item of list) into.push({ line: next(), source, value: item as Record<string, unknown> }) }
      else into.push({ line: next(), source, value: list as Record<string, unknown> })
      return
    } catch { /* Not one JSON document: JSON lines or plain lines follow. */ }
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = next()
    const value = raw.trim()
    if (!value || value.startsWith('#')) continue
    if (/^[[{]/.test(value)) { try { into.push({ line, source, value: JSON.parse(value) }); continue } catch { /* Plain text. */ } }
    into.push({ line, source, value })
  }
}

/**
 * Number every entry of a submission: pasted text first (one entry per line,
 * or per element of a JSON document), then each file, then structured items.
 */
export function splitIntake(request: IntakeRequest): IntakeSegment[] {
  const result: IntakeSegment[] = []
  let line = 0
  const next = () => ++line
  if (typeof request.text === 'string') splitText(request.text, '粘贴内容', next, result)
  for (const file of request.files || []) splitText(file.content, file.name || '文件', next, result)
  for (const item of request.items || []) result.push({ line: next(), source: '结构化条目', value: item as Record<string, unknown> })
  return result
}
