<script setup lang="ts">
interface DevinAccount { id:string; label:string; baseUrl:string; model:string|null; proxy:string|null; enabled:boolean; status:string; snapshot:Record<string,unknown>|null; syncError:string|null; lastSyncAt:string|null; lastUsedAt:string|null; createdAt:string; updatedAt:string; hasToken:boolean }
interface DevinStatus { configured:boolean; url:string|null; reachable:boolean; status:string; message:string; modelCount:number; checkedAt:string }
interface DevinModel { id:string; name:string; ownedBy:string }
interface DevinLog { id:string; accountId:string|null; accountLabel:string|null; keyName:string|null; model:string; protocol:string; status:string; httpStatus:number|null; durationMs:number; usage:Record<string,unknown>|null; errorMessage:string|null; createdAt:string; streaming:boolean; responseTruncated:boolean }
interface DevinLogList { items:DevinLog[]; total:number; page:number; pageSize:number }
interface DevinSettings { settings:{url:string|null;configured:boolean;apiKeyConfigured:boolean;timeoutMs:number}; status:DevinStatus }

const route = useRoute()
const api = useRequestFetch()
const { busy, run } = useApiAction()
const tabs = [
  { id:'overview', label:'运行概览', icon:'i-ph-chart-bar-bold' },
  { id:'accounts', label:'账号与令牌', icon:'i-ph-users-three-bold' },
  { id:'models', label:'模型目录', icon:'i-ph-cube-bold' },
  { id:'logs', label:'调用日志', icon:'i-ph-list-bullets-bold' },
  { id:'settings', label:'模块设置', icon:'i-ph-sliders-horizontal-bold' },
]
const tab = computed(() => tabs.some(item => item.id === route.query.tab) ? String(route.query.tab) : 'overview')
function setTab(id:string) { void navigateTo({ path:'/devin2api', query: id === 'overview' ? undefined : { tab:id } }) }
useHead(() => ({ title: `${tabs.find(item => item.id === tab.value)?.label || 'Devin'} · CPA Nexus` }))

const { data: status, pending: statusPending, error: statusError, refresh: refreshStatus } = await useFetch<DevinStatus>('/api/devin2api/status')
const { data: accounts, pending: accountsPending, error: accountsError, refresh: refreshAccounts } = await useFetch<DevinAccount[]>('/api/devin2api/accounts')
const { data: models, pending: modelsPending, error: modelsError, refresh: refreshModels } = await useFetch<{items:DevinModel[];updatedAt:string}>('/api/devin2api/models')
const { data: settings, pending: settingsPending, error: settingsError, refresh: refreshSettings } = await useFetch<DevinSettings>('/api/devin2api/settings')
const logPage = ref(1); const logModel = ref(''); const logModelInput = ref(''); const logStatus = ref('')
const { data: logs, pending: logsPending, error: logsError, refresh: refreshLogs } = await useFetch<DevinLogList>('/api/devin2api/logs', { query:{ page:logPage, pageSize:50, model:logModel, status:logStatus } })
watch([logStatus, logModel], () => { logPage.value = 1 })
watch(() => logs.value?.total, total => { if (total !== undefined) logPage.value = Math.min(logPage.value, Math.max(1, Math.ceil(total / 50))) })
useLiveRefresh(() => Promise.all([refreshStatus(), refreshAccounts(), refreshModels(), refreshLogs(), refreshSettings()]))

const form = reactive({ label:'', token:'', baseUrl:'', model:'', proxy:'' })
const showToken = ref(false)
async function createAccount() {
  const result = await run(() => api<DevinAccount>('/api/devin2api/accounts', { method:'POST', body:{ ...form, token: form.token || undefined, baseUrl: form.baseUrl || undefined, model: form.model || undefined, proxy: form.proxy || undefined } }), 'Devin 账号已添加')
  if (result.ok) { Object.assign(form, { label:'', token:'', baseUrl:'', model:'', proxy:'' }); await refreshAccounts() }
}
async function toggleAccount(account:DevinAccount) {
  const result = await run(() => api<DevinAccount>(`/api/devin2api/accounts/${account.id}`, { method:'PATCH', body:{ enabled:!account.enabled } }), account.enabled ? '账号已停用' : '账号已启用')
  if (result.ok) await refreshAccounts()
}
async function removeAccount(account:DevinAccount) {
  if (!window.confirm(`确定删除 Devin 账号“${account.label}”吗？`)) return
  const result = await run(() => api(`/api/devin2api/accounts/${account.id}`, { method:'DELETE' }), 'Devin 账号已删除')
  if (result.ok) await refreshAccounts()
}
async function refreshAll() { await Promise.all([refreshStatus(), refreshAccounts(), refreshModels(), refreshLogs(), refreshSettings()]) }
function usageTotal(log:DevinLog) { const value = log.usage?.total_tokens ?? log.usage?.totalTokens; return typeof value === 'number' ? formatNumber(value) : '—' }
function statusLabel(value:string) { return value === 'ready' ? '正常' : value === 'pending' ? '待检查' : value === 'error' ? '错误' : value }
</script>

