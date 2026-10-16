<script setup lang="ts">
import type { LogiccOverview } from '#shared/logicc'
useHead({ title: 'Logicc 号池 · CPA Nexus' })
const api = useRequestFetch()
const { data, pending, error, refresh } = await useFetch<LogiccOverview>('/api/logicc/overview')
useLiveRefresh(refresh)
const importOpen = ref(false)
const { busy, run } = useApiAction()
async function syncBridge() {
  const result = await run(() => api('/api/modules/logicc/channel', { method: 'POST' }), 'CPA 桥接渠道已同步')
  if (result.ok) await refresh()
}
</script>
<template>
  <AppPageHeader title="Logicc 号池" description="Logicc 网页账号统一管理：Clerk 会话自动续期，经 CPA 内核的桥接渠道对外提供模型，用量由本模块按实际发送的内容计算。">
    <button class="button" :disabled="pending" @click="refresh()"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: pending }" />刷新</button>
    <button class="button primary" @click="importOpen = true"><UIcon name="i-ph-plus-bold" />导入账号</button>
  </AppPageHeader>
  <AppState v-if="error" :error="error" @retry="refresh()" />
  <AppState v-else-if="!data" :loading="pending" />
  <template v-else>
    <div class="metric-grid">
      <div class="metric-card"><div class="metric-top">可用账号<UIcon name="i-ph-lightning-bold" /></div><strong>{{ data.accounts.ready }}</strong><p>已启用 {{ data.accounts.enabled }} / 共 {{ data.accounts.total }}</p></div>
      <div class="metric-card" :class="{ 'metric-warning': data.accounts.needsAttention }"><div class="metric-top">需要处理<UIcon name="i-ph-warning-bold" /></div><strong>{{ data.accounts.needsAttention }}</strong><p>凭据失效或同步失败 · 待检测 {{ data.accounts.pending }}</p></div>
      <div class="metric-card"><div class="metric-top">进行中请求<UIcon name="i-ph-pulse-bold" /></div><strong>{{ data.inFlight }}</strong><p>按账号并发上限调度</p></div>
      <div class="metric-card"><div class="metric-top">24 小时请求<UIcon name="i-ph-chart-line-up-bold" /></div><strong>{{ data.requests.total }}</strong><p>成功 {{ data.requests.success }} · 失败 {{ data.requests.failed }} · 本地计费 {{ data.requests.estimatedUsage }}</p></div>
    </div>
    <div class="dashboard-grid">
      <section class="panel">
        <div class="panel-heading"><h2><UIcon name="i-ph-plugs-connected-bold" />CPA 桥接渠道</h2><StatusBadge :status="data.bridge.connected ? 'ready' : 'pending'" :label="data.bridge.connected ? '已接入' : '未发布'" /></div>
        <dl class="summary-rows">
          <div><dt>渠道名</dt><dd class="mono small-value">{{ data.bridge.channel }}</dd></div>
          <div><dt>发布的模型</dt><dd>{{ data.bridge.modelCount }}</dd></div>
          <div><dt>最近同步</dt><dd class="small-value">{{ formatDate(data.bridge.updatedAt) }}</dd></div>
        </dl>
        <p v-if="data.bridge.error" class="inline-error section-gap">{{ data.bridge.error }}</p>
        <p class="panel-note">渠道由 CPA 内核注册与维护，Logicc 模块只声明自己能提供的模型。客户端用原模型名（或 <code>logicc/模型名</code>）通过 /v1 调用，CPA 负责 Messages、Responses、Gemini 等协议转换。</p>
        <div class="form-actions"><button class="button" :disabled="busy" @click="syncBridge">立即同步渠道</button></div>
      </section>
      <section class="panel">
        <div class="panel-heading"><h2><UIcon name="i-ph-cube-bold" />可用模型</h2><span class="muted">{{ data.models.length }} 个</span></div>
        <p v-if="!data.models.length" class="empty-note muted">还没有可用账号读取到模型目录。导入账号并检测后显示。</p>
        <div v-else class="table-scroll"><table class="data-table"><thead><tr><th>模型 ID</th><th>名称</th><th class="align-right">可用账号</th></tr></thead><tbody><tr v-for="model in data.models" :key="model.id"><td class="mono">{{ model.id }}</td><td>{{ model.name }}</td><td class="align-right">{{ model.accounts }}</td></tr></tbody></table></div>
      </section>
    </div>
    <section class="panel section-gap"><div class="panel-heading"><h2>使用说明</h2></div><ol class="nexus-start-list">
      <li><NuxtLink to="/logicc/accounts">导入账号</NuxtLink><span>粘贴 __client Cookie + Session ID、Session JWT，或 logicc2api 导出的 JSON；也可以用外调 Key 在 3041 端口的公网加号页添加。</span></li>
      <li><NuxtLink to="/groups/accounts?module=logicc">调整分组</NuxtLink><span>新账号默认进入「Logicc」分组；新建的模型 Key 默认带上这个分组。</span></li>
      <li><NuxtLink to="/logicc/settings">确认计费</NuxtLink><span>Logicc 不回传 usage，本模块按发给 Logicc 的完整提示（含酒馆预设）与生成内容计算，宁多勿少。</span></li>
    </ol></section>
  </template>
  <ModuleIntakeDialog v-model="importOpen" module-id="logicc" @imported="refresh()" />
</template>
