<script setup lang="ts">
interface LogPage { lines: string[]; 'line-count': number; 'next-cursor'?: string; 'cursor-reset'?: boolean }
const api = useRequestFetch()
const tab = ref('application')
const { data, pending, error, refresh } = await useFetch<LogPage>(cpaManagementUrl('observability/logs'), { query: { limit: 200 } })
const { busy, run } = useApiAction()
const clearOpen = ref(false)
const files = ref<Record<string, unknown>[]>([])
const filesLoaded = ref(false)
const requestId = ref('')
async function clearLogs() {
  const result = await run(() => api(cpaManagementUrl('observability/logs'), { method: 'DELETE' }), 'CPA 应用日志已清理')
  if (result.ok) { clearOpen.value = false; await refresh() }
}
async function readErrors() {
  const result = await run(() => api(cpaManagementUrl('observability/logs/errors')))
  if (result.ok) { files.value = cpaEntries(result.value, 'files'); filesLoaded.value = true }
}
</script>
<template>
  <section class="panel"><div class="panel-heading"><h2>CPA 日志</h2><div class="inline-actions"><button v-if="tab === 'application'" class="button small" :disabled="busy || pending" @click="refresh()">读取最新日志</button><button v-if="tab === 'application'" class="button small danger" :disabled="busy" @click="clearOpen = true">清理应用日志</button></div></div><div class="nexus-tabs" role="tablist" aria-label="日志类型"><button role="tab" :aria-selected="tab === 'application'" @click="tab = 'application'">应用日志</button><button role="tab" :aria-selected="tab === 'errors'" @click="tab = 'errors'">错误日志文件</button><button role="tab" :aria-selected="tab === 'request'" @click="tab = 'request'">请求日志下载</button></div>
    <template v-if="tab === 'application'"><AppState v-if="error" :error="error" compact @retry="refresh()" /><AppState v-else-if="pending && !data" loading compact /><pre v-else-if="data?.lines?.length" class="nexus-raw-log" tabindex="0">{{ data.lines.join('\n') }}</pre><AppState v-else compact title="暂无应用日志" description="内核文件日志已启用时，这里显示最新日志行。" /><p class="panel-note">显示最近最多 200 行，手动重新读取更新。若内核未启用文件日志，可在观测配置中设置。</p></template>
    <template v-else-if="tab === 'errors'"><button class="button" :disabled="busy" @click="readErrors">读取错误日志文件</button><div v-if="files.length" class="table-scroll section-gap"><table class="data-table"><thead><tr><th>文件</th><th>大小</th><th>操作</th></tr></thead><tbody><tr v-for="file in files" :key="cpaDisplay(file.name)"><td class="mono wrap-cell">{{ cpaDisplay(file.name) }}</td><td>{{ cpaDisplay(file.size) }} B</td><td><button class="button small" :disabled="busy" @click="run(() => cpaDownload(`observability/logs/errors/${encodeURIComponent(cpaDisplay(file.name, ''))}`, cpaDisplay(file.name, 'error.log')))">下载</button></td></tr></tbody></table></div><p v-else class="nexus-empty-note">{{ filesLoaded ? '内核没有返回错误日志文件。' : '点击读取以查看内核保存的错误日志。' }}</p></template>
    <form v-else class="nexus-form-line" @submit.prevent="run(() => cpaDownload(`observability/logs/requests/${encodeURIComponent(requestId.trim())}`, `request-${requestId.trim()}.log`))"><label class="field"><span>请求 ID</span><input v-model="requestId" required placeholder="输入 CPA 请求日志 ID"><small>需要内核已启用请求日志，并且仍保存该请求的日志文件。</small></label><button class="button" :disabled="busy || !requestId.trim()">下载请求日志</button></form>
  </section>
  <AppDialog v-model="clearOpen" title="清理 CPA 应用日志" description="删除轮转日志并清空当前应用日志文件。" :close-disabled="busy"><p class="nexus-description">该操作会移除现有应用日志记录。</p><template #footer><button class="button" :disabled="busy" @click="clearOpen = false">取消</button><button class="button danger-solid" :disabled="busy" @click="clearLogs">清理日志</button></template></AppDialog>
</template>
