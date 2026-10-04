<script setup lang="ts">
import type { ModelView } from '#shared/types'

useHead({ title: '模型权限观察 · CPA Nexus' })
const official = useOfficialCatalog()
const { data, pending, error, refresh } = await useFetch<{ items: ModelView[]; updatedAt: string | null }>('/api/models')
useLiveRefresh(refresh)
const search = ref('')
const sources = computed(() => official.data.value?.sources.filter(source => source.id === 'goat' || source.id === 'provider-models') || [])
const items = computed(() => {
  const q = search.value.trim().toLowerCase()
  return (data.value?.items || []).filter(item => !q || item.id.toLowerCase().includes(q) || item.name.toLowerCase().includes(q))
})
const refreshing = computed(() => pending.value || official.pending.value || official.busy.value)
async function refreshAvailable() {
  if (await official.refreshOfficial()) await refresh()
}
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timer = setInterval(() => { if (document.visibilityState === 'visible' && !refreshing.value) void refresh() }, 60_000)
})
onBeforeUnmount(() => { if (timer) clearInterval(timer) })
</script>

<template>
  <AppPageHeader title="模型权限观察" description="查看 GOAT 官方支持的 API 模型，以及账号池的真实可调度数量与权限观察。">
    <NuxtLink to="/official" class="button"><UIcon name="i-ph-book-open-bold" />官方模型与套餐</NuxtLink>
    <button class="button" :disabled="refreshing" @click="refreshAvailable"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: official.busy.value }" />{{ official.busy.value ? '正在检查官方来源' : '刷新可使用列表' }}</button>
  </AppPageHeader>
  <div class="notice"><UIcon name="i-ph-info-bold" /><p>无需逐个勾选模型。后台每 5 分钟检查官方 API 目录、每 15 分钟检查 GOAT 网页，自动更新可使用列表；手动刷新会请求官方来源。下方的可用、不可用、未知账号数量来自实际观察，未知权限不会推定为已确认可用。</p></div>
  <div v-if="official.data.value?.stale || official.data.value?.error" class="notice warning-notice" role="status"><UIcon name="i-ph-warning-circle-bold" /><p>当前保留上次成功获取的信息。{{ official.data.value.error || '部分官方来源已超过更新周期，后台将继续刷新。' }}</p></div>
  <AppState v-if="official.error.value" :error="official.error.value" compact @retry="official.refresh()" />
  <section v-if="sources.length" class="panel model-sync-panel" aria-label="可用模型官方同步状态">
    <div v-for="source in sources" :key="source.id"><strong>{{ source.id === 'goat' ? 'GOAT 官方订阅网页' : '官方 API 模型目录' }}</strong><span class="status-badge" :class="source.error ? 'amber' : source.fetchedAt ? 'green' : ''">{{ source.error ? '检查失败，保留历史结果' : source.fetchedAt ? '已获取' : '尚未获取' }}</span><p>最近成功：{{ formatDate(source.fetchedAt) }} · 最近检查：{{ formatDate(source.lastAttemptAt) }}</p><p v-if="source.error" class="inline-error">{{ source.error }}</p></div>
  </section>
  <section class="table-panel">
    <div class="table-toolbar"><label class="search-field"><UIcon name="i-ph-magnifying-glass-bold" /><input v-model="search" placeholder="搜索 GOAT 可用模型名称或 ID" aria-label="搜索模型"></label><span class="toolbar-meta">目录更新于 {{ formatDate(data?.updatedAt) }}</span></div>
    <AppState v-if="error" :error="error" @retry="refresh()" />
    <AppState v-else-if="!data" :loading="pending" />
    <AppState v-else-if="!items.length" icon="i-ph-cube-bold" :title="search ? '未找到匹配模型' : '尚未确认 GOAT 可使用的 API 模型'" :description="search ? '换一个名称或模型 ID 试试。' : '点击“刷新可使用列表”检查官方来源；不支持和未知的模型不会作为可用模型显示。'" />
    <div v-else class="table-scroll">
      <table class="data-table">
        <thead><tr><th>模型</th><th class="align-right">可调度账号</th><th class="align-right">已确认可用账号</th><th class="align-right">已确认不可用账号</th><th class="align-right">权限未知账号</th><th>更新于</th></tr></thead>
        <tbody><tr v-for="model in items" :key="model.id">
          <td><strong>{{ model.name }}</strong><div class="cell-secondary mono">{{ model.id }}</div></td>
          <td class="align-right"><span v-if="model.eligibleAccounts !== undefined" class="number-chip" :class="{ green: model.eligibleAccounts > 0 }">{{ formatNumber(model.eligibleAccounts) }}</span><span v-else class="muted">未读取</span><div v-if="model.unknownSubscriptionAccounts" class="cell-secondary">含 {{ formatNumber(model.unknownSubscriptionAccounts) }} 个订阅未确认账号</div></td>
          <td class="align-right"><span class="number-chip green">{{ formatNumber(model.observedAllowed) }}</span></td>
          <td class="align-right"><span class="number-chip" :class="{ red: model.observedDenied > 0 }">{{ formatNumber(model.observedDenied) }}</span></td>
          <td class="align-right"><span class="number-chip">{{ formatNumber(model.unknownAccounts) }}</span></td>
          <td class="date-text">{{ formatDate(model.updatedAt) }}</td>
        </tr></tbody>
      </table>
    </div>
    <div v-if="data" class="table-footnote">显示 {{ items.length }} / {{ data.items.length }} 个 GOAT 官方支持模型。可调度账号符合当前启用、订阅、额度与冷却条件，不代表已发送验证请求；没有账号时仍可查看官方支持范围。CPA 原生渠道模型在内核渠道中管理。</div>
  </section>
</template>

<style scoped>
.model-sync-panel { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; margin-bottom: 22px; }
.model-sync-panel strong { display: block; margin-bottom: 8px; font-size: 13px; }
.model-sync-panel p { margin-top: 8px; color: var(--muted); font-size: 11px; line-height: 1.8; overflow-wrap: anywhere; }
@media (max-width: 720px) { .model-sync-panel { grid-template-columns: 1fr; } }
</style>
