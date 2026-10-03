<script setup lang="ts">
const api = useRequestFetch()
const { data, pending, error, refresh } = await useFetch<unknown>(cpaManagementUrl('credentials'))
const rows = computed(() => cpaEntries(data.value, 'files'))
const search = ref('')
const visible = computed(() => rows.value.filter(row => [row.name, row.provider, row.email].some(value => cpaDisplay(value, '').toLowerCase().includes(search.value.toLowerCase()))))
const { busy, run } = useApiAction()
const selected = ref<Record<string, unknown> | null>(null)
const details = ref<unknown>(null)
const fields = ref('{}')
const fieldError = ref('')
const deleteTarget = ref<Record<string, unknown> | null>(null)
const deleteOpen = computed({ get: () => !!deleteTarget.value, set: (value) => { if (!value) deleteTarget.value = null } })
const selectedName = computed(() => cpaDisplay(selected.value?.name || selected.value?.id, ''))
watch(rows, (value) => {
  if (!selected.value) return
  const name = selectedName.value
  selected.value = value.find(row => cpaDisplay(row.name || row.id, '') === name) || null
})
async function upload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  const body = new FormData(); body.set('file', file)
  const result = await run(() => api(cpaManagementUrl('credentials'), { method: 'POST', body }), '凭证已导入')
  if (result.ok) await refresh()
  input.value = ''
}
async function toggle(row: Record<string, unknown>) {
  const result = await run(() => api(cpaManagementUrl('credentials/status'), { method: 'PATCH', body: { name: row.name || row.id, disabled: !row.disabled } }), '凭证状态已更新')
  if (result.ok) await refresh()
}
async function refreshCredential(row: Record<string, unknown>) {
  const result = await run(() => api(cpaManagementUrl('credentials/refresh'), { method: 'POST', body: { name: row.name || row.id, ...(row.auth_index ? { auth_index: row.auth_index } : {}) } }), '凭证刷新已提交')
  if (result.ok) { details.value = result.value; await refresh() }
}
async function inspect(row: Record<string, unknown>) {
  selected.value = row; fields.value = '{}'; fieldError.value = ''; details.value = null
  const result = await run(() => api(cpaManagementUrl('credentials/models'), { query: { name: row.name || row.id } }))
  if (result.ok) details.value = result.value
}
async function saveFields() {
  let body: unknown
  try { body = JSON.parse(fields.value) } catch { fieldError.value = '请输入有效的 JSON 对象。'; return }
  if (!body || typeof body !== 'object' || Array.isArray(body)) { fieldError.value = '凭证字段必须是 JSON 对象。'; return }
  const result = await run(() => api(cpaManagementUrl('credentials/fields'), { method: 'PATCH', body: { ...body, name: selectedName.value } }), '凭证字段已保存')
  if (result.ok) { fieldError.value = ''; await refresh() }
}
async function resetCooldown() {
  const authIndex = selected.value?.auth_index
  if (!authIndex) return
  const result = await run(() => api(cpaManagementUrl('routing/cooldown/reset'), { method: 'POST', body: { auth_index: authIndex } }), '凭证冷却状态已重置')
  if (result.ok) { details.value = result.value; await refresh() }
}
async function remove() {
  if (!deleteTarget.value) return
  const result = await run(() => api(cpaManagementUrl('credentials'), { method: 'DELETE', query: { name: deleteTarget.value!.name } }), '凭证已删除')
  if (result.ok) { deleteTarget.value = null; await refresh() }
}
</script>
<template>
  <section class="table-panel"><div class="table-toolbar"><label class="search-field"><UIcon name="i-ph-magnifying-glass-bold" /><input v-model="search" aria-label="搜索凭证" placeholder="搜索名称、渠道、邮箱"></label><label class="button" :class="{ 'muted': busy }"><UIcon name="i-ph-upload-simple-bold" />导入 JSON<input class="sr-only" type="file" accept=".json,application/json" :disabled="busy" @change="upload"></label><button class="button" :disabled="pending || busy" @click="refresh()">重新读取</button><span class="toolbar-meta">{{ rows.length }} 个凭证</span></div>
    <AppState v-if="error" :error="error" @retry="refresh()" /><AppState v-else-if="pending && !data" loading /><AppState v-else-if="!visible.length" title="暂无匹配凭证" description="导入凭证文件，或通过 OAuth 授权接入账号。" />
    <div v-else class="table-scroll"><table class="data-table"><thead><tr><th>凭证</th><th>渠道</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="(row, i) in visible" :key="cpaDisplay(row.id || row.name, String(i))"><td><strong class="nexus-table-name">{{ cpaDisplay(row.name || row.id) }}</strong><div class="cell-secondary">{{ row.runtime_only ? '仅运行时凭证' : cpaDisplay(row.source, '文件凭证') }}</div></td><td>{{ cpaDisplay(row.provider) }}</td><td><span class="status-badge" :class="row.disabled ? 'neutral' : row.unavailable ? 'amber' : 'green'">{{ row.disabled ? '已停用' : cpaDisplay(row.status, '状态未返回') }}</span><p v-if="row.status_message" class="cell-error">{{ cpaDisplay(row.status_message) }}</p></td><td><div class="nexus-table-actions"><button class="button small" :disabled="busy" @click="toggle(row)">{{ row.disabled ? '启用' : '停用' }}</button><button class="button small" :disabled="busy || !!row.runtime_only" @click="refreshCredential(row)">刷新</button><button class="button small" :disabled="busy" @click="inspect(row)">详情</button><button class="button small" :disabled="busy || !!row.runtime_only" @click="run(() => cpaDownload(`credentials/download?name=${encodeURIComponent(cpaDisplay(row.name, ''))}`, cpaDisplay(row.name, 'credential.json')))">下载</button><button class="button small danger" :disabled="busy || !!row.runtime_only" @click="deleteTarget = row">删除</button></div></td></tr></tbody></table></div>
  </section>
  <section v-if="selected" class="panel nexus-compact-panel"><div class="panel-heading"><h2 class="nexus-table-name">{{ selectedName }}</h2><div class="inline-actions"><button v-if="selected.auth_index" class="button small" :disabled="busy" @click="resetCooldown">重置冷却</button><button class="button small" @click="selected = null">收起</button></div></div><JsonViewer :value="selected" title="内核凭证记录" /><JsonViewer v-if="details" class="section-gap" :value="details" title="凭证模型 / 操作结果" /><h3 class="nexus-subheading">修改凭证字段</h3><p class="nexus-description">提交需要变更的字段，例如权重、前缀或 headers。内核负责校验字段与凭证类型。</p><textarea v-model="fields" class="nexus-code-editor" rows="6" aria-label="凭证字段 JSON" spellcheck="false" /><p v-if="fieldError" class="inline-error" role="alert">{{ fieldError }}</p><div class="form-actions"><button class="button primary" :disabled="busy || fields.trim() === '{}'" @click="saveFields">保存字段</button></div></section>
  <AppDialog v-model="deleteOpen" title="删除凭证" :description="`删除 ${cpaDisplay(deleteTarget?.name)} 的文件，并停用对应运行时凭证。`" :close-disabled="busy"><p class="nexus-description">删除后需要重新导入或授权才能使用该凭证。</p><template #footer><button class="button" :disabled="busy" @click="deleteTarget = null">取消</button><button class="button danger-solid" :disabled="busy" @click="remove">删除凭证</button></template></AppDialog>
</template>
