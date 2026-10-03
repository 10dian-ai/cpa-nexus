<script setup lang="ts">
interface QuotaWindow { id: string; name: string; usedPercent?: number; remainingPercent?: number; used?: number; limit?: number; remaining?: number; resetsAt?: string | number | null }
interface QuotaResult { provider: string; authIndex: string; checkedAt: string; source: string; raw: unknown; windows: QuotaWindow[]; errors?: (string | { source?: string; message: string })[] }
const api = useRequestFetch(), route = useRoute()
const { data: capabilities, pending: discovering, error: capabilityError, refresh: discover } = await useCpaCapabilities()
const { data: credentials, pending: readingAccounts, error: accountError, refresh: readAccounts } = await useFetch<unknown>(cpaManagementUrl('credentials'), { key: 'cpa-credentials' })
const providers = computed(() => capabilities.value?.quotaProviders || [])
const rows = computed(() => cpaEntries(credentials.value, 'files'))
const providerId = ref(String(route.query.provider || '')), authIndex = ref(String(route.query.auth_index || ''))
const selectedProvider = computed(() => providers.value.find(item => item.id === providerId.value))
function supportedProviders(provider: CpaQuotaProvider) { return provider.credentialProviders?.length ? provider.credentialProviders : [provider.provider || provider.id] }
const accountRows = computed(() => selectedProvider.value ? rows.value.filter(row => Array.isArray(selectedProvider.value!.authIndices) ? selectedProvider.value!.authIndices.includes(String(row.auth_index || '')) : supportedProviders(selectedProvider.value!).includes(cpaDisplay(row.provider, ''))) : [])
const account = computed(() => accountRows.value.find(row => String(row.auth_index || '') === authIndex.value))
watch(providers, items => {
  if (!items.some(item => item.id === providerId.value)) {
    const requestedAccount = rows.value.find(row => String(row.auth_index || '') === String(route.query.auth_index || ''))
    providerId.value = items.find(item => item.pluginId === String(route.query.plugin_id || '') && !!item.pluginId || item.provider === String(route.query.provider || '') && !!item.provider)?.id || items.find(item => requestedAccount && supportedProviders(item).includes(cpaDisplay(requestedAccount.provider, '')))?.id || items.find(item => item.available)?.id || items[0]?.id || ''
  }
}, { immediate: true })
watch(accountRows, items => { if (!items.some(row => String(row.auth_index || '') === authIndex.value)) authIndex.value = items[0]?.auth_index ? String(items[0].auth_index) : '' }, { immediate: true })
const results = ref<Record<string, QuotaResult>>({}), queryError = ref('')
const resultKey = computed(() => providerId.value + ':' + authIndex.value)
const current = computed(() => results.value[resultKey.value])
const observation = computed(() => account.value && (account.value.quota || account.value.model_quotas) ? { quota: account.value.quota || null, model_quotas: account.value.model_quotas || null } : null)
const { busy, run } = useApiAction()
const resetOpen = ref(false), resetResult = ref<unknown>(null)
watch([providerId, authIndex], () => { queryError.value = ''; resetResult.value = null })
function object(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null }
function genericResult(value: unknown, provider: CpaQuotaProvider, index: string): QuotaResult {
  const outer = object(value), raw = object(outer?.quota) || outer || {}, windows: QuotaWindow[] = []
  if (Array.isArray(raw.groups)) raw.groups.forEach((group, groupIndex) => {
    const item = object(group)
    if (!Array.isArray(item?.buckets)) return
    item.buckets.forEach((bucket, bucketIndex) => {
      const entry = object(bucket); if (!entry) return
      const fraction = typeof entry.remainingFraction === 'number' ? entry.remainingFraction : undefined
      windows.push({ id: `${groupIndex}-${bucketIndex}`, name: [item.displayName, entry.window, entry.description].filter(value => typeof value === 'string' && value).join(' · ') || '额度窗口', ...(fraction !== undefined && Number.isFinite(fraction) ? { remainingPercent: fraction * 100 } : {}), ...(typeof entry.resetTime === 'string' || typeof entry.resetTime === 'number' ? { resetsAt: entry.resetTime } : {}) })
    })
  })
  return { provider: provider.provider || provider.id, authIndex: index, checkedAt: new Date().toISOString(), source: provider.pluginId ? `CPA 插件 ${provider.pluginId}` : 'CPA 原生配额接口', raw: value, windows }
}
async function refreshQuota() {
  const provider = selectedProvider.value, index = authIndex.value, key = resultKey.value
  if (!provider?.available || !index) return
  queryError.value = ''
  const result = await run(async () => {
    try {
      if (provider.source === 'core-api-call') return await api<QuotaResult>('/api/cpa/quota/native', { method: 'POST', body: { auth_index: index, provider: provider.provider || provider.id }, timeout: 120000 })
      const value = await api('/api/cpa/legacy-quota/fetch', { method: 'POST', body: { auth_index: index, provider: provider.provider || cpaDisplay(account.value?.provider, '') || provider.credentialProviders?.[0] || provider.id, ...(provider.pluginId ? { plugin_id: provider.pluginId } : {}) }, timeout: 120000 })
      return genericResult(value, provider, index)
    } catch (error) { queryError.value = apiErrorMessage(error); throw error }
  })
  if (result.ok) results.value[key] = result.value
}
async function resetQuota() {
  const provider = selectedProvider.value
  if (!provider?.supportsReset || !authIndex.value) return
  const result = await run(() => api('/api/cpa/legacy-quota/reset', { method: 'POST', body: { auth_index: authIndex.value, provider: provider.provider || cpaDisplay(account.value?.provider, '') || provider.credentialProviders?.[0] || provider.id, ...(provider.pluginId ? { plugin_id: provider.pluginId } : {}) }, timeout: 120000 }), '上游额度重置已处理')
  if (result.ok) { resetOpen.value = false; resetResult.value = result.value }
}
function percent(value: number | undefined) { return typeof value === 'number' && Number.isFinite(value) ? formatNumber(value) + '%' : '未知' }
function progressValue(window: QuotaWindow) { const value = window.remainingPercent ?? window.usedPercent; return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null }
</script>
<template>
  <div class="nexus-stack cpa-quota-center">
    <section class="panel"><div class="panel-heading"><h2>账号额度</h2><button class="button small" :disabled="discovering || readingAccounts || busy" @click="discover(); readAccounts()"><UIcon name="i-ph-arrow-clockwise-bold" />重新检测账号</button></div><p class="nexus-description">先显示内核从实际调用中保存的额度观察。点击“查询官方额度”后，才会向该账号的官方额度接口查询；账号或接口未提供的数据保持未知。</p><AppState v-if="capabilityError || accountError" :error="capabilityError || accountError" compact @retry="discover(); readAccounts()" /><AppState v-else-if="!capabilities || !credentials" compact loading />
      <template v-else><p v-for="(item, index) in capabilities.errors || []" :key="index" class="inline-error">{{ cpaCapabilityError(item) }}</p><AppState v-if="!providers.length" compact title="尚未发现可查询的额度渠道" description="当前内核和插件没有返回主动额度查询能力。已有调用观察仍保存在账号凭证中。" /><template v-else><div class="form-row"><label class="field"><span>额度渠道</span><select v-model="providerId" :disabled="busy"><option v-for="item in providers" :key="item.id" :value="item.id">{{ item.name }}{{ item.available ? '' : ' · 暂不可用' }}</option></select></label><label class="field"><span>选择账号</span><select v-model="authIndex" :disabled="busy || !accountRows.length"><option v-if="!accountRows.length" value="">没有匹配账号</option><option v-for="row in accountRows" :key="String(row.auth_index)" :value="String(row.auth_index)">{{ cpaCredentialName(row) }}{{ row.disabled ? ' · 已停用' : '' }}</option></select></label></div><p v-if="selectedProvider?.reason || selectedProvider?.message" class="inline-error">{{ selectedProvider.reason || selectedProvider.message }}</p><div class="nexus-editor-footer"><span class="muted small-text">{{ selectedProvider?.source === 'core-api-call' ? '官方账号接口 · CPA 代为认证' : selectedProvider?.pluginId ? `原生插件：${selectedProvider.pluginId}` : 'CPA 配额查询能力' }} · 核对于 {{ formatDate(capabilities.checkedAt) }}</span><div class="inline-actions"><button class="button primary" :disabled="busy || !authIndex || !selectedProvider?.available" @click="refreshQuota"><UIcon v-if="busy" name="i-ph-circle-notch-bold" class="spinning" />查询官方额度</button><button v-if="selectedProvider?.supportsReset" class="button danger" :disabled="busy || !authIndex || !selectedProvider.available" @click="resetOpen = true">重置上游额度</button></div></div></template></template>
    </section>
    <section v-if="account" class="panel"><div class="panel-heading"><h2>{{ cpaCredentialName(account) }}</h2><span class="status-badge" :class="account.disabled ? 'neutral' : account.unavailable ? 'amber' : 'green'">{{ account.disabled ? '已停用' : cpaDisplay(account.status, '内核未返回状态') }}</span></div><p v-if="account.status_message" class="inline-error">{{ cpaDisplay(account.status_message) }}</p><dl class="nexus-definition-list"><div><dt>渠道</dt><dd>{{ cpaDisplay(account.provider) }}</dd></div><div><dt>最近凭证刷新</dt><dd>{{ formatDate(typeof account.last_refresh === 'string' ? account.last_refresh : null) }}</dd></div></dl><details class="raw-details section-gap"><summary>实际调用保存的额度观察</summary><JsonViewer v-if="observation" :value="observation" title="内核观察快照" /><p v-else class="nexus-empty-note">内核尚未提供此账号的额度观察。可以点击查询获取官方结果。</p></details></section>
    <div v-if="queryError" class="notice error-notice" role="alert"><UIcon name="i-ph-warning-circle-bold" /><p>{{ queryError }}<span v-if="current">。下方保留上次成功的结果，请留意获取时间。</span></p></div>
    <section v-if="current" class="panel"><div class="panel-heading"><h2>最近官方查询结果</h2><span class="muted small-text">获取于 {{ formatDate(current.checkedAt) }}</span></div><p class="nexus-description">来源：{{ current.source }}</p><p v-for="(item, index) in current.errors || []" :key="index" class="inline-error">{{ cpaCapabilityError(item) }}</p><div v-if="current.windows.length" class="cpa-quota-windows"><article v-for="window in current.windows" :key="window.id" class="cpa-quota-window"><h3>{{ window.name }}</h3><dl><div v-if="window.usedPercent !== undefined"><dt>已用比例</dt><dd>{{ percent(window.usedPercent) }}</dd></div><div v-if="window.remainingPercent !== undefined"><dt>剩余比例</dt><dd>{{ percent(window.remainingPercent) }}</dd></div><div v-if="window.used !== undefined"><dt>实际已用</dt><dd>{{ formatNumber(window.used) }}</dd></div><div v-if="window.limit !== undefined"><dt>官方上限</dt><dd>{{ formatNumber(window.limit) }}</dd></div><div v-if="window.remaining !== undefined"><dt>官方剩余</dt><dd>{{ formatNumber(window.remaining) }}</dd></div><div><dt>重置时间</dt><dd>{{ window.resetsAt ? formatDate(window.resetsAt) : '官方未提供' }}</dd></div></dl><progress v-if="progressValue(window) !== null" :value="progressValue(window)!" max="100" :aria-label="`${window.name}${window.remainingPercent !== undefined ? '剩余' : '已用'}比例`" /></article></div><p v-else class="nexus-empty-note">接口没有提供可识别的额度窗口，原始官方返回仍保留在下方。</p><details class="raw-details section-gap"><summary>官方返回的原始额度字段</summary><JsonViewer :value="current.raw" title="官方额度数据" /></details></section>
    <section v-if="resetResult !== null" class="panel"><div class="panel-heading"><h2>上游额度重置结果</h2></div><JsonViewer :value="resetResult" title="CPA 返回结果" /></section>
    <AppDialog v-model="resetOpen" title="重置上游额度" description="调用这个渠道提供的额度重置能力。" :close-disabled="busy"><p class="nexus-description">这会调用上游额度重置接口，具体结果由渠道决定。它与清除 CPA 的请求冷却状态不同。</p><template #footer><button class="button" :disabled="busy" @click="resetOpen = false">取消</button><button class="button danger-solid" :disabled="busy" @click="resetQuota">确认重置上游额度</button></template></AppDialog>
  </div>
</template>
<style scoped>
.cpa-quota-center select { width: 100%; font-size: 13px; }.cpa-quota-center .form-row { align-items: start; }
.cpa-quota-windows { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }.cpa-quota-window { padding: 18px 0; border-top: 1px solid var(--border); }.cpa-quota-window h3 { font-size: 15px; font-weight: 600; margin-bottom: 15px; }.cpa-quota-window dl { display: grid; gap: 11px; margin-bottom: 18px; }.cpa-quota-window dl > div { display: flex; justify-content: space-between; align-items: baseline; gap: 14px; }.cpa-quota-window dt { font-size: 12px; color: var(--muted); }.cpa-quota-window dd { margin: 0; font-size: 14px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; text-align: right; }
@media (max-width: 600px) { .cpa-quota-center .form-row, .cpa-quota-windows { grid-template-columns: 1fr; } }
</style>