<template>
  <AppPageHeader title="Devin 模块" description="以独立模块接入 devin-2api；账号、模型、酒馆预设路由和调用日志在此统一管理。">
    <button class="button" :disabled="statusPending || accountsPending" @click="refreshAll"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: statusPending || accountsPending }" />刷新状态</button>
    <NuxtLink to="/groups/accounts?module=devin2api" class="button"><UIcon name="i-ph-users-four-bold" />调用分组</NuxtLink>
  </AppPageHeader>
  <nav class="nexus-tabs devin-tabs" aria-label="Devin 模块页面">
    <button v-for="item in tabs" :key="item.id" :class="{ active: tab === item.id }" @click="setTab(item.id)"><UIcon :name="item.icon" />{{ item.label }}</button>
  </nav>

  <AppState v-if="statusError && tab === 'overview'" :error="statusError" @retry="refreshStatus()" />
  <template v-if="tab === 'overview'">
    <AppState v-if="!status && statusPending" :loading="true" />
    <template v-else-if="status">
      <div class="metric-grid">
        <section class="metric-card"><div class="metric-top"><span>适配服务</span><UIcon name="i-ph-plugs-connected-bold" /></div><strong>{{ status.reachable ? '已连接' : '不可用' }}</strong><p>{{ status.message }}</p></section>
        <section class="metric-card"><div class="metric-top"><span>可用模型</span><UIcon name="i-ph-cube-bold" /></div><strong>{{ formatNumber(status.modelCount) }}</strong><p>来自 Devin 适配服务的实时目录</p></section>
        <section class="metric-card"><div class="metric-top"><span>已配置账号</span><UIcon name="i-ph-users-three-bold" /></div><strong>{{ formatNumber(accounts?.length || 0) }}</strong><p>令牌保存在本地加密存储中</p></section>
      </div>
      <section class="panel overview-panel"><div class="panel-heading"><h2>调用链路</h2><StatusBadge :status="status.reachable ? 'ready' : 'error'" :label="status.reachable ? '可调用' : '待配置'" /></div><p>客户端请求进入 CPA Nexus 后，先按 <span class="mono">devin/模型 ID</span> 选择 Devin 模块，再应用绑定的酒馆预设，最后由内部适配服务转发到 Devin。</p><dl class="summary-rows"><div><dt>适配服务地址</dt><dd class="mono">{{ status.url || '未配置' }}</dd></div><div><dt>最近检查</dt><dd>{{ formatDate(status.checkedAt) }}</dd></div><div><dt>日志入口</dt><dd><button class="text-link" @click="setTab('logs')">查看 Devin 调用日志<UIcon name="i-ph-arrow-right-bold" /></button></dd></div></dl></section>
    </template>
  </template>

  <template v-else-if="tab === 'accounts'">
    <section class="panel account-form-panel"><div class="panel-heading"><div><h2>添加 Devin 账号</h2><p class="panel-note">令牌使用 CPA Nexus 的加密密钥保存，并作为本模块的分组来源；devin-2api 进程仍需配置自身的会话令牌。</p></div></div><form class="devin-form-grid" @submit.prevent="createAccount"><label class="field"><span>显示名称</span><input v-model="form.label" required maxlength="200" placeholder="Devin 主账号"></label><label class="field"><span>devin-session-token</span><div class="input-with-action"><input v-model="form.token" :type="showToken ? 'text' : 'password'" maxlength="20000" placeholder="可留空，使用适配服务环境变量"><button type="button" class="icon-button" :aria-label="showToken ? '隐藏令牌' : '显示令牌'" @click="showToken = !showToken"><UIcon :name="showToken ? 'i-ph-eye-slash-bold' : 'i-ph-eye-bold'" /></button></div></label><label class="field"><span>Devin 地址（可选）</span><input v-model="form.baseUrl" type="url" placeholder="https://server.codeium.com"></label><label class="field"><span>默认模型（可选）</span><input v-model="form.model" maxlength="200" placeholder="cascade"></label><label class="field"><span>代理（可选）</span><input v-model="form.proxy" maxlength="500" placeholder="http://proxy:8080"></label><div class="form-actions"><button class="button primary" :disabled="busy || !form.label.trim()"><UIcon v-if="busy" name="i-ph-circle-notch-bold" class="spinning" />保存账号</button></div></form></section>
    <section class="table-panel"><div class="table-toolbar"><strong>账号列表</strong><span class="toolbar-meta">{{ accounts?.length || 0 }} 个账号</span></div><AppState v-if="accountsError" :error="accountsError" @retry="refreshAccounts()" /><AppState v-else-if="accountsPending && !accounts" :loading="true" /><AppState v-else-if="!accounts?.length" icon="i-ph-users-three-bold" title="还没有 Devin 账号" description="添加账号，或在部署环境配置 DEVIN2API_URL 与 DEVIN2API_API_KEY。" /><div v-else class="table-scroll"><table class="data-table"><thead><tr><th>账号</th><th>上游</th><th>默认模型</th><th>状态</th><th>最近使用</th><th class="align-right">操作</th></tr></thead><tbody><tr v-for="account in accounts" :key="account.id"><td><strong>{{ account.label }}</strong><div class="cell-secondary">{{ account.hasToken ? '已保存令牌' : '使用适配服务令牌' }}</div></td><td class="mono">{{ account.baseUrl || '适配服务默认地址' }}</td><td class="mono">{{ account.model || '由请求指定' }}</td><td><StatusBadge :status="account.enabled ? account.status : 'disabled'" :label="account.enabled ? statusLabel(account.status) : '已停用'" /><div v-if="account.syncError" class="cell-secondary inline-error">{{ account.syncError }}</div></td><td class="date-text">{{ formatDate(account.lastUsedAt) }}</td><td class="align-right"><button class="button small" :disabled="busy" @click="toggleAccount(account)">{{ account.enabled ? '停用' : '启用' }}</button><button class="button small danger" :disabled="busy" @click="removeAccount(account)">删除</button></td></tr></tbody></table></div></section>
  </template>

  <template v-else-if="tab === 'models'">
    <section class="panel model-heading"><div><h2>模型目录</h2><p>模型 ID 在 CPA Nexus 中以 <span class="mono">devin/</span> 前缀注册，避免与 CPA 原生供应商冲突。</p></div><button class="button" :disabled="modelsPending" @click="() => refreshModels()"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: modelsPending }" />刷新目录</button></section>
    <section class="table-panel"><AppState v-if="modelsError" :error="modelsError" @retry="refreshModels()" /><AppState v-else-if="!models" :loading="modelsPending" /><AppState v-else-if="!models.items.length" icon="i-ph-cube-bold" title="没有读取到模型" description="检查 Devin 适配服务是否已启动，并确认 DEVIN2API_URL 配置正确。" /><div v-else class="table-scroll"><table class="data-table"><thead><tr><th>模型 ID</th><th>显示名称</th><th>所有者</th><th>CPA 路由 ID</th></tr></thead><tbody><tr v-for="model in models.items" :key="model.id"><td class="mono">{{ model.id }}</td><td>{{ model.name }}</td><td>{{ model.ownedBy }}</td><td class="mono">devin/{{ model.id }}</td></tr></tbody></table></div><div v-if="models" class="table-footnote">目录更新于 {{ formatDate(models.updatedAt) }}。请求模型时使用上表中的 CPA 路由 ID，并可在调用分组中授予 Devin 来源。</div></section>
  </template>

  <template v-else-if="tab === 'logs'">
    <section class="table-panel"><form class="table-toolbar" @submit.prevent="logModel = logModelInput.trim()"><label class="search-field"><UIcon name="i-ph-magnifying-glass-bold" /><input v-model="logModelInput" aria-label="按模型筛选" placeholder="输入模型 ID"><button v-if="logModelInput" class="icon-button" type="button" aria-label="清除模型筛选" @click="logModelInput = ''; logModel = ''"><UIcon name="i-ph-x-bold" /></button></label><button class="button">搜索</button><select v-model="logStatus" aria-label="请求结果"><option value="">全部结果</option><option value="success">成功</option><option value="error">错误</option><option value="cancelled">取消</option><option value="incomplete">不完整</option></select><button type="button" class="button" :disabled="logsPending" @click="refreshLogs()">刷新</button></form><AppState v-if="logsError" :error="logsError" @retry="refreshLogs()" /><AppState v-else-if="!logs" :loading="logsPending" /><AppState v-else-if="!logs.items.length" icon="i-ph-list-bullets-bold" title="还没有 Devin 调用记录" description="使用 devin/模型 ID 发起调用后，日志会显示在这里。" /><div v-else class="table-scroll"><table class="data-table log-table"><thead><tr><th>时间 / 密钥</th><th>模型 / 协议</th><th>账号</th><th>结果</th><th class="align-right">耗时</th><th class="align-right">Token</th></tr></thead><tbody><tr v-for="log in logs.items" :key="log.id"><td><span class="date-text">{{ formatDate(log.createdAt) }}</span><div class="cell-secondary">{{ log.keyName || '密钥记录不可用' }}</div></td><td><strong class="mono model-id">{{ log.model || '未指定模型' }}</strong><div class="cell-secondary">{{ log.protocol }} · {{ log.streaming ? '流式' : '非流式' }}</div></td><td>{{ log.accountLabel || '适配服务' }}</td><td><StatusBadge :status="log.status" /><div class="cell-secondary">HTTP {{ log.httpStatus ?? '—' }}</div></td><td class="mono align-right">{{ formatDuration(log.durationMs) }}</td><td class="mono align-right">{{ usageTotal(log) }}</td></tr></tbody></table></div><AppPagination v-if="logs" v-model:page="logPage" :page-size="50" :total="logs.total" :loading="logsPending" /></section>
  </template>

  <template v-else>
    <AppState v-if="settingsError" :error="settingsError" @retry="refreshSettings()" /><AppState v-else-if="!settings" :loading="settingsPending" /><template v-else><section class="panel settings-section"><div class="settings-description"><UIcon name="i-ph-plugs-connected-bold" /><h2>适配服务连接</h2><p>Devin 由独立 devin-2api 服务承载。更新地址和 API Key 后，请重启适配服务或重新部署容器。</p></div><dl class="kernel-fields"><div><dt>服务地址</dt><dd class="mono">{{ settings.settings.url || '未配置' }}</dd></div><div><dt>内部认证</dt><dd>{{ settings.settings.apiKeyConfigured ? '已配置 API Key' : '未配置（仅适用于未启用认证的适配服务）' }}</dd></div><div><dt>请求超时</dt><dd>{{ settings.settings.timeoutMs }} ms</dd></div><div><dt>当前状态</dt><dd><StatusBadge :status="settings.status.reachable ? 'ready' : 'error'" :label="settings.status.reachable ? '可连接' : '不可连接'" /></dd></div></dl></section><section class="notice"><UIcon name="i-ph-info-bold" /><p>令牌不会通过此页面回显。令牌使用平台加密密钥保存；devin-2api 进程使用其自身配置的 Devin 会话令牌，调用时仅转发受控请求。酒馆预设仍由平台的“酒馆预设”页面统一维护并按 Devin 调用分组生效。</p></section></template>
  </template>
