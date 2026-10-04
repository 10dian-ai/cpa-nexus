<script setup lang="ts">
import type { OfficialCatalogSource } from '#shared/official-catalog'

useHead({ title: '官方模型与套餐 · CPA Nexus' })
const { data, pending, error, refresh, busy, refreshOfficial } = useOfficialCatalog()
const selectedPlanId = ref('goat')
const selectedPlan = computed(() => data.value?.plans.find(plan => plan.id === selectedPlanId.value))

watch(() => data.value?.plans, plans => {
  if (plans?.length && !plans.some(plan => plan.id === selectedPlanId.value)) selectedPlanId.value = plans[0]!.id
}, { immediate: true })

function sourceName(source: OfficialCatalogSource) {
  const names: Record<string, string> = {
    'provider-models': '官方 Provider 模型目录',
    'website-models': '官方模型网页',
    pricing: '官方订阅价格与限额',
    go: 'Go 套餐文档',
    goat: 'GOAT 套餐文档',
    pro: 'Pro 套餐文档',
    max: 'Max 套餐文档',
    provider: 'Provider API 文档',
  }
  return names[source.id] || '官方来源'
}

</script>

<template>
  <div class="official-page">
    <AppPageHeader title="官方模型与套餐" description="默认只显示所选订阅包含、且官方 API 支持的模型。">
      <button class="button" :disabled="pending || busy" @click="refreshOfficial"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: busy }" />{{ busy ? '正在检查官方来源' : '刷新可使用列表' }}</button>
    </AppPageHeader>

    <div class="notice official-notice"><UIcon name="i-ph-info-bold" /><p>后台自动更新：官方 API 目录每 5 分钟检查，GOAT 套餐网页每 15 分钟检查。点击“刷新可使用列表”会立即请求官方来源，页面每分钟读取最新结果。列表按官方套餐与精确 API 模型 ID 核对；账号额度与临时冷却另见模型观察。</p></div>

    <AppState v-if="error && !data" :error="error" @retry="refresh()" />
    <div v-else-if="!data" class="nexus-skeleton official-loading" role="status" aria-label="正在读取官方目录"><span /><span /><span /></div>
    <template v-else>
      <div v-if="error" class="notice official-warning" role="alert"><UIcon name="i-ph-warning-circle-bold" /><p>后台结果读取失败，当前保留已加载的信息。{{ apiErrorMessage(error) }}</p></div>
      <div v-if="data.stale || data.error" class="notice official-warning" role="status"><UIcon name="i-ph-warning-circle-bold" /><div><strong>{{ data.fetchedAt ? '正在显示上次成功获取的信息' : '尚未成功获取完整的官方信息' }}</strong><p>{{ data.error || '部分来源已超过更新周期，后台会继续尝试刷新。' }}</p></div></div>

      <section class="panel official-plan-panel" aria-labelledby="official-plan-title">
        <div class="official-plan-heading"><div><span class="eyebrow">订阅规则</span><h2 id="official-plan-title">选择要查看的套餐</h2></div><label class="official-plan-select"><span class="sr-only">选择官方订阅套餐</span><select v-model="selectedPlanId" :disabled="!data.plans.length"><option v-if="!data.plans.length" value="goat">尚未获取套餐</option><option v-for="plan in data.plans" :key="plan.id" :value="plan.id">{{ plan.name }}</option></select></label></div>
        <template v-if="selectedPlan">
          <dl class="official-plan-details"><div><dt>官方价格</dt><dd>{{ selectedPlan.price || '未公布' }}</dd></div><div><dt>官方额度说明</dt><dd>{{ selectedPlan.credits || '未公布' }}</dd></div><div><dt>API 调用</dt><dd><span class="status-badge" :class="selectedPlan.apiAccess === true ? 'green' : selectedPlan.apiAccess === false ? 'amber' : ''">{{ selectedPlan.apiAccess === true ? '支持 API' : selectedPlan.apiAccess === false ? '不支持 API' : '未公布' }}</span></dd></div></dl>
          <p class="official-plan-description">{{ selectedPlan.modelDescription || '官方来源尚未公布此套餐的模型范围。' }}</p>
          <div class="official-plan-source"><span>核对于 {{ formatDate(selectedPlan.checkedAt) }}</span><a :href="selectedPlan.source" target="_blank" rel="noopener noreferrer" class="text-link">套餐官方来源<UIcon name="i-ph-arrow-up-right-bold" /></a><a v-if="selectedPlan.apiSource && selectedPlan.apiSource !== selectedPlan.source" :href="selectedPlan.apiSource" target="_blank" rel="noopener noreferrer" class="text-link">API 规则来源<UIcon name="i-ph-arrow-up-right-bold" /></a></div>
        </template>
        <p v-else class="nexus-empty-note">点击“刷新官方信息”获取套餐信息。没有成功获取的数据会保持未知。</p>
      </section>

      <OfficialPlanModels :catalog="data" :selected-plan-id="selectedPlanId" />

      <section class="panel official-sources" aria-labelledby="official-source-title">
        <div class="panel-heading"><h2 id="official-source-title">官方来源与更新时间</h2><span class="muted">北京时间</span></div>
        <p class="official-source-intro">抓取失败会保留上次成功的数据，并记录失败原因。网页与 API 的模型 ID 分别核对，同名模型不会自动合并。</p>
        <ul class="official-source-list"><li v-for="source in data.sources" :key="source.id"><div class="official-source-identity"><a :href="source.url" target="_blank" rel="noopener noreferrer">{{ sourceName(source) }}<UIcon name="i-ph-arrow-up-right-bold" /></a><span class="mono">{{ source.url }}</span></div><div class="official-source-status"><span class="status-badge" :class="source.error ? 'amber' : source.fetchedAt ? 'green' : ''">{{ source.error ? '检查失败' : source.fetchedAt ? '已获取' : '尚未获取' }}</span><p>最近成功：{{ formatDate(source.fetchedAt) }}</p><p>最近检查：{{ formatDate(source.lastAttemptAt) }}<template v-if="source.modelCount !== null"> · {{ formatNumber(source.modelCount) }} 个模型</template></p></div><p v-if="source.error" class="official-source-error">{{ source.error }}</p></li></ul>
        <p v-if="!data.sources.length" class="nexus-empty-note">尚无来源检查记录。</p>
        <div class="official-source-footer"><span>目录更新于 {{ formatDate(data.fetchedAt) }}</span><NuxtLink to="/models" class="text-link">查看账号实际权限观察<UIcon name="i-ph-arrow-right-bold" /></NuxtLink></div>
      </section>
    </template>
  </div>
</template>
