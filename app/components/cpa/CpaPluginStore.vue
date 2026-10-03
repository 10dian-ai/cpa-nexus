<script setup lang="ts">
const api = useRequestFetch()
const catalog = ref<unknown>(null)
const plugins = computed(() => cpaEntries(catalog.value, 'plugins'))
const sourceErrors = computed(() => cpaEntries(catalog.value, 'source_errors'))
const search = ref('')
const visible = computed(() => plugins.value.filter(plugin => [plugin.id, plugin.name, plugin.description].some(value => cpaDisplay(value, '').toLowerCase().includes(search.value.toLowerCase()))))
const id = ref('')
const source = ref('')
const version = ref('')
const resultData = ref<unknown>(null)
const { busy, run } = useApiAction()
async function readStore() {
  const result = await run(() => api(cpaManagementUrl('plugins/store')))
  if (result.ok) catalog.value = result.value
}
async function install() {
  if (!id.value.trim()) return
  const result = await run(() => api(cpaManagementUrl(`plugins/store/${encodeURIComponent(id.value.trim())}/install`), { method: 'POST', query: source.value.trim() ? { source: source.value.trim() } : undefined, body: version.value.trim() ? { version: version.value.trim() } : {} }), '插件安装请求已完成')
  if (result.ok) { resultData.value = result.value; await readStore() }
}
</script>
<template>
  <section class="panel"><div class="panel-heading"><h2>CPA 原生插件商店</h2><button class="button small" :disabled="busy" @click="readStore">读取商店目录</button></div><p class="nexus-description">目录、安装状态和版本来自 CPA 配置的商店源。选择来源与版本后由 CPA 下载、安装并启用插件。</p>
    <p v-for="item in sourceErrors" :key="cpaDisplay(item.source_id)" class="inline-error">{{ cpaDisplay(item.source_name || item.source_id) }}：{{ cpaDisplay(item.message) }}</p>
    <template v-if="catalog"><label class="search-field"><UIcon name="i-ph-magnifying-glass-bold" /><input v-model="search" aria-label="搜索商店插件" placeholder="搜索插件名称或功能"></label><div v-if="visible.length" class="table-scroll section-gap"><table class="data-table"><thead><tr><th>插件</th><th>来源 / 版本</th><th>操作</th></tr></thead><tbody><tr v-for="plugin in visible" :key="cpaDisplay(plugin.store_id || `${plugin.source_id}-${plugin.id}`)"><td class="wrap-cell"><strong>{{ cpaDisplay(plugin.name || plugin.id) }}</strong><div class="cell-secondary">{{ cpaDisplay(plugin.description, '暂无描述') }}</div></td><td><span>{{ cpaDisplay(plugin.source_name || plugin.source_id) }}</span><div class="cell-secondary mono">{{ cpaDisplay(plugin.version) }}</div></td><td><button class="button small" :disabled="busy" @click="id = cpaDisplay(plugin.id, ''); source = cpaDisplay(plugin.source_id, ''); version = cpaDisplay(plugin.version, '')">选择版本</button></td></tr></tbody></table></div><p v-else class="nexus-empty-note">目录中没有匹配的插件。</p><details class="raw-details section-gap"><summary>完整商店目录与安装状态</summary><JsonViewer :value="catalog" title="实时商店目录" /></details></template><p v-else class="nexus-empty-note">点击读取获取可用插件和商店源状态。</p>
    <h3 class="nexus-subheading">安装或更新插件</h3><form class="form-stack" @submit.prevent="install"><div class="form-row"><label class="field"><span>插件 ID</span><input v-model="id" required placeholder="填写目录中的插件 ID" :disabled="busy"></label><label class="field"><span>商店来源 ID</span><input v-model="source" placeholder="可选，同名插件需要指定来源" :disabled="busy"></label></div><label class="field"><span>版本</span><input v-model="version" placeholder="留空使用商店默认版本" :disabled="busy"><small>安装会下载可执行插件。请依据商店目录确认插件及其来源。</small></label><div><button class="button primary" :disabled="busy || !id.trim()"><UIcon v-if="busy" name="i-ph-circle-notch-bold" class="spinning" />安装 / 更新</button></div></form><JsonViewer v-if="resultData" class="section-gap" :value="resultData" title="安装结果" /></section>
</template>
