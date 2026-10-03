<script setup lang="ts">
import type { ModuleView } from '#shared/modules'
interface BridgeView { configured: boolean; connected: boolean; modelCount: number; updatedAt: string | null; error: string | null }
useHead({ title: '模块管理 · CPA Nexus' })
const api = useRequestFetch()
const { data, pending, error, refresh } = await useFetch<{ modules: ModuleView[] }>('/api/modules', { key: 'nexus-modules' })
const { data: bridge, error: bridgeError, refresh: refreshBridge } = await useFetch<BridgeView>('/api/modules/commandcode/bridge')
const { busy, run } = useApiAction()
const disableTarget = ref<ModuleView | null>(null)
const disableOpen = computed({ get: () => !!disableTarget.value, set: (value) => { if (!value) disableTarget.value = null } })
const statusLabels = { ready: '运行就绪', unconfigured: '等待配置', unavailable: '暂时不可用', disabled: '已停用' }
async function toggle(module: ModuleView, enabled: boolean) {
  const result = await run(() => api<{ id: string; enabled: boolean }>('/api/modules', { method: 'PATCH', body: { id: module.id, enabled } }), enabled ? '模块已启用' : '模块已停用')
  if (result.ok) { disableTarget.value = null; await refresh(); await refreshBridge() }
}
async function connectCommandcode() {
  const result = await run(() => api<{ connected: boolean; name: string; models: number; error?: string }>('/api/modules/commandcode/connect', { method: 'POST' }))
  if (result.ok) { await refresh(); await refreshBridge() }
}
function icon(module: ModuleView) { return module.kind === 'kernel' ? 'i-ph-cpu-bold' : module.id === 'commandcode' ? 'i-ph-command-bold' : 'i-ph-stack-bold' }
</script>
<template>
  <AppPageHeader title="模块管理" description="CPA 作为核心执行模块，业务能力按模块维护，统一管理状态与入口。"><button class="button" :disabled="pending || busy" @click="refresh(); refreshBridge()"><UIcon name="i-ph-arrow-clockwise-bold" />重新检测</button></AppPageHeader>
  <AppState v-if="error" :error="error" @retry="refresh()" /><div v-else-if="pending && !data" class="nexus-skeleton" role="status" aria-label="正在读取模块状态"><span /><span /><span /></div><AppState v-else-if="!data?.modules.length" title="暂无已注册模块" description="注册模块后，其实际状态与功能入口会显示在这里。" />
  <div v-else class="nexus-module-list"><article v-for="module in data.modules" :key="module.id" class="nexus-module"><span class="nexus-feature-icon"><UIcon :name="icon(module)" /></span><div><h2>{{ module.name }}</h2><p>{{ module.description }}</p><div class="nexus-module-meta"><span class="status-badge" :class="module.status === 'ready' ? 'green' : module.status === 'unavailable' ? 'red' : module.status === 'unconfigured' ? 'amber' : 'neutral'"><span class="status-dot" />{{ statusLabels[module.status] }}</span><span>{{ module.required ? '核心必需模块' : '可选扩展模块' }}</span><span class="mono">{{ module.version }}</span></div><p v-if="module.message">{{ module.message }}</p><div class="nexus-capabilities"><span v-for="capability in module.capabilities" :key="capability">{{ capability }}</span></div><template v-if="module.id === 'commandcode' && module.enabled"><p v-if="bridgeError" class="inline-error">{{ apiErrorMessage(bridgeError) }}</p><p v-else-if="bridge">{{ bridge.connected ? `CPA 渠道已接入 · ${bridge.modelCount} 个模型` : '尚未接入 CPA 统一模型入口' }}<span v-if="bridge.updatedAt"> · {{ formatDate(bridge.updatedAt) }}</span></p><p v-if="bridge?.error" class="inline-error">{{ bridge.error }}</p><p class="small-text">统一入口依赖 CPA 内核；账号保活与额度同步由本模块维护。</p></template></div><div class="nexus-module-controls"><NuxtLink v-if="module.enabled && module.navigation[0]" :to="module.navigation[0].to" class="button">进入模块<UIcon name="i-ph-arrow-up-right-bold" /></NuxtLink><button v-if="module.id === 'commandcode' && module.enabled" class="button primary" :disabled="busy" @click="connectCommandcode">{{ bridge?.connected ? '更新 CPA 渠道' : '接入 CPA' }}</button><button v-if="!module.required" class="button" :disabled="busy" @click="module.enabled ? disableTarget = module : toggle(module, true)">{{ module.enabled ? '停用模块' : '启用模块' }}</button><span v-else class="status-badge neutral">核心必需</span></div></article></div>
  <p class="panel-note">新增模块通过平台的模块清单注册。模块开关影响实际业务入口和后台任务，现有数据会保留。</p>
  <AppDialog v-model="disableOpen" title="停用模块" :description="`停用 ${disableTarget?.name || ''} 的业务入口与后台任务。`" :close-disabled="busy"><p class="nexus-description">账号、配置和日志保留，重新启用后可以继续使用。进行中的请求以内核和任务状态为准。</p><template #footer><button class="button" :disabled="busy" @click="disableTarget = null">取消</button><button class="button danger-solid" :disabled="busy || !disableTarget" @click="disableTarget && toggle(disableTarget, false)">停用模块</button></template></AppDialog>
</template>
