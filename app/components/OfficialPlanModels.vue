<script setup lang="ts">
import type { OfficialCatalogModel, OfficialCatalogView, OfficialPlanAccess, OfficialEndpoint } from '#shared/official-catalog'

const props = defineProps<{ catalog: OfficialCatalogView; selectedPlanId: string }>()
const search = ref('')
const vendor = ref('')
const endpoint = ref('')
const inclusion = ref('')
const showMatrix = ref(false)
const page = ref(1)
const pageSize = 25
const vendors = computed(() => [...new Set(props.catalog.models.map(model => model.vendor).filter((value): value is string => Boolean(value)))].sort())
const endpoints = computed(() => [...new Set(props.catalog.models.flatMap(model => model.supportedEndpoints))].sort())
const selectedPlan = computed(() => props.catalog.plans.find(plan => plan.id === props.selectedPlanId))
const unknownAccess: OfficialPlanAccess = { included: null, apiAccess: null, allowanceUsd: null, paygEligible: null, source: null, apiSource: null, allowanceSource: null, paygSource: null, checkedAt: null }
function access(model: OfficialCatalogModel, planId = props.selectedPlanId) { return model.planAccess[planId] || unknownAccess }
function inclusionLabel(value: OfficialPlanAccess) { return value.included === true ? '套餐内' : value.included === false ? '套餐外' : '未公布' }
function apiLabel(value: OfficialPlanAccess) { return value.apiAccess === true ? '支持 API' : value.apiAccess === false ? '不支持 API' : 'API 未公布' }
function paygLabel(value: OfficialPlanAccess) { return value.paygEligible === true ? '支持按量计费' : value.paygEligible === false ? '不支持按量计费' : '按量规则未公布' }
function allowanceLabel(value: OfficialPlanAccess) { return value.allowanceUsd !== null ? `$${formatNumber(value.allowanceUsd)}` : '未公布' }
function endpointLabel(value: OfficialEndpoint) { return `/provider/v1/${value}` }
function apiListed(model: OfficialCatalogModel) { return model.apiCatalogListed === true || (model.apiCatalogListed === undefined && model.sources.includes('https://api.commandcode.ai/provider/v1/models')) }
function websiteListed(model: OfficialCatalogModel) { const source = props.catalog.sources.find(item => item.id === 'website-models'); return !!source && model.sources.includes(source.url) }
function sourceLabel(model: OfficialCatalogModel) {
  if (apiListed(model)) return websiteListed(model) ? 'API 与官网' : '仅 API 目录'
  if (model.apiDocumented) return websiteListed(model) ? '官网与 API 文档' : 'API 文档'
  return '仅官网 · API 未公布'
}
function sourceTitle(value: OfficialPlanAccess) { return `核对于 ${formatDate(value.checkedAt)}` }
const counts = computed(() => ({
  api: props.catalog.models.filter(apiListed).length,
  included: props.catalog.models.filter(model => access(model).included === true).length,
  excluded: props.catalog.models.filter(model => access(model).included === false).length,
  unknown: props.catalog.models.filter(model => access(model).included === null).length,
}))
const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  return props.catalog.models.filter(model => {
    const planAccess = access(model)
    return (!q || model.name.toLowerCase().includes(q) || model.id.toLowerCase().includes(q))
      && (!vendor.value || model.vendor === vendor.value)
      && (!endpoint.value || model.supportedEndpoints.includes(endpoint.value as OfficialEndpoint))
      && (!inclusion.value || (inclusion.value === 'included' && planAccess.included === true) || (inclusion.value === 'excluded' && planAccess.included === false) || (inclusion.value === 'unknown' && planAccess.included === null))
  })
})
const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize)))
const visibleModels = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize))
watch([search, vendor, endpoint, inclusion, () => props.selectedPlanId], () => { page.value = 1 })
watch(pageCount, count => { if (page.value > count) page.value = count })
</script>

