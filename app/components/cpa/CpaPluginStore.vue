<script setup lang="ts">
import { pluginExternalLink, pluginObject } from '~/utils/cpa-plugins'

const api = useRequestFetch()
const { data: catalog, pending, error, refresh } = await useFetch<unknown>(cpaManagementUrl('plugins/store'), { key: 'cpa-plugin-store' })
const plugins = computed(() => cpaEntries(catalog.value, 'plugins'))
const sourceErrors = computed(() => cpaEntries(catalog.value, 'source_errors'))
const sources = computed(() => cpaEntries(catalog.value, 'sources'))
const search = ref('')
const sourceFilter = ref('')
const statusFilter = ref('all')
const visible = computed(() => {
  const q = search.value.trim().toLowerCase()
  return plugins.value.filter(plugin => (!q || [plugin.id, plugin.name, plugin.description, ...(Array.isArray(plugin.tags) ? plugin.tags : [])].some(value => cpaDisplay(value, '').toLowerCase().includes(q)))
    && (!sourceFilter.value || plugin.source_id === sourceFilter.value)
    && (statusFilter.value === 'all' || (statusFilter.value === 'installed' && plugin.installed === true) || (statusFilter.value === 'updates' && plugin.update_available === true) || (statusFilter.value === 'uninstalled' && !plugin.installed)))
})
const counts = computed(() => ({ installed: plugins.value.filter(plugin => plugin.installed).length, updates: plugins.value.filter(plugin => plugin.update_available).length }))
const page = ref(1)
const pageSize = 25
const displayed = computed(() => visible.value.slice((page.value - 1) * pageSize, page.value * pageSize))
watch([search, sourceFilter, statusFilter], () => { page.value = 1 })
watch(() => visible.value.length, count => { page.value = Math.min(page.value, Math.max(1, Math.ceil(count / pageSize))) })
const id = ref('')
const source = ref('')
const version = ref('')
const installOpen = ref(false)
const details = ref<Record<string, unknown> | null>(null)
const detailOpen = computed({ get: () => !!details.value, set: value => { if (!value) details.value = null } })
const resultData = ref<unknown>(null)
const installResult = computed(() => pluginObject(resultData.value))
const { busy, run } = useApiAction()
function choose(plugin?: Record<string, unknown>) {
  id.value = cpaDisplay(plugin?.id, '')
  source.value = cpaDisplay(plugin?.source_id, '')
  version.value = cpaDisplay(plugin?.version, '')
  details.value = null
  installOpen.value = true
}
async function install() {
  if (!id.value.trim()) return
  const result = await run(() => api(cpaManagementUrl(`plugins/store/${encodeURIComponent(id.value.trim())}/install`), { method: 'POST', query: source.value.trim() ? { source: source.value.trim() } : undefined, body: version.value.trim() ? { version: version.value.trim() } : {}, timeout: 120_000 }), '插件安装请求已完成')
  if (result.ok) { resultData.value = result.value; installOpen.value = false; await Promise.all([refresh(), refreshNuxtData(['cpa-installed-plugins', 'cpa-management-capabilities'])]) }
}
function installationLabel(plugin: Record<string, unknown>) {
  if (plugin.effective_enabled) return '运行中'
  if (plugin.installed && !plugin.registered) return '已安装，待内核加载'
  if (plugin.installed) return plugin.enabled ? '已配置启用' : '已安装，已停用'
  return '未安装'
}
function sourceStatus(plugin: Record<string, unknown>) {
  return ({ matched: '与已安装来源一致', different: '与已安装来源不同', unknown: '已安装来源未确认' } as Record<string, string>)[cpaDisplay(plugin.install_source_status, '')] || ''
}
function platforms(plugin: Record<string, unknown>) {
  return cpaEntries(plugin, 'platforms').map(platform => [platform.goos, platform.goarch].filter(Boolean).join('/')).join('、') || '商店未公布支持平台'
}
</script>

