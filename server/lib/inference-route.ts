import type { ModelModuleId } from '../../shared/keys'
import { isModuleEnabled } from './modules'
import { listCandidates } from './gateway/accounts'
import { getProviderModel } from './official-catalog'
import { isDevin2ApiModel } from './devin2api/catalog'
import { resolveDevin2ApiModel, type Devin2ApiSelection } from './devin2api/routing'

/**
 * Where a unified `ccm_` model request is executed.
 *
 * - `cpa`: the CPA kernel, including its native providers (Claude/Codex/
 *   Gemini OAuth, API channels, plugins and the native Devin provider).
 * - `devin2api`: the embedded Devin module (opt-in, separate account pool).
 * - `commandcode`: the CommandCode account pool, reached through CPA's
 *   managed bridge so protocol conversion stays in the kernel.
 * - `reject`: the key may not call this model at all.
 *
 * CPA's native Devin provider and the Devin module both publish models in the
 * `devin/<model>` namespace. A `devin/` model is therefore not proof that the
 * Devin module owns the request: it is handed to the module only when the key
 * may use the module and one of the key's groups really serves the model.
 * Everything else stays on CPA, so native Devin credentials keep working with
 * the module disabled and for CPA-bound keys.
 */
export type InferenceRoute =
  | { target: 'cpa'; deferredError?: unknown }
  | { target: 'devin2api'; selection?: Devin2ApiSelection }
  | { target: 'commandcode' }
  | { target: 'reject'; status: number; message: string }

export interface InferenceRouteInput { moduleId: ModelModuleId; model: string; keyId: string; groupIds: string[] }

export async function resolveInferenceRoute(input: InferenceRouteInput): Promise<InferenceRoute> {
  const { moduleId, model, keyId, groupIds } = input
  if (moduleId === 'devin2api') return { target: 'devin2api' }
  if (isDevin2ApiModel(model)) {
    if (moduleId !== 'auto' || !await isModuleEnabled('devin2api')) return { target: 'cpa' }
    try {
      const selection = await resolveDevin2ApiModel(model, groupIds)
      return selection ? { target: 'devin2api', selection } : { target: 'cpa' }
    } catch (error) {
      // The module's catalog is unavailable. CPA may still serve the same
      // model natively; if it does not, the module's own error is reported.
      return { target: 'cpa', deferredError: error }
    }
  }
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