<template>
  <section class="table-panel official-model-panel" aria-labelledby="official-model-title">
    <div class="official-model-heading"><div><h2 id="official-model-title">{{ selectedPlan?.name || '所选套餐' }} 的模型范围</h2><p>{{ formatNumber(catalog.models.length) }} 个精确模型 ID · API 目录 {{ formatNumber(counts.api) }} 个</p></div><div class="official-model-counts" aria-label="套餐范围统计"><span>套餐内 <strong>{{ formatNumber(counts.included) }}</strong></span><span>套餐外 <strong>{{ formatNumber(counts.excluded) }}</strong></span><span>未公布 <strong>{{ formatNumber(counts.unknown) }}</strong></span></div></div>
    <div class="table-toolbar official-model-filters"><label class="search-field"><UIcon name="i-ph-magnifying-glass-bold" /><input v-model="search" placeholder="搜索模型名称或精确 ID" aria-label="搜索官方模型"></label><select v-model="vendor" aria-label="按模型厂商筛选"><option value="">全部厂商</option><option v-for="item in vendors" :key="item" :value="item">{{ item }}</option></select><select v-model="endpoint" aria-label="按调用端点筛选"><option value="">全部端点</option><option v-for="item in endpoints" :key="item" :value="item">{{ endpointLabel(item) }}</option></select><select v-model="inclusion" aria-label="按套餐范围筛选"><option value="">全部范围</option><option value="included">套餐内</option><option value="excluded">套餐外</option><option value="unknown">未公布</option></select></div>

    <AppState v-if="!catalog.models.length" icon="i-ph-cube-bold" title="尚未获取官方模型目录" description="刷新官方信息后查看模型。来源未返回的信息会显示为未公布。" />
    <AppState v-else-if="!filtered.length" icon="i-ph-magnifying-glass-bold" title="未找到匹配模型" description="试试其他名称、厂商、端点或套餐范围。" />
    <template v-else>
      <div class="table-scroll official-selected-table"><table class="data-table"><caption class="sr-only">{{ selectedPlan?.name }} 套餐的官方模型与 API 规则</caption><thead><tr><th>模型与来源</th><th>套餐范围</th><th>API 与按量规则</th><th>模型额度</th><th>官方端点</th></tr></thead><tbody><tr v-for="model in visibleModels" :key="model.id"><td><strong>{{ model.name }}</strong><div class="cell-secondary mono official-model-id">{{ model.id }}</div><div class="official-model-origin"><span>{{ model.vendor || '厂商未公布' }}</span><span>{{ sourceLabel(model) }}</span></div></td><td><span class="status-badge" :class="access(model).included === true ? 'green' : ''">{{ inclusionLabel(access(model)) }}</span><a v-if="access(model).source" :href="access(model).source!" :title="sourceTitle(access(model))" target="_blank" rel="noopener noreferrer" class="text-link official-rule-source">官方规则<UIcon name="i-ph-arrow-up-right-bold" /></a></td><td><span :class="{ 'official-api-disabled': access(model).apiAccess === false }">{{ apiLabel(access(model)) }}</span><div class="cell-secondary">{{ paygLabel(access(model)) }}</div><div class="official-rule-links"><a v-if="access(model).apiSource" :href="access(model).apiSource!" target="_blank" rel="noopener noreferrer" class="text-link official-rule-source">API 来源<UIcon name="i-ph-arrow-up-right-bold" /></a><a v-if="access(model).paygSource" :href="access(model).paygSource!" target="_blank" rel="noopener noreferrer" class="text-link official-rule-source">按量来源<UIcon name="i-ph-arrow-up-right-bold" /></a></div></td><td><span class="mono">{{ allowanceLabel(access(model)) }}</span><a v-if="access(model).allowanceSource" :href="access(model).allowanceSource!" target="_blank" rel="noopener noreferrer" class="text-link official-rule-source">额度来源<UIcon name="i-ph-arrow-up-right-bold" /></a></td><td><div class="official-endpoint-list"><span v-for="item in model.supportedEndpoints" :key="item" class="mono">{{ endpointLabel(item) }}</span><span v-if="!model.supportedEndpoints.length">未公布</span></div></td></tr></tbody></table></div>

      <ul class="official-mobile-models"><li v-for="model in visibleModels" :key="model.id"><div class="official-mobile-model-heading"><strong>{{ model.name }}</strong><span class="status-badge" :class="access(model).included === true ? 'green' : ''">{{ inclusionLabel(access(model)) }}</span></div><p class="mono official-model-id">{{ model.id }}</p><p class="official-mobile-origin">{{ model.vendor || '厂商未公布' }} · {{ sourceLabel(model) }}</p><dl><div><dt>API 调用</dt><dd :class="{ 'official-api-disabled': access(model).apiAccess === false }">{{ apiLabel(access(model)) }}</dd></div><div><dt>按量计费</dt><dd>{{ paygLabel(access(model)) }}</dd></div><div><dt>模型额度</dt><dd class="mono">{{ allowanceLabel(access(model)) }}</dd></div><div><dt>官方端点</dt><dd><div class="official-endpoint-list"><span v-for="item in model.supportedEndpoints" :key="item" class="mono">{{ endpointLabel(item) }}</span><span v-if="!model.supportedEndpoints.length">未公布</span></div></dd></div></dl><div class="official-rule-links"><a v-if="access(model).source" :href="access(model).source!" :title="sourceTitle(access(model))" target="_blank" rel="noopener noreferrer" class="text-link official-rule-source">套餐规则<UIcon name="i-ph-arrow-up-right-bold" /></a><a v-if="access(model).apiSource" :href="access(model).apiSource!" target="_blank" rel="noopener noreferrer" class="text-link official-rule-source">API 来源<UIcon name="i-ph-arrow-up-right-bold" /></a><a v-if="access(model).paygSource" :href="access(model).paygSource!" target="_blank" rel="noopener noreferrer" class="text-link official-rule-source">按量来源<UIcon name="i-ph-arrow-up-right-bold" /></a><a v-if="access(model).allowanceSource" :href="access(model).allowanceSource!" target="_blank" rel="noopener noreferrer" class="text-link official-rule-source">额度来源<UIcon name="i-ph-arrow-up-right-bold" /></a></div></li></ul>

      <div class="official-pagination"><span>显示 {{ (page - 1) * pageSize + 1 }}–{{ Math.min(page * pageSize, filtered.length) }} / {{ formatNumber(filtered.length) }} 个</span><div><button class="button small" :disabled="page <= 1" aria-label="上一页模型" @click="page--"><UIcon name="i-ph-caret-left-bold" />上一页</button><span>{{ page }} / {{ pageCount }}</span><button class="button small" :disabled="page >= pageCount" aria-label="下一页模型" @click="page++">下一页<UIcon name="i-ph-caret-right-bold" /></button></div></div>
    </template>

    <div class="official-model-note"><p>“套餐外”仅表示未包含在该订阅内，不代表账号一定无法调用。API 支持、按量资格和额度分别显示官方已公布的信息；“未公布”保持未知。模型额度为官方套餐说明，并非账号实时余额。</p><p>只在官网展示、且没有 API 文档或清单记录的模型，其 API 端点保持未公布。仅 API 目录出现的模型，其套餐范围保持未知，除非有官方的明确规则。</p></div>

    <div v-if="catalog.plans.length && filtered.length" class="official-matrix-control"><button class="text-link" :aria-expanded="showMatrix" aria-controls="official-plan-matrix" @click="showMatrix = !showMatrix"><UIcon :name="showMatrix ? 'i-ph-caret-up-bold' : 'i-ph-table-bold'" />{{ showMatrix ? '收起套餐对照表' : '展开全部套餐对照表' }}</button><span>对照表使用当前筛选和分页</span></div>
    <div v-if="showMatrix && filtered.length" id="official-plan-matrix" class="table-scroll official-matrix-scroll" tabindex="0" aria-label="横向滚动查看全部套餐"><table class="data-table official-matrix"><caption class="sr-only">所有官方套餐的模型范围对照</caption><thead><tr><th>模型</th><th v-for="plan in catalog.plans" :key="plan.id">{{ plan.name }}</th></tr></thead><tbody><tr v-for="model in visibleModels" :key="model.id"><td><strong>{{ model.name }}</strong><div class="cell-secondary mono official-model-id">{{ model.id }}</div></td><td v-for="plan in catalog.plans" :key="plan.id"><span class="status-badge" :class="access(model, plan.id).included === true ? 'green' : ''">{{ inclusionLabel(access(model, plan.id)) }}</span><div class="cell-secondary">{{ apiLabel(access(model, plan.id)) }}</div></td></tr></tbody></table></div>
  </section>
</template>
