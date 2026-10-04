import { ensureNativeCpaPrivacy } from './privacy'
import { resetCpaGroupRouting } from './group-routing'

export function cpaPrivacyMutation(path: string, method: string, status: number, body: Uint8Array): boolean {
  if (status < 200 || status >= 300) return false
  path = path.replace(/^v[08]\/management\//, '')
  if (method === 'GET' && /^(oauth\/status|get-auth-status)$/.test(path)) {
    try { return ['ok', 'success', 'completed'].includes(JSON.parse(new TextDecoder().decode(body)).status) } catch { return false }
  }
  return !['GET', 'HEAD'].includes(method) && /^(?:credentials(?:\/|$)|auth-files?(?:\/|-|$)|config(?:\/|\.yaml|$)|oauth\/(?:import|callback)|oauth-callback|(?:gemini|claude|codex|openai-compatibility|vertex|xai|meta)-api-key(?:\/|$))/.test(path)
}
/** Successful source/config changes must be private before the UI reports completion. */
export async function applyCpaPrivacyAfterResponse(path: string, method: string, response: { status: number; body: Uint8Array }) {
  if (!cpaPrivacyMutation(path, method, response.status, response.body)) return
  const result = await ensureNativeCpaPrivacy()
  if (result.changed) resetCpaGroupRouting()
}
