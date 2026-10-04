<script setup lang="ts">
interface OAuthSession { status: string; url?: string; state?: string; error?: string; flow?: string; user_code?: string; expires_in?: number }
const emit = defineEmits<{ 'provider-change': [provider: string]; authorized: [] }>()
const api = useRequestFetch()
const { data: capabilities, pending: discovering, error: discoveryError, refresh: discover } = await useCpaCapabilities()
const route = useRoute()
const provider = ref(String(route.query.provider || '')), search = ref(''), kimiDomain = ref('kimi.com'), projectId = ref('')
const sessionProvider = ref(''), session = ref<OAuthSession | null>(null), status = ref(''), oauthError = ref('')
const callback = ref(''), callbackMode = ref<'url' | 'code'>('url'), checkedAt = ref<string | null>(null), expiresAt = ref<number | null>(null)
const { busy, run } = useApiAction()
const providers = computed(() => capabilities.value?.oauthProviders || [])
const selectedProvider = computed(() => providers.value.find(item => item.id === provider.value))
const visibleProviders = computed(() => providers.value.filter(item => [item.name, item.id, item.pluginId || ''].some(value => value.toLowerCase().includes(search.value.toLowerCase()))))
watch(providers, items => { if (!items.some(item => item.id === provider.value)) provider.value = items.find(item => item.id === String(route.query.provider || '') || item.pluginId === String(route.query.plugin_id || '') && !!item.pluginId)?.id || items.find(item => item.available)?.id || items[0]?.id || '' }, { immediate: true })
watch(provider, value => emit('provider-change', value), { immediate: true })
const waiting = computed(() => status.value === 'wait'), deviceFlow = computed(() => session.value?.flow === 'device')
const browserUrl = computed(() => { try { const url = new URL(session.value?.url || ''); return ['http:', 'https:'].includes(url.protocol) ? url.href : '' } catch { return '' } })
let timer: ReturnType<typeof setTimeout> | undefined, active = true, generation = 0
function stopPolling() { if (timer) clearTimeout(timer); timer = undefined }
async function poll(id: number) {
  if (!active || id !== generation || !session.value?.state) return
  if (expiresAt.value !== null && Date.now() >= expiresAt.value) { status.value = 'expired'; stopPolling(); return }
  try {
    const result = await api<OAuthSession>(cpaManagementUrl('oauth/status'), { query: { state: session.value.state } })
    if (!active || id !== generation) return
    checkedAt.value = new Date().toISOString(); status.value = result.status; oauthError.value = result.error || ''
    if (result.status === 'wait') timer = setTimeout(() => void poll(id), 3000)
    else if (result.status === 'ok') emit('authorized')
  } catch (error) { if (active && id === generation) { oauthError.value = apiErrorMessage(error); status.value = 'error' } }
}
async function forgetSession() {
  if (!session.value?.state) return
  try { await api(cpaManagementUrl('oauth/session'), { method: 'DELETE', query: { state: session.value.state } }) }
  catch (error) { const code = (error as { statusCode?: number; status?: number }).statusCode || (error as { status?: number }).status; if (code !== 404) throw error }
}
async function start() {
  if (waiting.value || !selectedProvider.value?.available) return
  const result = await run(async () => {
    if (session.value?.state && ['error', 'expired'].includes(status.value)) await forgetSession()
    stopPolling(); generation++; oauthError.value = ''; callback.value = ''; checkedAt.value = null
    const query: Record<string, string | boolean> = { provider: provider.value, is_webui: true }
    if (provider.value === 'kimi') query.domain = kimiDomain.value
    if (provider.value === 'gemini-cli' && projectId.value.trim()) query.project_id = projectId.value.trim()
    return api<OAuthSession>(cpaManagementUrl('oauth/auth-url'), { query })
  })
  if (!result.ok || !active) return
  session.value = result.value; sessionProvider.value = provider.value
  expiresAt.value = typeof result.value.expires_in === 'number' && result.value.expires_in > 0 ? Date.now() + result.value.expires_in * 1000 : null
  status.value = result.value.status === 'ok' ? result.value.state ? 'wait' : 'ok' : 'error'; oauthError.value = result.value.error || ''; checkedAt.value = new Date().toISOString()
  if (result.value.state && waiting.value) void poll(generation)
  else if (status.value === 'ok') emit('authorized')
}
async function cancel() { generation++; stopPolling(); const result = await run(forgetSession, '授权会话已取消'); if (result.ok) status.value = 'cancelled'; else { status.value = 'error'; oauthError.value = '取消授权未完成，可以重新查询会话状态。' } }
async function submitCallback() {
  if (!session.value?.state || !callback.value.trim() || deviceFlow.value) return
  const body = { provider: sessionProvider.value, state: session.value.state, ...(callbackMode.value === 'url' ? { redirect_url: callback.value.trim() } : { code: callback.value.trim() }) }
  const result = await run(() => api(cpaManagementUrl('oauth/callback'), { method: 'POST', body }), '回调已提交，正在等待授权结果')
  if (result.ok) { callback.value = ''; generation++; stopPolling(); void poll(generation) }
}
function retryPolling() { generation++; status.value = 'wait'; oauthError.value = ''; stopPolling(); void poll(generation) }
const statusLabel = computed(() => ({ wait: '等待完成授权', ok: '授权成功', error: '授权未完成', cancelled: '已取消', expired: '授权会话已过期' } as Record<string, string>)[status.value] || status.value)
onBeforeUnmount(() => { active = false; generation++; stopPolling() })
</script>
<template>
  <section class="panel cpa-oauth-center">
    <div class="panel-heading"><h2>选择登录渠道</h2><button class="button small" :disabled="discovering || busy || waiting" @click="discover()"><UIcon name="i-ph-arrow-clockwise-bold" />重新发现渠道</button></div>
    <p class="nexus-description">渠道来自当前 CPA 内核和已发现的插件。授权完成后由 CPA 保存凭证，设备码登录会持续查询结果。</p>
    <AppState v-if="discoveryError && !capabilities" :error="discoveryError" compact @retry="discover()" /><AppState v-else-if="!capabilities" loading compact />
    <template v-else>
      <p v-for="(item, index) in capabilities.errors || []" :key="index" class="inline-error">{{ cpaCapabilityError(item) }}</p>
      <label class="search-field cpa-provider-search"><UIcon name="i-ph-magnifying-glass-bold" /><input v-model="search" aria-label="搜索 OAuth 渠道" placeholder="搜索渠道、名称或插件"></label>
      <div v-if="visibleProviders.length" class="cpa-provider-grid"><button v-for="item in visibleProviders" :key="item.id" class="cpa-provider-option" :class="{ active: provider === item.id, unavailable: !item.available }" :disabled="busy || waiting || !item.available" :aria-pressed="provider === item.id" @click="provider = item.id"><div><strong>{{ item.name }}</strong><span class="status-badge" :class="item.available ? 'green' : 'neutral'">{{ item.available ? '可以登录' : '暂不可用' }}</span></div><span class="mono">{{ item.id }}</span><small>{{ item.source === 'core' ? '内核原生登录' : `插件：${item.pluginId || '已发现插件'}` }}</small><p v-if="item.reason || item.message">{{ item.reason || item.message }}</p></button></div>
      <AppState v-else compact title="没有匹配的登录渠道" description="重新发现渠道，或在原生插件页面安装并启用所需渠道插件。" />
      <form v-if="selectedProvider" class="cpa-oauth-start" @submit.prevent="start"><div><strong>{{ selectedProvider.name }}</strong><p>{{ selectedProvider.available ? '点击开始授权，再打开授权页面完成登录。' : selectedProvider.reason || selectedProvider.message || '此渠道当前无法登录。' }}</p></div><label v-if="provider === 'kimi'" class="field"><span>Kimi 登录站点</span><select v-model="kimiDomain" :disabled="busy || waiting"><option value="kimi.com">kimi.com</option><option value="kimi.ai">kimi.ai</option></select></label><label v-if="provider === 'gemini-cli'" class="field"><span>Google Cloud 项目 ID <small>可选</small></span><input v-model="projectId" :disabled="busy || waiting" placeholder="留空由插件处理"></label><button class="button primary" :disabled="busy || waiting || !selectedProvider.available"><UIcon v-if="busy" name="i-ph-circle-notch-bold" class="spinning" />{{ waiting ? '授权进行中' : '开始授权' }}</button></form>
      <p class="panel-note">渠道核对于 {{ formatDate(capabilities.checkedAt) }} · 内核 {{ capabilities.coreVersion || '未返回版本' }}。Google Gemini CLI 等插件渠道需要安装并启用对应插件。</p>
    </template>
    <section v-if="session" class="nexus-oauth-session" role="status" aria-live="polite"><div class="panel-heading"><h3>{{ providers.find(item => item.id === sessionProvider)?.name || sessionProvider }} 授权会话</h3><span class="status-badge" :class="status === 'ok' ? 'green' : status === 'error' ? 'red' : 'amber'">{{ statusLabel }}</span></div><p v-if="session.user_code">设备授权码：<strong class="mono cpa-device-code">{{ session.user_code }}</strong></p><p v-if="deviceFlow" class="nexus-description">打开下面的授权页面，按提示输入设备码。CPA 会在后台等待设备登录完成，无需粘贴回调。</p><p v-if="expiresAt" class="muted small-text">会话到期时间：{{ formatDate(expiresAt) }}</p><p v-if="oauthError" class="inline-error" role="alert">{{ oauthError }}</p><p v-if="checkedAt" class="muted small-text">最近查询 {{ formatDate(checkedAt) }}</p><div class="inline-actions"><a v-if="browserUrl && waiting" :href="browserUrl" target="_blank" rel="noopener noreferrer" class="button primary"><UIcon name="i-ph-arrow-square-out-bold" />打开授权页面</a><button v-if="['wait', 'error', 'expired'].includes(status) && session.state" class="button" :disabled="busy" @click="cancel">取消授权</button><button v-if="status === 'error' && session.state" class="button" :disabled="busy" @click="retryPolling">重新查询结果</button><NuxtLink v-if="status === 'ok'" to="/cpa/credentials" class="button">查看已授权账号</NuxtLink></div>
      <form v-if="session.state && waiting && !deviceFlow" class="form-stack section-gap" @submit.prevent="submitCallback"><div class="form-row"><label class="field"><span>手动回调方式</span><select v-model="callbackMode" :disabled="busy"><option value="url">完整回调地址</option><option value="code">授权码 code</option></select></label><label class="field"><span>{{ callbackMode === 'url' ? '授权完成后的回调地址' : '授权页面给出的 code' }}</span><input v-model="callback" :type="callbackMode === 'url' ? 'url' : 'text'" :placeholder="callbackMode === 'url' ? '粘贴浏览器最终回调地址' : '粘贴授权码'" autocomplete="off" :disabled="busy" required></label></div><p class="small-text muted">服务器无法收到本机回调时，可以手动提交。提交后仍会查询最终授权结果。</p><div><button class="button" :disabled="busy || !callback.trim()">提交回调</button></div></form>
    </section>
  </section>
