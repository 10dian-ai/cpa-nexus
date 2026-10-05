<script setup lang="ts">
const api = useRequestFetch()
const endpoint = cpaManagementUrl('config/observability/logs/request-log')
const { data, pending, error, refresh } = await useFetch<boolean>(endpoint, { key: 'cpa-request-log-enabled' })
const enabled = ref(false)
const baseline = ref(false)
const loaded = ref(false)
const { busy, run } = useApiAction()
const dirty = computed(() => loaded.value && enabled.value !== baseline.value)
const missing = computed(() => error.value?.statusCode === 404 || error.value?.status === 404)

watch([data, error], ([value, fetchError]) => {
  if (fetchError && !((fetchError as { statusCode?: number; status?: number }).statusCode === 404 || (fetchError as { status?: number }).status === 404)) return
  if (dirty.value) return
  enabled.value = value === true
  baseline.value = enabled.value
  loaded.value = true
}, { immediate: true })

async function save() {
  const result = await run(() => api(endpoint, { method: 'PUT', body: JSON.stringify(enabled.value), headers: { 'content-type': 'application/json' } }), '请求日志配置已保存')
  if (result.ok) { baseline.value = enabled.value; loaded.value = true; await refresh() }
}
</script>

<template>
  <section class="panel cpa-observability-settings">
    <div class="panel-heading"><h2>请求日志</h2><button class="button small" :disabled="busy || pending" @click="refresh()"><UIcon name="i-ph-arrow-clockwise-bold" />重新读取</button></div>
    <AppState v-if="error && !missing" :error="error" compact @retry="refresh()" />
    <template v-else>
      <p class="nexus-description">控制 CPA 是否保留按请求 ID 查询的请求日志。关闭后，应用日志仍可按内核观测配置保存；改动由 CPA 热加载。</p>
      <label class="nexus-inline-label"><input v-model="enabled" type="checkbox" :disabled="busy || pending || !loaded">启用请求日志</label>
      <div class="nexus-editor-footer"><span class="muted small-text">{{ missing ? '内核尚未创建该配置，保存后会创建。' : dirty ? '有未保存的修改' : '已读取当前配置' }}</span><div class="inline-actions"><button class="button" :disabled="busy || !dirty" @click="enabled = baseline">还原修改</button><button class="button primary" :disabled="busy || !dirty" @click="save">保存请求日志设置</button></div></div>
    </template>
  </section>
</template>
