<script setup lang="ts">
const props = withDefaults(defineProps<{ initialProvider?: string }>(), { initialProvider: '' })
const api = useRequestFetch()
const { data, pending, error, refresh } = await useFetch<unknown>(cpaManagementUrl('credentials'), { key: 'cpa-credentials' })
const rows = computed(() => cpaEntries(data.value, 'files'))
const search = ref(''), providerFilter = ref(''), statusFilter = ref('all'), page = ref(1), pageSize = 25
const loadedAt = ref<string | null>(null), selectedNames = ref<string[]>([])
const providerNames = computed(() => [...new Set(rows.value.map(row => cpaDisplay(row.provider, '')).filter(Boolean))].sort())
watch(() => props.initialProvider, value => { providerFilter.value = value; page.value = 1 }, { immediate: true })
const visible = computed(() => rows.value.filter(row => (!providerFilter.value || cpaDisplay(row.provider, '') === providerFilter.value) &&
  (statusFilter.value === 'all' || statusFilter.value === 'disabled' && !!row.disabled || statusFilter.value === 'enabled' && !row.disabled || statusFilter.value === 'unavailable' && !!row.unavailable) &&
  [row.name, row.id, row.provider, row.email].some(value => cpaDisplay(value, '').toLowerCase().includes(search.value.toLowerCase()))))
