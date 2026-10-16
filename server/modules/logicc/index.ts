import type { H3Event } from 'h3'
import type { PoolModule, BridgeRequestContext } from '../contract'
import type { ModuleView } from '../../../shared/modules'
import { reconcileBridge } from '../../lib/cpa/module-bridges'
import { handleLogiccChat } from './gateway'
import { servingModels, summary } from './store'

/** The Logicc account-pool module. */
export const logiccModule: PoolModule = {
  id: 'logicc',
  async health(): Promise<Pick<ModuleView, 'status' | 'message'>> {
    const counts = await summary()
    if (!counts.total) return { status: 'unconfigured', message: '尚未添加 Logicc 账号，请在账号管理或外调加号中导入。' }
    if (!counts.ready) return { status: 'unavailable', message: `已添加 ${counts.total} 个账号，但没有可用账号，请检查凭据或等待同步。` }
    return { status: 'ready', message: `${counts.ready} / ${counts.enabled} 个账号可用，经 CPA 桥接渠道统一调用。` }
  },
  servingModels,
  handleBridgeChat(event: H3Event, body: Record<string, unknown>, context: BridgeRequestContext) {
    return handleLogiccChat(event, body, context)
  },
  async reconcileBridge() {
    await reconcileBridge({ moduleId: 'logicc', routePath: '/api/modules/logicc/bridge/v1', models: await servingModels() })
  },
}
