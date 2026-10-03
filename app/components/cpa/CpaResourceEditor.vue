<script setup lang="ts">
const props = withDefaults(defineProps<{ path: string; title: string; description?: string; writable?: boolean; format?: 'json' | 'text'; replaceOnly?: boolean; allowCreate?: boolean }>(), { writable: false, format: 'json', replaceOnly: false, allowCreate: false })
const api = useRequestFetch()
const endpoint = computed(() => cpaManagementUrl(props.path))
const { data, pending, error, refresh } = await useFetch<unknown>(endpoint, { responseType: props.format === 'text' ? 'text' : 'json', key: `cpa-resource-${props.path}` })
const baseline = ref('')
const draft = ref('')
const mode = ref<'PATCH' | 'PUT'>(props.replaceOnly ? 'PUT' : 'PATCH')
const validation = ref('')
const { busy, run } = useApiAction()
const dirty = computed(() => draft.value !== baseline.value)
const missingNode = computed(() => props.writable && props.allowCreate && (error.value?.statusCode === 404 || error.value?.status === 404))
watch([data, error], ([value, fetchError]) => {
  if (fetchError || value === undefined) return
  const next = props.format === 'text' ? String(value) : JSON.stringify(value, null, 2)
  if (!dirty.value) draft.value = next
  baseline.value = next
}, { immediate: true })
watch(missingNode, (missing) => { if (missing && !draft.value) draft.value = '{}'; if (missing) mode.value = 'PUT' }, { immediate: true })
async function save() {
  validation.value = ''
  let body: unknown = draft.value
  if (props.format === 'json') {
    try { body = JSON.parse(draft.value) }
    catch { validation.value = 'JSON 格式不正确，请检查括号、引号和逗号。'; return }
  } else if (!draft.value.trim()) { validation.value = '配置内容不能为空。'; return }
  const result = await run(() => api(endpoint.value, { method: mode.value, body: props.format === 'json' ? JSON.stringify(body) : draft.value, headers: { 'content-type': props.format === 'text' ? 'application/yaml' : 'application/json' } }), 'CPA 配置已保存')
  if (result.ok) { baseline.value = draft.value; await refresh() }
}
</script>
<template>
  <section class="panel nexus-resource">
    <div class="panel-heading"><h2>{{ title }}</h2><button class="button small" :disabled="pending || busy" @click="refresh()"><UIcon name="i-ph-arrow-clockwise-bold" />重新读取</button></div>
    <p v-if="description" class="nexus-description">{{ description }}</p>
    <AppState v-if="error && !missingNode" :error="error" compact @retry="refresh()" />
    <div v-else-if="pending && !baseline" class="nexus-skeleton" role="status" aria-label="正在读取配置"><span /><span /><span /></div>
    <template v-else-if="baseline || missingNode">
      <p v-if="missingNode" class="nexus-description">此配置节点尚未创建。填写后保存即可添加，内核会校验内容。</p>
      <template v-if="writable"><label class="field"><span class="sr-only">{{ title }}内容</span><textarea v-model="draft" class="nexus-code-editor" spellcheck="false" rows="16" :disabled="busy" /></label><p v-if="validation" class="inline-error" role="alert">{{ validation }}</p><div class="nexus-editor-footer"><span class="muted small-text">{{ dirty ? '有未保存的修改' : '已读取内核当前配置' }}</span><div class="inline-actions"><label v-if="!replaceOnly && format === 'json'" class="nexus-inline-label">保存方式<select v-model="mode" :disabled="busy"><option value="PATCH">合并对象</option><option value="PUT">替换当前节点</option></select></label><button class="button" :disabled="busy || !dirty" @click="draft = baseline; validation = ''">还原修改</button><button class="button primary" :disabled="busy || !dirty" @click="save"><UIcon v-if="busy" name="i-ph-circle-notch-bold" class="spinning" />保存至 CPA</button></div></div></template>
      <JsonViewer v-else :value="data" :title="title" />
    </template>
    <AppState v-else compact title="此节点暂无数据" description="内核未返回可展示的内容。" />
  </section>
</template>