const displayed = computed(() => visible.value.slice((page.value - 1) * pageSize, page.value * pageSize))
const allPageSelected = computed(() => displayed.value.length > 0 && displayed.value.every(row => selectedNames.value.includes(cpaCredentialName(row))))
const selection = computed(() => rows.value.filter(row => selectedNames.value.includes(cpaCredentialName(row))))
const refreshableSelection = computed(() => selection.value.filter(row => !row.runtime_only))
watch([search, providerFilter, statusFilter], () => { page.value = 1 })
watch(rows, value => { if (data.value != null) loadedAt.value = new Date().toISOString(); selectedNames.value = selectedNames.value.filter(name => value.some(row => cpaCredentialName(row) === name)); page.value = Math.min(page.value, Math.max(1, Math.ceil(visible.value.length / pageSize))) }, { immediate: true })
const { busy, run } = useApiAction()
const selected = ref<Record<string, unknown> | null>(null), details = ref<unknown>(null), fields = ref('{}'), fieldError = ref('')
const deleteTargets = ref<Record<string, unknown>[]>([])
const deleteOpen = computed({ get: () => deleteTargets.value.length > 0, set: value => { if (!value) deleteTargets.value = [] } })
const selectedName = computed(() => selected.value ? cpaCredentialName(selected.value) : '')
const operation = ref<{ action: string; results: { name: string; ok: boolean; message?: string }[] } | null>(null)
const progress = ref<{ total: number; completed: number } | null>(null)
watch(rows, value => { if (selected.value) selected.value = value.find(row => cpaCredentialName(row) === selectedName.value) || null })
function togglePage() {
  const names = displayed.value.map(cpaCredentialName)
  selectedNames.value = allPageSelected.value ? selectedNames.value.filter(name => !names.includes(name)) : [...new Set([...selectedNames.value, ...names])]
}
function toggleSelected(row: Record<string, unknown>) { const name = cpaCredentialName(row); selectedNames.value = selectedNames.value.includes(name) ? selectedNames.value.filter(item => item !== name) : [...selectedNames.value, name] }
async function perform(action: string, targets: { name: string; run: () => Promise<unknown> }[]) {
  if (!targets.length) return
  progress.value = { total: targets.length, completed: 0 }
  const result = await run(async () => {
    const results: { name: string; ok: boolean; message?: string }[] = []
    for (let offset = 0; offset < targets.length; offset += 2) results.push(...await Promise.all(targets.slice(offset, offset + 2).map(async target => {
      try { await target.run(); return { name: target.name, ok: true } }
      catch (error) { if (isPlatformAuthenticationError(error)) throw error; return { name: target.name, ok: false, message: apiErrorMessage(error) } }
      finally { if (progress.value) progress.value.completed++ }
    })))
    return { action, results }
  })
  progress.value = null
  if (result.ok) { operation.value = result.value; await refresh() }
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files || [])]
  await perform('导入凭证', files.map(file => ({ name: file.name, run: async () => { const body = new FormData(); body.set('file', file); return api(cpaManagementUrl('credentials'), { method: 'POST', body }) } })))
  input.value = ''
}
async function batch(action: 'enable' | 'disable' | 'refresh' | 'download') {
  const targets = action === 'enable' || action === 'disable' ? selection.value : refreshableSelection.value
  const labels = { enable: '启用凭证', disable: '停用凭证', refresh: '刷新凭证', download: '下载凭证' }
  await perform(labels[action], targets.map(row => ({ name: cpaCredentialName(row), run: () => action === 'download' ? cpaDownload(`credentials/download?name=${encodeURIComponent(cpaCredentialName(row))}`, cpaCredentialName(row)) : api(cpaManagementUrl(action === 'refresh' ? 'credentials/refresh' : 'credentials/status'), { method: action === 'refresh' ? 'POST' : 'PATCH', body: action === 'refresh' ? { name: cpaCredentialName(row), ...(row.auth_index ? { auth_index: row.auth_index } : {}) } : { name: cpaCredentialName(row), disabled: action === 'disable' } }) })))
}
async function toggle(row: Record<string, unknown>) { const result = await run(() => api(cpaManagementUrl('credentials/status'), { method: 'PATCH', body: { name: cpaCredentialName(row), disabled: !row.disabled } }), '凭证状态已更新'); if (result.ok) await refresh() }
async function refreshCredential(row: Record<string, unknown>) { const result = await run(() => api(cpaManagementUrl('credentials/refresh'), { method: 'POST', body: { name: cpaCredentialName(row), ...(row.auth_index ? { auth_index: row.auth_index } : {}) } }), '凭证刷新已处理'); if (result.ok) { details.value = result.value; await refresh() } }
async function inspect(row: Record<string, unknown>) {
  selected.value = row; fields.value = '{}'; fieldError.value = ''; details.value = null
  const result = await run(() => api(cpaManagementUrl('credentials/models'), { query: { name: cpaCredentialName(row) } }))
  if (result.ok) details.value = result.value
}
async function saveFields() {
  let body: unknown
  try { body = JSON.parse(fields.value) } catch { fieldError.value = '请输入有效的 JSON 对象。'; return }
  if (!body || typeof body !== 'object' || Array.isArray(body)) { fieldError.value = '凭证字段必须是 JSON 对象。'; return }
  const result = await run(() => api(cpaManagementUrl('credentials/fields'), { method: 'PATCH', body: { ...body, name: selectedName.value } }), '凭证字段已保存')
  if (result.ok) { fieldError.value = ''; await refresh() }
}
async function resetCooldown() { const index = selected.value?.auth_index; if (!index) return; const result = await run(() => api(cpaManagementUrl('routing/cooldown/reset'), { method: 'POST', body: { auth_index: index } }), '内核冷却状态已重置'); if (result.ok) { details.value = result.value; await refresh() } }
async function remove() { const targets = [...deleteTargets.value]; await perform('删除凭证', targets.map(row => ({ name: cpaCredentialName(row), run: () => api(cpaManagementUrl('credentials'), { method: 'DELETE', query: { name: cpaCredentialName(row) } }) }))); deleteTargets.value = [] }
function quotaLink(row: Record<string, unknown>) { return { path: '/cpa/quota', query: { auth_index: String(row.auth_index || ''), provider: cpaDisplay(row.provider, '') } } }
</script>
<template>
  <section class="table-panel cpa-credential-table">
    <div class="table-toolbar"><label class="search-field"><UIcon name="i-ph-magnifying-glass-bold" /><input v-model="search" aria-label="搜索凭证" placeholder="搜索名称、渠道、邮箱"></label><label class="button"><UIcon name="i-ph-upload-simple-bold" />导入 JSON<input class="sr-only" type="file" accept=".json,application/json" multiple :disabled="busy" @change="upload"></label><button class="button" :disabled="pending || busy" @click="refresh()">重新读取</button><NuxtLink to="/cpa/oauth" class="button">OAuth 登录</NuxtLink><span class="toolbar-meta">{{ rows.length }} 个凭证</span></div>
    <div class="cpa-credential-filters"><label class="nexus-inline-label">渠道<select v-model="providerFilter" aria-label="按凭证渠道筛选"><option value="">全部渠道</option><option v-if="providerFilter && !providerNames.includes(providerFilter)" :value="providerFilter">{{ providerFilter }}</option><option v-for="item in providerNames" :key="item" :value="item">{{ item }}</option></select></label><label class="nexus-inline-label">状态<select v-model="statusFilter" aria-label="按凭证状态筛选"><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option><option value="unavailable">暂不可用</option></select></label><span class="muted small-text">获取于 {{ formatDate(loadedAt) }}</span></div>
    <div v-if="selection.length" class="selection-bar"><span>已选择 {{ selection.length }} 个凭证</span><div class="inline-actions"><button class="button small" :disabled="busy" @click="batch('enable')">批量启用</button><button class="button small" :disabled="busy" @click="batch('disable')">批量停用</button><button class="button small" :disabled="busy || !refreshableSelection.length" @click="batch('refresh')">批量刷新</button><button class="button small" :disabled="busy || !refreshableSelection.length" @click="batch('download')">逐个下载</button><button class="button small danger" :disabled="busy || !refreshableSelection.length" @click="deleteTargets = refreshableSelection">删除所选</button><button class="button small" :disabled="busy" @click="selectedNames = []">取消选择</button></div></div>
    <p v-if="progress" class="cpa-operation-progress" role="status">正在处理 {{ progress.completed }} / {{ progress.total }}</p>
    <AppState v-if="error" :error="error" @retry="refresh()" /><AppState v-else-if="pending && !data" loading /><AppState v-else-if="!visible.length" title="暂无匹配凭证" description="导入凭证文件，或通过 OAuth 登录接入账号。" />
    <div v-else class="table-scroll"><table class="data-table"><thead><tr><th class="checkbox-cell"><input type="checkbox" :checked="allPageSelected" :disabled="busy" aria-label="选择当前页凭证" @change="togglePage"></th><th>凭证</th><th>渠道</th><th>状态 / 额度观察</th><th>操作</th></tr></thead><tbody><tr v-for="row in displayed" :key="cpaCredentialName(row)"><td class="checkbox-cell"><input type="checkbox" :checked="selectedNames.includes(cpaCredentialName(row))" :disabled="busy" :aria-label="`选择 ${cpaCredentialName(row)}`" @change="toggleSelected(row)"></td><td><strong class="nexus-table-name">{{ cpaCredentialName(row) }}</strong><div class="cell-secondary">{{ row.runtime_only ? '仅运行时凭证' : cpaDisplay(row.source, '文件凭证') }}<span v-if="row.email"> · {{ cpaDisplay(row.email) }}</span></div></td><td>{{ cpaDisplay(row.provider) }}</td><td><span class="status-badge" :class="row.disabled ? 'neutral' : row.unavailable ? 'amber' : 'green'">{{ row.disabled ? '已停用' : cpaDisplay(row.status, '状态未返回') }}</span><p v-if="row.status_message" class="cell-error">{{ cpaDisplay(row.status_message) }}</p><p class="cell-secondary">{{ row.quota || row.model_quotas ? '有调用额度观察记录' : '尚无调用额度观察记录' }}</p></td><td><div class="nexus-table-actions"><button class="button small" :disabled="busy" @click="toggle(row)">{{ row.disabled ? '启用' : '停用' }}</button><button class="button small" :disabled="busy || !!row.runtime_only" @click="refreshCredential(row)">刷新</button><button class="button small" :disabled="busy" @click="inspect(row)">详情</button><NuxtLink v-if="row.auth_index" :to="quotaLink(row)" class="button small">额度</NuxtLink><button class="button small" :disabled="busy || !!row.runtime_only" @click="run(() => cpaDownload(`credentials/download?name=${encodeURIComponent(cpaCredentialName(row))}`, cpaCredentialName(row)))">下载</button><button class="button small danger" :disabled="busy || !!row.runtime_only" @click="deleteTargets = [row]">删除</button></div></td></tr></tbody></table></div>
    <AppPagination v-if="visible.length" v-model:page="page" :page-size="pageSize" :total="visible.length" :loading="busy" />
  </section>
  <section v-if="operation" class="panel nexus-compact-panel"><div class="panel-heading"><h2>{{ operation.action }}结果</h2><button class="button small" @click="operation = null">收起</button></div><p class="nexus-description">完成 {{ operation.results.filter(item => item.ok).length }} 个，未完成 {{ operation.results.filter(item => !item.ok).length }} 个。</p><ul class="cpa-operation-results"><li v-for="(item, index) in operation.results" :key="index"><span class="status-badge" :class="item.ok ? 'green' : 'red'">{{ item.ok ? '已处理' : '未完成' }}</span><strong>{{ item.name }}</strong><p v-if="item.message">{{ item.message }}</p></li></ul></section>
  <section v-if="selected" class="panel nexus-compact-panel"><div class="panel-heading"><h2 class="nexus-table-name">{{ selectedName }}</h2><div class="inline-actions"><NuxtLink v-if="selected.auth_index" :to="quotaLink(selected)" class="button small">查看额度</NuxtLink><button v-if="selected.auth_index" class="button small" :disabled="busy" @click="resetCooldown">重置内核冷却</button><button class="button small" @click="selected = null">收起</button></div></div><JsonViewer :value="selected" title="内核凭证记录" /><p class="nexus-description">酒馆预设按平台模型 API key 配置。<NuxtLink to="/presets" class="text-link">管理 key 预设</NuxtLink></p><JsonViewer v-if="details" class="section-gap" :value="details" title="凭证模型 / 操作结果" /><h3 class="nexus-subheading">修改凭证字段</h3><p class="nexus-description">提交需要变更的字段，例如权重、前缀或 headers。内核负责校验字段与凭证类型。</p><textarea v-model="fields" class="nexus-code-editor" rows="6" aria-label="凭证字段 JSON" spellcheck="false" /><p v-if="fieldError" class="inline-error" role="alert">{{ fieldError }}</p><div class="form-actions"><button class="button primary" :disabled="busy || fields.trim() === '{}'" @click="saveFields">保存字段</button></div></section>
  <AppDialog v-model="deleteOpen" title="删除凭证" :description="`删除选中的 ${deleteTargets.length} 个凭证文件，并停用对应运行时凭证。`" :close-disabled="busy"><p class="nexus-description">删除后需要重新导入或授权才能使用。选中的凭证：{{ deleteTargets.map(cpaCredentialName).join('、') }}</p><template #footer><button class="button" :disabled="busy" @click="deleteTargets = []">取消</button><button class="button danger-solid" :disabled="busy" @click="remove">删除凭证</button></template></AppDialog>
</template>
<style scoped>
.cpa-credential-filters { display: flex; align-items: center; gap: 15px; flex-wrap: wrap; padding: 0 20px 16px; }.cpa-credential-filters > span { margin-left: auto; }
.cpa-operation-progress { padding: 11px 20px; font-size: 13px; color: var(--muted); }
.cpa-operation-results { list-style: none; padding: 0; display: grid; gap: 11px; }.cpa-operation-results li { display: flex; gap: 10px; flex-wrap: wrap; align-items: baseline; font-size: 12px; }.cpa-operation-results strong { font-weight: 500; overflow-wrap: anywhere; }.cpa-operation-results p { width: 100%; color: var(--red); overflow-wrap: anywhere; }
.cpa-credential-table .selection-bar { flex-wrap: wrap; }.cpa-credential-table .selection-bar .inline-actions { flex-wrap: wrap; }
@media (max-width: 600px) { .cpa-credential-filters { align-items: flex-start; padding: 0 15px 14px; }.cpa-credential-filters > span { width: 100%; margin-left: 0; }.cpa-credential-table .search-field { width: 100%; min-width: 0; } }
</style>