</template>

<style scoped>
.devin-tabs { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:22px; }
.devin-tabs button { display:inline-flex; align-items:center; gap:7px; }
.overview-panel { margin-top:22px; }
.model-heading { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:22px; }
.model-heading h2 { margin:0; }
.model-heading p { margin:5px 0 0; color:var(--muted); font-size:12px; }
.account-form-panel { margin-bottom:22px; }
.devin-form-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px 20px; }
.devin-form-grid .form-actions { display:flex; align-items:end; justify-content:flex-end; }
.input-with-action { display:flex; gap:6px; }
.input-with-action input { min-width:0; flex:1; }
.settings-section { margin-bottom:22px; }
.settings-description { display:flex; align-items:flex-start; gap:10px; margin-bottom:18px; }
.settings-description > .i-ph { color:var(--accent); font-size:22px; }
.settings-description h2 { margin:0; }
.settings-description p { grid-column:2; margin:4px 0 0; color:var(--muted); font-size:12px; }
.kernel-fields { display:grid; gap:0; }
.kernel-fields > div { display:flex; justify-content:space-between; gap:20px; padding:11px 0; border-top:1px solid var(--border); }
.kernel-fields dt { color:var(--muted); }
.kernel-fields dd { margin:0; text-align:right; overflow-wrap:anywhere; }
@media (max-width:720px) { .devin-form-grid { grid-template-columns:1fr; } .kernel-fields > div { display:block; } .kernel-fields dd { margin-top:5px; text-align:left; } }
</style>
