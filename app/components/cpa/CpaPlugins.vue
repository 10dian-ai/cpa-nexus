<script setup lang="ts">
const api = useRequestFetch()
const { data, pending, error, refresh } = await useFetch<unknown>(cpaManagementUrl('plugins'))
const plugins = computed(() => cpaEntries(data.value, 'plugins'))
const root = computed(() => data.value && typeof data.value === 'object' ? data.value as Record<string, unknown> : {})
const selectedId = ref('')
const removeId = ref('')
const quotaPlugin = ref('')
const quotaAuthIndex = ref('')
const quotaData = ref<unknown>(null)
const removeOpen = computed({ get: () => !!removeId.value, set: (value) => { if (!value) removeId.value = '' } })
const { busy, run } = useApiAction()
async function toggle(id: string, enabled: boolean) {
  const result = await run(() => api(cpaManagementUrl(`config/plugins/configs/${encodeURIComponent(id)}/enabled`), { method: 'PUT', body: JSON.stringify(enabled), headers: { 'content-type': 'application/json' } }), '插件配置已更新')
  if (result.ok) await refresh()
}
async function toggleAll() {
  const result = await run(() => api(cpaManagementUrl('config/plugins/enabled'), { method: 'PUT', body: JSON.stringify(!root.value.plugins_enabled), headers: { 'content-type': 'application/json' } }), '原生插件总开关已更新')
  if (result.ok) await refresh()
}
async function remove() {
  const result = await run(() => api(cpaManagementUrl(`plugins/${encodeURIComponent(removeId.value)}`), { method: 'DELETE' }), '插件已移除')
  if (result.ok) { removeId.value = ''; await refresh() }
}
async function readQuota(refreshQuota = false) {
  if (!quotaPlugin.value || !quotaAuthIndex.value.trim()) return
  const path = cpaManagementUrl(`plugins/${encodeURIComponent(quotaPlugin.value)}/quota`)
  const result = await run(() => refreshQuota ? api(path, { method: 'POST', body: { auth_index: quotaAuthIndex.value.trim() } }) : api(path, { query: { auth_index: quotaAuthIndex.value.trim() } }))
  if (result.ok) quotaData.value = result.value
}
function menus(plugin: Record<string, unknown>) { return Array.isArray(plugin.menus) ? plugin.menus.filter((menu): menu is Record<string, unknown> => !!menu && typeof menu === 'object') : [] }
function menuHref(id: string, menu: Record<string, unknown>) {
  const path = String(menu.path || menu.url || '')
  const prefix = `/v0/resource/plugins/${id}/`
  if (!path.startsWith(prefix) || path.includes('..') || /[\\\u0000-\u001f]/.test(path)) return ''
  return '/api/cpa/console' + path
}
</script>
<template>
  <section class="table-panel"><div class="table-toolbar"><span class="status-badge" :class="root.plugins_enabled ? 'green' : 'neutral'">原生插件总开关：{{ root.plugins_enabled ? '开启' : '关闭' }}</span><button class="button small" :disabled="busy || !data" @click="toggleAll">{{ root.plugins_enabled ? '关闭总开关' : '开启总开关' }}</button><button class="button small" :disabled="busy || pending" @click="refresh()">重新读取</button><NuxtLink to="/cpa/oauth" class="button small">OAuth 登录中心</NuxtLink><NuxtLink to="/cpa/quota" class="button small">额度中心</NuxtLink><span class="toolbar-meta">{{ plugins.length }} 个插件</span></div>
    <AppState v-if="error" :error="error" @retry="refresh()" /><AppState v-else-if="pending && !data" loading /><AppState v-else-if="!plugins.length" title="尚未发现原生插件" description="可在插件商店安装插件，或配置 CPA 原生插件目录。" />
    <div v-else class="table-scroll"><table class="data-table"><thead><tr><th>插件</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="plugin in plugins" :key="cpaDisplay(plugin.id)">
      <td><strong class="nexus-table-name">{{ cpaDisplay(plugin.id) }}</strong><div class="cell-secondary">{{ cpaDisplay(plugin.version || (plugin.metadata as Record<string, unknown> | undefined)?.version, '版本未返回') }}</div></td>
      <td><span class="status-badge" :class="plugin.effective_enabled ? 'green' : plugin.enabled ? 'amber' : 'neutral'">{{ plugin.effective_enabled ? '运行中' : plugin.enabled ? '已配置启用' : '已停用' }}</span><div v-if="plugin.error" class="cell-error">{{ cpaDisplay(plugin.error) }}</div></td>
      <td><div class="nexus-table-actions"><button class="button small" :disabled="busy" @click="toggle(cpaDisplay(plugin.id, ''), !plugin.enabled)">{{ plugin.enabled ? '停用' : '启用' }}</button><button class="button small" @click="selectedId = cpaDisplay(plugin.id, '')">配置</button><button v-if="plugin.supports_quota" class="button small" @click="quotaPlugin = cpaDisplay(plugin.id, ''); quotaData = null">额度</button><button class="button small danger" :disabled="busy" @click="removeId = cpaDisplay(plugin.id, '')">移除</button><template v-for="(menu, i) in menus(plugin)" :key="i"><a v-if="plugin.effective_enabled && menuHref(cpaDisplay(plugin.id, ''), menu)" :href="menuHref(cpaDisplay(plugin.id, ''), menu)" target="_blank" rel="noopener noreferrer" class="button small">{{ cpaDisplay(menu.menu || menu.title || menu.name || menu.label, '插件页面') }}<UIcon name="i-ph-arrow-square-out-bold" /></a></template></div></td>
    </tr></tbody></table></div>
  </section>
  <CpaResourceEditor v-if="selectedId" :key="selectedId" class="section-gap" :path="`config/plugins/configs/${encodeURIComponent(selectedId)}`" :title="`${selectedId} 配置`" description="插件字段由插件定义，保存后由内核加载。部分插件变更需要重启内核。" writable allow-create />
  <section v-if="quotaPlugin" class="panel section-gap"><div class="panel-heading"><h2>{{ quotaPlugin }} 额度</h2><button class="button small" @click="quotaPlugin = ''">收起</button></div><form class="nexus-form-line" @submit.prevent="readQuota()"><label class="field"><span>凭证 auth_index</span><input v-model="quotaAuthIndex" required placeholder="从凭证详情中复制"></label><button class="button" :disabled="busy || !quotaAuthIndex.trim()">读取额度</button><button type="button" class="button" :disabled="busy || !quotaAuthIndex.trim()" @click="readQuota(true)">刷新额度</button></form><JsonViewer v-if="quotaData !== null" :value="quotaData" title="插件返回的额度记录" /></section>
  <details class="raw-details section-gap"><summary><UIcon name="i-ph-code-bold" />插件发现记录与菜单信息</summary><JsonViewer :value="data" title="CPA 返回的原生插件记录" /></details><p class="panel-note">平台模块和 CPA 原生插件分别管理。插件页面、子资源和原生管理接口通过当前管理员会话访问完整内核。</p>
  <AppDialog v-model="removeOpen" title="移除原生插件" :description="`移除 ${removeId} 的插件文件和保存配置。`" :close-disabled="busy"><p class="nexus-description">某些插件无法在运行中卸载，内核会返回需要重启的状态。</p><template #footer><button class="button" :disabled="busy" @click="removeId = ''">取消</button><button class="button danger-solid" :disabled="busy" @click="remove">移除插件</button></template></AppDialog>
</template>
