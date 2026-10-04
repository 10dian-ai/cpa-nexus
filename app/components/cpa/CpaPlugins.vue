<script setup lang="ts">
import { pluginConfigFields, pluginExternalLink, pluginMenuHref, pluginObject } from '~/utils/cpa-plugins'

const api = useRequestFetch()
const { data, pending, error, refresh } = await useFetch<unknown>(cpaManagementUrl('plugins'), { key: 'cpa-installed-plugins' })
const plugins = computed(() => cpaEntries(data.value, 'plugins'))
const root = computed(() => data.value && typeof data.value === 'object' ? data.value as Record<string, unknown> : {})
const selectedId = ref('')
const selectedPlugin = computed(() => plugins.value.find(plugin => plugin.id === selectedId.value))
const search = ref('')
const displayed = computed(() => {
  const q = search.value.trim().toLowerCase()
  return plugins.value.filter(plugin => !q || [plugin.id, pluginObject(plugin.metadata).name, plugin.oauth_provider, plugin.quota_provider].some(value => cpaDisplay(value, '').toLowerCase().includes(q)))
})
const removeId = ref('')
const quotaPlugin = ref('')
const quotaAuthIndex = ref('')
const quotaData = ref<unknown>(null)
const removeOpen = computed({ get: () => !!removeId.value, set: (value) => { if (!value) removeId.value = '' } })
const { busy, run } = useApiAction()
async function toggle(id: string, enabled: boolean) {
  const result = await run(() => api(cpaManagementUrl(`config/plugins/configs/${encodeURIComponent(id)}/enabled`), { method: 'PUT', body: JSON.stringify(enabled), headers: { 'content-type': 'application/json' } }), '插件配置已更新')
  if (result.ok) await Promise.all([refresh(), refreshNuxtData(['cpa-management-capabilities', 'cpa-plugin-store'])])
}
async function toggleAll() {
  const result = await run(() => api(cpaManagementUrl('config/plugins/enabled'), { method: 'PUT', body: JSON.stringify(!root.value.plugins_enabled), headers: { 'content-type': 'application/json' } }), '原生插件总开关已更新')
  if (result.ok) await Promise.all([refresh(), refreshNuxtData(['cpa-management-capabilities', 'cpa-plugin-store'])])
}
async function remove() {
  const result = await run(() => api(cpaManagementUrl(`plugins/${encodeURIComponent(removeId.value)}`), { method: 'DELETE' }), '插件已移除')
  if (result.ok) { removeId.value = ''; await Promise.all([refresh(), refreshNuxtData(['cpa-management-capabilities', 'cpa-plugin-store'])]) }
}
async function readQuota(refreshQuota = false) {
  if (!quotaPlugin.value || !quotaAuthIndex.value.trim()) return
  const path = cpaManagementUrl(`plugins/${encodeURIComponent(quotaPlugin.value)}/quota`)
  const result = await run(() => refreshQuota ? api(path, { method: 'POST', body: { auth_index: quotaAuthIndex.value.trim() } }) : api(path, { query: { auth_index: quotaAuthIndex.value.trim() } }))
  if (result.ok) quotaData.value = result.value
}
function menus(plugin: Record<string, unknown>) { return Array.isArray(plugin.menus) ? plugin.menus.filter((menu): menu is Record<string, unknown> => !!menu && typeof menu === 'object') : [] }
function oauthLink(plugin: Record<string, unknown>) { return { path: '/cpa/oauth', query: { provider: cpaDisplay(plugin.oauth_provider, ''), plugin_id: cpaDisplay(plugin.id, '') } } }
function quotaLink(plugin: Record<string, unknown>) { return { path: '/cpa/quota', query: { plugin_id: cpaDisplay(plugin.id, ''), ...(plugin.quota_provider ? { provider: cpaDisplay(plugin.quota_provider) } : {}) } } }
function pluginRoles(plugin: Record<string, unknown>) {
  const labels: Record<string, string> = { auth_provider: '账号认证', frontend_auth_provider: '客户端认证', provider_executor: '模型调用', quota_provider: '配额查询', scheduler: '调度', request_normalizer: '请求规范化', request_transformer: '请求处理', response_transformer: '回复处理', management_api: '管理接口', resource_routes: '插件资源', usage_handler: '用量记录', authProvider: '账号认证', frontendAuthProvider: '客户端认证', executor: '模型调用', quotaProvider: '配额查询', modelProvider: '模型目录', modelRegistrar: '模型注册', modelRouter: '模型路由', requestNormalizer: '请求规范化', requestTranslator: '请求转换', requestInterceptor: '请求处理', responseTranslator: '回复转换', responseBeforeTranslator: '转换前处理', responseAfterTranslator: '转换后处理', responseInterceptor: '回复处理', streamChunkInterceptor: '流式处理', managementAPI: '管理接口', usagePlugin: '用量记录', commandLinePlugin: '命令行扩展', requestLifecyclePlugin: '请求生命周期', thinkingApplier: '思考配置', webSocketResponseObserver: 'WebSocket 响应' }
  return Object.entries(pluginObject(plugin.capabilities)).filter(([, value]) => value === true).map(([name]) => labels[name] || name.replaceAll('_', ' ')).join('、')
}
</script>
<template>
  <section class="table-panel"><div class="table-toolbar"><span class="status-badge" :class="root.plugins_enabled ? 'green' : 'neutral'">原生插件总开关：{{ root.plugins_enabled ? '开启' : '关闭' }}</span><button class="button small" :disabled="busy || !data" @click="toggleAll">{{ root.plugins_enabled ? '关闭总开关' : '开启总开关' }}</button><button class="button small" :disabled="busy || pending" @click="refresh()">重新读取</button><NuxtLink to="/cpa/oauth" class="button small">OAuth 登录中心</NuxtLink><NuxtLink to="/cpa/quota" class="button small">额度中心</NuxtLink><span class="toolbar-meta">{{ plugins.length }} 个插件</span></div>
    <AppState v-if="error" :error="error" @retry="refresh()" /><AppState v-else-if="pending && !data" loading /><AppState v-else-if="!plugins.length" title="尚未发现原生插件" description="可在插件商店安装插件，或配置 CPA 原生插件目录。" />
    <div v-else class="table-toolbar"><label class="search-field"><UIcon name="i-ph-magnifying-glass-bold" /><input v-model="search" aria-label="搜索本地插件" placeholder="搜索插件名称、ID 或渠道" /></label><NuxtLink to="/cpa/plugins?tab=store" class="button small">打开全部插件商店</NuxtLink></div>
    <AppState v-if="plugins.length && !displayed.length" compact title="没有匹配的本地插件" description="换一个名称、ID 或渠道关键词。" />
    <div v-if="displayed.length" class="table-scroll"><table class="data-table"><thead><tr><th>插件</th><th>状态 / 原生能力</th><th>操作</th></tr></thead><tbody><tr v-for="plugin in displayed" :key="cpaDisplay(plugin.id)">
      <td><strong class="nexus-table-name">{{ cpaDisplay(pluginObject(plugin.metadata).name || plugin.id) }}</strong><div class="cell-secondary mono">{{ cpaDisplay(plugin.id) }} · {{ cpaDisplay(plugin.version || pluginObject(plugin.metadata).version, '版本未返回') }}</div><div v-if="pluginObject(plugin.metadata).author" class="cell-secondary">{{ cpaDisplay(pluginObject(plugin.metadata).author) }}</div><a v-if="pluginExternalLink(pluginObject(plugin.metadata).github_repository)" :href="pluginExternalLink(pluginObject(plugin.metadata).github_repository)" target="_blank" rel="noopener noreferrer" class="text-link small-text">插件源码<UIcon name="i-ph-arrow-up-right-bold" /></a></td>
      <td><span class="status-badge" :class="plugin.effective_enabled ? 'green' : plugin.enabled ? 'amber' : 'neutral'">{{ plugin.effective_enabled ? '运行中' : plugin.enabled ? '已配置启用' : '已停用' }}</span><div v-if="plugin.error" class="cell-error">{{ cpaDisplay(plugin.error) }}</div><div v-if="!plugin.registered" class="cell-secondary">尚未注册到运行中的内核，安装后可能需要重启</div><div v-if="pluginRoles(plugin)" class="plugin-runtime-roles">实际角色：{{ pluginRoles(plugin) }}</div><div v-if="plugin.executor_model_scope" class="cell-secondary">模型范围：{{ cpaDisplay(plugin.executor_model_scope) }}</div><div class="cell-secondary">{{ plugin.supports_oauth ? 'OAuth 登录 · ' : '' }}{{ plugin.supports_quota ? '配额查询 · ' : '' }}{{ menus(plugin).length }} 个插件页面 · {{ pluginConfigFields(plugin).length }} 个声明参数</div></td>
      <td><div class="nexus-table-actions"><button class="button small" :disabled="busy" @click="toggle(cpaDisplay(plugin.id, ''), !plugin.enabled)">{{ plugin.enabled ? '停用' : '启用' }}</button><button class="button small" @click="selectedId = cpaDisplay(plugin.id, '')">配置</button><NuxtLink v-if="plugin.supports_oauth" :to="oauthLink(plugin)" class="button small">OAuth 登录</NuxtLink><NuxtLink v-if="plugin.supports_quota" :to="quotaLink(plugin)" class="button small">额度中心</NuxtLink><button v-if="plugin.supports_quota" class="button small" @click="quotaPlugin = cpaDisplay(plugin.id, ''); quotaData = null">原生额度接口</button><button class="button small danger" :disabled="busy" @click="removeId = cpaDisplay(plugin.id, '')">移除</button><template v-for="(menu, i) in menus(plugin)" :key="i"><a v-if="plugin.effective_enabled && pluginMenuHref(cpaDisplay(plugin.id, ''), menu)" :href="pluginMenuHref(cpaDisplay(plugin.id, ''), menu)" target="_blank" rel="noopener noreferrer" class="button small" :title="cpaDisplay(menu.description, '')">{{ cpaDisplay(menu.menu || menu.title || menu.name || menu.label, '插件页面') }}<UIcon name="i-ph-arrow-square-out-bold" /></a></template></div></td>
    </tr></tbody></table></div>
  </section>
  <CpaPluginConfiguration v-if="selectedPlugin" :key="selectedId" class="section-gap" :plugin="selectedPlugin" />
  <section v-if="quotaPlugin" class="panel section-gap"><div class="panel-heading"><h2>{{ quotaPlugin }} 额度</h2><button class="button small" @click="quotaPlugin = ''">收起</button></div><form class="nexus-form-line" @submit.prevent="readQuota()"><label class="field"><span>凭证 auth_index</span><input v-model="quotaAuthIndex" required placeholder="从凭证详情中复制"></label><button class="button" :disabled="busy || !quotaAuthIndex.trim()">读取额度</button><button type="button" class="button" :disabled="busy || !quotaAuthIndex.trim()" @click="readQuota(true)">刷新额度</button></form><JsonViewer v-if="quotaData !== null" :value="quotaData" title="插件返回的额度记录" /></section>
  <details class="raw-details section-gap"><summary><UIcon name="i-ph-code-bold" />插件发现记录与菜单信息</summary><JsonViewer :value="data" title="CPA 返回的原生插件记录" /></details><p class="panel-note">平台模块和 CPA 原生插件分别管理。插件页面、子资源和原生管理接口通过当前管理员会话访问完整内核。</p>
  <AppDialog v-model="removeOpen" title="移除原生插件" :description="`移除 ${removeId} 的插件文件和保存配置。`" :close-disabled="busy"><p class="nexus-description">某些插件无法在运行中卸载，内核会返回需要重启的状态。</p><template #footer><button class="button" :disabled="busy" @click="removeId = ''">取消</button><button class="button danger-solid" :disabled="busy" @click="remove">移除插件</button></template></AppDialog>
</template>

<style scoped>
.plugin-runtime-roles { white-space: normal; max-width: 42ch; margin-top: 7px; font-size: 11px; color: var(--muted); line-height: 1.8; overflow-wrap: anywhere; }
</style>
