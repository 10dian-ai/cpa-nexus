<script setup lang="ts">
interface LogPage { lines: string[]; 'line-count': number; 'next-cursor'?: string | null; 'cursor-reset'?: boolean }
const api = useRequestFetch()
const tab = ref('application')
const { data, pending, error, refresh } = await useFetch<LogPage>(cpaManagementUrl('observability/logs'), { query: { limit: 200 } })
const { busy, run } = useApiAction()
const lines = ref<string[]>([])
const nextCursor = ref<string | null>(null)
watch(data, value => {
  if (!value) return
  lines.value = Array.isArray(value.lines) ? [...value.lines] : []
  nextCursor.value = typeof value['next-cursor'] === 'string' && value['next-cursor'] ? value['next-cursor'] : null
}, { immediate: true })
const clearOpen = ref(false)
const files = ref<Record<string, unknown>[]>([])
const filesLoaded = ref(false)
const requestId = ref('')
const requestPreview = ref<string | null>(null)
const search = ref('')
const level = ref('all')
const follow = ref(false)
let followTimer: ReturnType<typeof setInterval> | undefined
const filteredLines = computed(() => lines.value.filter(line => {
  const text = line.toLowerCase()
  const query = search.value.trim().toLowerCase()
  const levelMatch = level.value === 'all' || text.includes(level.value)
  return levelMatch && (!query || text.includes(query))
}))
async function clearLogs() {
  const result = await run(() => api(cpaManagementUrl('observability/logs'), { method: 'DELETE' }), 'CPA 应用日志已清理')
  if (result.ok) { clearOpen.value = false; await refresh() }
}
async function readErrors() {
  const result = await run(() => api(cpaManagementUrl('observability/logs/errors')))
  if (result.ok) { files.value = cpaEntries(result.value, 'files'); filesLoaded.value = true }
}
async function readRequestLog() {
  if (!requestId.value.trim()) return
  const result = await run(() => api(cpaManagementUrl(`observability/logs/requests/${encodeURIComponent(requestId.value.trim())}`), { responseType: 'text' }))
  if (result.ok) requestPreview.value = String(result.value)
}
async function loadOlder() {
  if (!nextCursor.value) return
  const result = await run(() => api<LogPage>(cpaManagementUrl('observability/logs'), { query: { limit: 200, cursor: nextCursor.value! } }))
  if (!result.ok) return
  const page = result.value
  lines.value = [...lines.value, ...(Array.isArray(page.lines) ? page.lines : [])]
  nextCursor.value = typeof page['next-cursor'] === 'string' && page['next-cursor'] ? page['next-cursor'] : null
}
function stopFollowing() { if (followTimer) clearInterval(followTimer); followTimer = undefined }
function startFollowing() { stopFollowing(); if (follow.value && tab.value === 'application') followTimer = setInterval(() => refresh(), 10_000) }
watch([follow, tab], startFollowing)
onMounted(startFollowing)
onBeforeUnmount(stopFollowing)
</script>
<template>
  <section class="panel"><div class="panel-heading"><h2>CPA 日志</h2><div class="inline-actions"><button v-if="tab === 'application'" class="button small" :disabled="busy || pending" @click="refresh()">读取最新日志</button><label v-if="tab === 'application'" class="nexus-inline-label"><input v-model="follow" type="checkbox">实时跟随（10 秒）</label><button v-if="tab === 'application'" class="button small danger" :disabled="busy" @click="clearOpen = true">清理应用日志</button></div></div><div class="nexus-tabs" role="tablist" aria-label="日志类型"><button role="tab" :aria-selected="tab === 'application'" @click="tab = 'application'">应用日志</button><button role="tab" :aria-selected="tab === 'errors'" @click="tab = 'errors'">错误日志文件</button><button role="tab" :aria-selected="tab === 'request'" @click="tab = 'request'">请求日志下载</button></div>
    <template v-if="tab === 'application'"><div class="table-toolbar"><label class="search-field"><UIcon name="i-ph-magnifying-glass-bold" /><input v-model="search" aria-label="搜索日志" placeholder="搜索日志内容"></label><label class="nexus-inline-label">级别<select v-model="level"><option value="all">全部</option><option value="error">error</option><option value="warn">warn</option><option value="info">info</option><option value="debug">debug</option></select></label><span class="toolbar-meta">{{ filteredLines.length }} / {{ lines.length }} 行</span><button v-if="nextCursor" class="button small" :disabled="busy" @click="loadOlder">加载更早日志</button></div><AppState v-if="error" :error="error" compact @retry="refresh()" /><AppState v-else-if="pending && !data" loading compact /><pre v-else-if="filteredLines.length" class="nexus-raw-log" tabindex="0">{{ filteredLines.join('\n') }}</pre><AppState v-else compact title="暂无匹配日志" description="调整搜索或级别筛选，或检查内核是否启用文件日志。" /><p class="panel-note">显示最近最多 200 行；可按“加载更早日志”继续读取历史。开启实时跟随后每 10 秒读取一次。若内核未启用文件日志，可在观测配置中设置。</p></template>
    <template v-else-if="tab === 'errors'"><button class="button" :disabled="busy" @click="readErrors">读取错误日志文件</button><div v-if="files.length" class="table-scroll section-gap"><table class="data-table"><thead><tr><th>文件</th><th>大小</th><th>操作</th></tr></thead><tbody><tr v-for="file in files" :key="cpaDisplay(file.name)"><td class="mono wrap-cell">{{ cpaDisplay(file.name) }}</td><td>{{ cpaDisplay(file.size) }} B</td><td><button class="button small" :disabled="busy" @click="run(() => cpaDownload(`observability/logs/errors/${encodeURIComponent(cpaDisplay(file.name, ''))}`, cpaDisplay(file.name, 'error.log')))">下载</button></td></tr></tbody></table></div><p v-else class="nexus-empty-note">{{ filesLoaded ? '内核没有返回错误日志文件。' : '点击读取以查看内核保存的错误日志。' }}</p></template>
    <template v-else><form class="nexus-form-line" @submit.prevent="readRequestLog"><label class="field"><span>请求 ID</span><input v-model="requestId" required placeholder="输入 CPA 请求日志 ID"><small>需要内核已启用请求日志，并且仍保存该请求的日志文件。</small></label><div class="inline-actions"><button class="button" :disabled="busy || !requestId.trim()">查看请求日志</button><button type="button" class="button" :disabled="busy || !requestId.trim()" @click="run(() => cpaDownload(`observability/logs/requests/${encodeURIComponent(requestId.trim())}`, `request-${requestId.trim()}.log`))">下载请求日志</button></div></form><pre v-if="requestPreview !== null" class="nexus-raw-log section-gap" tabindex="0">{{ requestPreview }}</pre></template>
  </section>
  <AppDialog v-model="clearOpen" title="清理 CPA 应用日志" description="删除轮转日志并清空当前应用日志文件。" :close-disabled="busy"><p class="nexus-description">该操作会移除现有应用日志记录。</p><template #footer><button class="button" :disabled="busy" @click="clearOpen = false">取消</button><button class="button danger-solid" :disabled="busy" @click="clearLogs">清理日志</button></template></AppDialog>
</template>
