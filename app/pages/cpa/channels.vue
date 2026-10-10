<script setup lang="ts">
useHead({ title: '渠道与模型 · CPA Nexus' })
const tab = ref('providers')
const channel = ref('codex')
const upstream = ref('openai')
const providerView = ref<'all' | 'family'>('all')
const providerFamily = ref('openai-compatibility')
const selectedProviderFamily = ref('')
const selectedUpstream = ref('')
const modelData = ref<unknown>(null)
const { busy, run } = useApiAction()
const validUpstream = computed(() => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(upstream.value.trim()))
const validProvider = computed(() => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(providerFamily.value.trim()))
const providerFamilies = ['gemini', 'interactions', 'codex', 'meta', 'xai', 'claude', 'vertex', 'openai-compatibility']
function selectProviderFamily() { if (validProvider.value) selectedProviderFamily.value = providerFamily.value.trim() }
function selectUpstream() { if (validUpstream.value) selectedUpstream.value = upstream.value.trim() }
async function readModels() {
  if (!channel.value.trim()) return
  const result = await run(() => $fetch(cpaManagementUrl(`routing/model-definitions/${encodeURIComponent(channel.value.trim())}`)))
  if (result.ok) modelData.value = result.value
}
</script>
<template>
  <AppPageHeader title="渠道与模型" description="配置 CPA 上游渠道、调度行为和模型映射。"><NuxtLink to="/groups/accounts?module=cpa" class="button"><UIcon name="i-ph-tree-structure-bold" />凭证分组</NuxtLink></AppPageHeader>
  <CpaGate><div class="nexus-tabs" role="tablist" aria-label="渠道设置"><button v-for="item in [{ id: 'providers', label: 'API 渠道' }, { id: 'upstream', label: '共享上游设置' }, { id: 'routing', label: '路由与重试' }, { id: 'aliases', label: 'OAuth 模型映射' }, { id: 'catalog', label: '模型定义' }]" :key="item.id" role="tab" :aria-selected="tab === item.id" @click="tab = item.id">{{ item.label }}</button></div>
    <template v-if="tab === 'providers'"><div class="nexus-tabs" role="tablist" aria-label="API 渠道视图"><button role="tab" :aria-selected="providerView === 'all'" @click="providerView = 'all'">全部渠道 JSON</button><button role="tab" :aria-selected="providerView === 'family'" @click="providerView = 'family'">单渠道编辑</button></div><CpaResourceEditor v-if="providerView === 'all'" key="providers" path="config/api-keys" title="上游渠道配置" description="编辑全部 provider 分组。列表支持 api-key、base-url、headers、models、别名、重试、WebSocket、Cloak 和自定义字段。" writable allow-create /><template v-else><form class="nexus-form-line" @submit.prevent="selectProviderFamily"><label class="field"><span>渠道族</span><input v-model="providerFamily" list="cpa-provider-families" placeholder="openai-compatibility" required pattern="[a-zA-Z0-9._-]+"><datalist id="cpa-provider-families"><option v-for="item in providerFamilies" :key="item" :value="item" /></datalist><small>直接编辑单个渠道族，保存支持新增、替换和删除整组配置。可输入插件或未来版本提供的其他渠道族。</small></label><button class="button" :disabled="!validProvider">读取渠道</button></form><CpaResourceEditor v-if="selectedProviderFamily" :key="`provider-${selectedProviderFamily}`" :path="`config/api-keys/${selectedProviderFamily}`" :title="`渠道族 · ${selectedProviderFamily}`" description="该渠道族的每个分组可包含密钥、代理、优先级、权重、模型映射、请求规则和协议选项。" writable allow-create deletable /></template></template>
    <template v-else-if="tab === 'upstream'"><form class="nexus-form-line" @submit.prevent="selectUpstream"><label class="field"><span>提供商标识</span><input v-model="upstream" placeholder="openai" required pattern="[a-zA-Z0-9._-]+"><small>官方管理中心的共享提供商设置路径，例如 openai、anthropic 或自定义渠道。</small></label><button class="button" :disabled="!validUpstream">读取设置</button></form><CpaResourceEditor v-if="selectedUpstream" :key="`upstream-${selectedUpstream}`" :path="`config/upstream/${selectedUpstream}`" :title="`共享上游设置 · ${selectedUpstream}`" description="这里修改提供商级别的共享设置；密钥分组仍在 API 渠道页维护。" writable allow-create deletable /></template>
    <CpaResourceEditor v-else-if="tab === 'routing'" key="routing" path="config/routing" title="路由配置" description="管理选号策略、会话亲和、重试和冷却规则。修改规则后由 CPA 执行。" writable allow-create />
    <CpaResourceEditor v-else-if="tab === 'aliases'" key="oauth" path="config/oauth" title="OAuth 模型映射与排除规则" description="model-alias、excluded-models 和 providers 配置均来自当前内核。别名配置与 API 渠道中的模型配置分别生效。" writable allow-create />
    <section v-else class="panel"><div class="panel-heading"><h2>渠道模型定义</h2></div><p class="nexus-description">读取 CPA 随内核提供的静态模型定义。此数据描述模型能力，不代表账号已获得调用权限。</p><form class="nexus-form-line" @submit.prevent="readModels"><label class="field"><span>渠道标识</span><input v-model="channel" placeholder="codex" required></label><button class="button" :disabled="busy || !channel.trim()">读取定义</button></form><JsonViewer v-if="modelData" :value="modelData" title="内核模型定义" /><p v-else class="nexus-empty-note">选择渠道并读取模型定义。</p></section>
  </CpaGate>
</template>
