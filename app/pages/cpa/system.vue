<script setup lang="ts">
useHead({ title: '系统信息 · CPA Nexus' })
const { data: status, pending, error, refresh } = await useCpaStatus()
const api = useRequestFetch()
const { busy, run } = useApiAction()
const latest = ref<unknown>(null)
const models = ref<unknown>(null)
const modelsError = ref<unknown>(null)

const modelRows = computed(() => {
  const value = models.value
  if (Array.isArray(value)) return value.filter(item => item && typeof item === 'object') as Record<string, unknown>[]
  if (value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).data)) return (value as Record<string, unknown>).data as Record<string, unknown>[]
  return []
})
const latestLabel = computed(() => {
  const value = latest.value
  if (value && typeof value === 'object' && !Array.isArray(value)) return cpaDisplay((value as Record<string, unknown>)['latest-version'] || value)
  return cpaDisplay(value)
})

async function checkVersion() {
  const result = await run(() => api<{ 'latest-version'?: string }>(cpaManagementUrl('server/latest-version')))
  if (result.ok) latest.value = result.value
}

async function readModels() {
  modelsError.value = null
  const result = await run(() => api('/api/cpa/console/v1/models'))
  if (result.ok) models.value = result.value
  else modelsError.value = result
}
</script>

<template>
  <AppPageHeader title="系统信息" description="查看 CPA 内核、模型目录和管理适配状态，并执行版本检查。">
    <button class="button" :disabled="pending" @click="refresh()"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: pending }" />重新检测</button>
    <NuxtLink to="/cpa/native" class="button">原版完整控制台</NuxtLink>
  </AppPageHeader>
  <AppState v-if="error" :error="error" @retry="refresh()" />
  <AppState v-else-if="pending && !status" loading />
  <CpaGate v-else>
    <section class="nexus-stat-strip">
      <span class="status-badge" :class="status?.connected ? 'green' : 'amber'"><span class="status-dot" />{{ status?.connected ? '内核已连接' : '连接异常' }}</span>
      <div><strong class="mono">{{ status?.version || '版本未返回' }}</strong><p>CPA v8 管理接口</p></div>
      <div class="inline-actions"><button class="button" :disabled="busy" @click="checkVersion">检查上游版本</button><button class="button" :disabled="busy" @click="readModels">读取模型目录</button></div>
    </section>
    <div v-if="latest" class="notice"><UIcon name="i-ph-package-bold" /><p>上游版本检查结果：<strong class="mono">{{ latestLabel }}</strong></p></div>
    <div v-if="modelsError" class="notice error-notice" role="alert"><UIcon name="i-ph-warning-circle-bold" /><p>{{ apiErrorMessage(modelsError) }}</p></div>
    <section class="nexus-two-column">
      <section class="panel"><div class="panel-heading"><h2>运行状态</h2></div><dl class="nexus-definition-list"><div><dt>CPA 版本</dt><dd class="mono">{{ status?.version || '未返回' }}</dd></div><div><dt>管理接口</dt><dd>{{ status?.apiVersion || 'v8' }}</dd></div><div><dt>最近检测</dt><dd>{{ formatDate(status?.checkedAt) }}</dd></div><div><dt>已确认能力</dt><dd>{{ status?.capabilities?.join('、') || '尚未确认' }}</dd></div></dl></section>
      <section class="panel"><div class="panel-heading"><h2>项目链接</h2></div><div class="nexus-stack"><a class="text-link" href="https://github.com/10dian-ai/cpa-nexus" target="_blank" rel="noopener noreferrer">CPA Nexus 源码<UIcon name="i-ph-arrow-up-right-bold" /></a><a class="text-link" href="https://github.com/router-for-me/CLIProxyAPI" target="_blank" rel="noopener noreferrer">CLIProxyAPI 内核<UIcon name="i-ph-arrow-up-right-bold" /></a><a class="text-link" href="https://github.com/router-for-me/Cli-Proxy-API-Management-Center" target="_blank" rel="noopener noreferrer">官方管理中心<UIcon name="i-ph-arrow-up-right-bold" /></a><a class="text-link" href="https://help.router-for.me/" target="_blank" rel="noopener noreferrer">内核文档<UIcon name="i-ph-arrow-up-right-bold" /></a></div></section>
    </section>
    <section class="panel"><div class="panel-heading"><h2>可用模型目录</h2><span class="muted">{{ modelRows.length }} 个模型</span></div><p class="nexus-description">目录通过 CPA 原生 `/v1/models` 读取，使用服务端保存的客户端密钥，浏览器不会接触该密钥。</p><div v-if="modelRows.length" class="table-scroll"><table class="data-table"><thead><tr><th>模型 ID</th><th>对象</th><th>其他字段</th></tr></thead><tbody><tr v-for="(model, index) in modelRows" :key="String(model.id || index)"><td class="mono wrap-cell">{{ cpaDisplay(model.id) }}</td><td>{{ cpaDisplay(model.object) }}</td><td class="wrap-cell">{{ cpaDisplay(Object.fromEntries(Object.entries(model).filter(([key]) => !['id', 'object'].includes(key)))) }}</td></tr></tbody></table></div><p v-else class="nexus-empty-note">点击“读取模型目录”查看当前 CPA 暴露的模型。</p></section>
    <JsonViewer v-if="models !== null" :value="models" title="原始模型目录响应" />
  </CpaGate>
</template>
