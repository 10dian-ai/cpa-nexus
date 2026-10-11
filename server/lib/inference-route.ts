import type { ModelModuleId } from '../../shared/keys'
import { isModuleEnabled } from './modules'
import { listCandidates } from './gateway/accounts'
import { getProviderModel } from './official-catalog'

/**
 * Where a unified `ccm_` model request is executed.
 *
 * - `cpa`: the CPA kernel, including its native providers (Claude/Codex/
 *   Gemini OAuth, API channels, plugins and the native Devin provider).
 * - `commandcode`: the CommandCode account pool, reached through CPA's
 *   managed bridge so protocol conversion stays in the kernel.
 * - `reject`: the key may not call this model at all.
 *
 */
export type InferenceRoute =
  | { target: 'cpa' }
  | { target: 'commandcode' }
  | { target: 'reject'; status: number; message: string }

export interface InferenceRouteInput { moduleId: ModelModuleId; model: string; keyId: string; groupIds: string[] }

export async function resolveInferenceRoute(input: InferenceRouteInput): Promise<InferenceRoute> {
  const { moduleId, model, keyId } = input
  if (model.startsWith('commandcode/')) {
    return moduleId === 'auto' ? { target: 'commandcode' }
      : { target: 'reject', status: 403, message: 'This API key is bound to CPA and cannot call Command Code models' }
  }
  if (moduleId === 'auto' && await isModuleEnabled('commandcode')) {
    // Provider IDs are unambiguous for existing CommandCode clients. Keep their
    // protocol bridge and retry pool, restricted to this same key's groups.
    let provider: Awaited<ReturnType<typeof getProviderModel>> = null
    try { provider = await getProviderModel(model) } catch { /* CPA can remain usable during a catalog outage. */ }
    if (provider && (await listCandidates(model, keyId)).length) return { target: 'commandcode' }
  }
  return { target: 'cpa' }
}
