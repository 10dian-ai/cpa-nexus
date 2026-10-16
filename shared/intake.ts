/**
 * Account intake contract shared by the external service API, the admin
 * panel and the public intake page. Each source module (the CPA kernel and
 * every account-pool module) describes the inputs it accepts; the page and
 * clients render forms from this description instead of hard-coding them.
 */
export const INTAKE_MODULE_IDS = ['logicc', 'cpa'] as const
export type IntakeModuleId = typeof INTAKE_MODULE_IDS[number]
export function isIntakeModuleId(value: unknown): value is IntakeModuleId {
  return typeof value === 'string' && (INTAKE_MODULE_IDS as readonly string[]).includes(value)
}

export interface IntakeFormat {
  id: string
  label: string
  description: string
  /** A short, credential-free example of this format. */
  example: string
}

export interface IntakeModuleView {
  id: IntakeModuleId
  name: string
  description: string
  icon: string
  enabled: boolean
  /** Formats recognised automatically in pasted text and uploaded files. */
  formats: IntakeFormat[]
  /** File types accepted by the upload control. */
  accept: string
}

/** One uploaded file, sent as text. Binary files are not accepted. */
export interface IntakeFile { name: string; content: string }

/** Request body of `POST /api/external/modules/{id}/accounts` (and the admin equivalent). */
export interface IntakeRequest {
  /** Pasted text in any supported format: one item per line, JSON or cookie exports. */
  text?: string
  /** Uploaded files; each is parsed with the same automatic detection. */
  files?: IntakeFile[]
  /** Structured items, e.g. `[{ "clientCookie": "…", "sessionId": "sess_…" }]`. */
  items?: unknown[]
  /** Call groups for new accounts; omitted means the module's default group. */
  groupIds?: string[]
}

export interface IntakeSubmitResult {
  jobId: string
  moduleId: IntakeModuleId
  accepted: number
  rejected: number
  duplicates: number
  /** Parse errors found before queueing (line numbers count across text, then files, then items). */
  errors: { line: number; message: string }[]
}