</template>
<style scoped>
.cpa-provider-search { margin-bottom: 18px; width: 100%; max-width: 440px; }.cpa-provider-search input { min-width: 0; width: 100%; }
.cpa-provider-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 11px; }
.cpa-provider-option { display: grid; gap: 7px; padding: 16px; background: #fafbf7; border: 1px solid var(--border); border-radius: 7px; text-align: left; color: var(--ink); transition: border-color .16s, background .16s; }
.cpa-provider-option.active { border-color: #889c73; background: #f0f5e9; }.cpa-provider-option:not(:disabled):hover { background: #f0f3e9; }.cpa-provider-option.unavailable { background: #fafaf8; color: var(--muted); }
.cpa-provider-option > div { display: flex; gap: 8px; justify-content: space-between; align-items: center; flex-wrap: wrap; }.cpa-provider-option strong { font-size: 14px; font-weight: 600; }.cpa-provider-option > span, .cpa-provider-option small { font-size: 11px; color: var(--muted); }.cpa-provider-option p { font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }
.cpa-oauth-start { display: flex; align-items: end; justify-content: space-between; gap: 20px; flex-wrap: wrap; padding: 21px 0 5px; }.cpa-oauth-start strong { font-size: 15px; }.cpa-oauth-start p { font-size: 12px; color: var(--muted); margin-top: 6px; }.cpa-oauth-start .field { min-width: 180px; }
.nexus-oauth-session { margin-top: 24px; }.nexus-oauth-session h3 { font-size: 15px; }.nexus-oauth-session .inline-actions { margin-top: 17px; }.cpa-device-code { font-size: 19px; margin-left: 10px; letter-spacing: .06em; }
@media (max-width: 1100px) { .cpa-provider-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 600px) { .cpa-provider-grid, .nexus-oauth-session .form-row { grid-template-columns: 1fr; }.cpa-oauth-start { align-items: start; }.cpa-oauth-start > div { width: 100%; }.cpa-provider-option { padding: 14px; }.cpa-provider-search { min-width: 0; } }
</style>