<template>
  <section class="table-panel">
    <div class="table-toolbar"><div><h2>CPA 原生插件商店</h2><p class="small-text muted">{{ plugins.length }} 个商店条目 · 已安装 {{ counts.installed }} · 可更新 {{ counts.updates }}</p></div><div class="inline-actions toolbar-meta"><NuxtLink to="/cpa/plugins?tab=config" class="button small">商店来源与认证配置</NuxtLink><button class="button small" :disabled="busy || pending" @click="refresh()"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: pending }" />刷新商店</button><button class="button small" :disabled="busy" @click="choose()">按 ID 安装</button></div></div>
    <div class="table-toolbar"><label class="search-field"><UIcon name="i-ph-magnifying-glass-bold" /><input v-model="search" aria-label="搜索商店插件" placeholder="搜索全部插件名称、功能或标签"></label><select v-model="sourceFilter" aria-label="筛选插件商店来源"><option value="">全部来源</option><option v-for="item in sources" :key="cpaDisplay(item.id)" :value="cpaDisplay(item.id)">{{ cpaDisplay(item.name || item.id) }}</option></select><select v-model="statusFilter" aria-label="筛选商店安装状态"><option value="all">全部插件</option><option value="installed">已安装</option><option value="updates">可更新</option><option value="uninstalled">未安装</option></select></div>
    <div v-if="sourceErrors.length" class="store-source-errors"><p v-for="item in sourceErrors" :key="cpaDisplay(item.source_id)" class="inline-error">{{ cpaDisplay(item.source_name || item.source_id) }}：{{ cpaDisplay(item.message) }}</p></div>
    <AppState v-if="error" :error="error" @retry="refresh()" /><AppState v-else-if="pending && !catalog" loading /><AppState v-else-if="!visible.length" compact title="没有匹配的插件" description="换一个关键词、来源或安装状态。商店条目由 CPA 的所有配置来源实时返回。" />
    <div v-else class="table-scroll"><table class="data-table"><thead><tr><th>插件</th><th>来源 / 版本</th><th>安装状态</th><th>操作</th></tr></thead><tbody><tr v-for="plugin in displayed" :key="cpaDisplay(plugin.store_id || `${plugin.source_id}-${plugin.id}`)"><td class="wrap-cell"><strong>{{ cpaDisplay(plugin.name || plugin.id) }}</strong><div class="cell-secondary mono">{{ cpaDisplay(plugin.id) }}</div><p class="store-description">{{ cpaDisplay(plugin.description, '暂无描述') }}</p></td><td><span>{{ cpaDisplay(plugin.source_name || plugin.source_id) }}</span><div class="cell-secondary">商店 {{ cpaDisplay(plugin.version, '版本未公布') }}</div><div v-if="plugin.installed" class="cell-secondary">已安装 {{ cpaDisplay(plugin.installed_version, '版本未返回') }}</div><div v-if="sourceStatus(plugin)" class="cell-secondary">{{ sourceStatus(plugin) }}</div></td><td><span class="status-badge" :class="plugin.effective_enabled ? 'green' : 'neutral'">{{ installationLabel(plugin) }}</span><div v-if="plugin.update_available" class="cell-secondary">发现新版本</div><div v-if="plugin.auth_required" class="cell-secondary">{{ plugin.auth_configured ? '已配置商店认证' : '需要商店认证' }}</div></td><td><div class="nexus-table-actions"><button class="button small" :disabled="busy" @click="details = plugin">详情</button><button class="button small" :disabled="busy || (plugin.auth_required === true && plugin.auth_configured !== true)" @click="choose(plugin)">{{ plugin.update_available ? '更新' : plugin.installed ? '选择版本' : '安装' }}</button></div></td></tr></tbody></table></div>
    <AppPagination v-if="catalog" v-model:page="page" :page-size="pageSize" :total="visible.length" :loading="pending || busy" />
    <div class="table-footnote">全部插件类型均由 CPA 安装和加载，包括渠道、登录、配额、路由、请求处理及插件自带页面。这里没有固定插件名单。</div>
  </section>
  <section v-if="resultData" class="panel section-gap"><div class="panel-heading"><h2>安装结果</h2><NuxtLink to="/cpa/plugins?tab=installed" class="button small">查看本地插件</NuxtLink></div><div v-if="installResult.restart_required" class="notice warning-notice" role="status"><UIcon name="i-ph-info-bold" /><p>{{ cpaDisplay(installResult.id) }} {{ cpaDisplay(installResult.version) }} 已安装，需要重启 CPA 内核后生效。当前面板记录的是内核真实返回状态。</p></div><p v-else class="nexus-description">安装已完成。是否正在运行，请以本地插件的实际注册与运行状态为准。</p><JsonViewer :value="resultData" title="CPA 安装返回" /></section>
  <details v-if="catalog" class="raw-details section-gap"><summary>完整商店目录、平台与安装状态</summary><JsonViewer :value="catalog" title="实时商店目录" /></details>

  <AppDialog v-model="detailOpen" :title="cpaDisplay(details?.name || details?.id, '插件详情')" wide><template v-if="details"><p class="nexus-description">{{ cpaDisplay(details.description) }}</p><dl class="nexus-definition-list"><div><dt>插件 ID</dt><dd class="mono">{{ cpaDisplay(details.id) }}</dd></div><div><dt>商店来源</dt><dd>{{ cpaDisplay(details.source_name || details.source_id) }}</dd></div><div><dt>作者</dt><dd>{{ cpaDisplay(details.author) }}</dd></div><div><dt>许可证</dt><dd>{{ cpaDisplay(details.license, '未公布') }}</dd></div><div><dt>支持平台</dt><dd>{{ platforms(details) }}</dd></div><div><dt>安装方式</dt><dd>{{ cpaDisplay(details.install_type) }}</dd></div><div><dt>商店认证</dt><dd>{{ details.auth_required ? details.auth_configured ? '需要认证，已配置' : '需要认证，尚未配置' : '无需认证' }}</dd></div></dl><div class="inline-actions section-gap"><a v-if="pluginExternalLink(details.homepage)" :href="pluginExternalLink(details.homepage)" target="_blank" rel="noopener noreferrer" class="text-link">插件主页<UIcon name="i-ph-arrow-up-right-bold" /></a><a v-if="pluginExternalLink(details.repository)" :href="pluginExternalLink(details.repository)" target="_blank" rel="noopener noreferrer" class="text-link">源代码<UIcon name="i-ph-arrow-up-right-bold" /></a></div><details class="raw-details section-gap"><summary>全部原生元数据</summary><JsonViewer :value="details" title="商店返回条目" /></details></template><template #footer><button class="button" @click="details = null">关闭</button><button v-if="details" class="button primary" :disabled="busy || (details.auth_required === true && details.auth_configured !== true)" @click="choose(details)">{{ details.update_available ? '选择更新版本' : '选择安装版本' }}</button></template></AppDialog>
  <AppDialog v-model="installOpen" title="安装 / 更新插件" description="来源与版本会交给当前 CPA 内核处理。安装完成后，面板会显示是否需要重启。" :close-disabled="busy"><form id="plugin-store-install" class="form-stack" @submit.prevent="install"><label class="field"><span>插件 ID</span><input v-model="id" required :disabled="busy" /></label><label class="field"><span>商店来源 ID</span><input v-model="source" :disabled="busy" placeholder="同名插件需指定来源" /></label><label class="field"><span>版本</span><input v-model="version" :disabled="busy" placeholder="留空使用商店默认版本" /></label></form><template #footer><button class="button" :disabled="busy" @click="installOpen = false">取消</button><button class="button primary" form="plugin-store-install" :disabled="busy || !id.trim()"><UIcon v-if="busy" name="i-ph-circle-notch-bold" class="spinning" />安装 / 更新</button></template></AppDialog>
</template>

<style scoped>
.store-description { font-size: 11px; line-height: 1.8; color: var(--muted); margin-top: 7px; overflow-wrap: anywhere; }
.store-source-errors { padding: 12px 20px; }
</style>
