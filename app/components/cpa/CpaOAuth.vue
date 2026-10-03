<script setup lang="ts">
interface OAuthSession { status: string; url?: string; state?: string; error?: string; flow?: string; user_code?: string; expires_in?: number }
const api = useRequestFetch()
const provider = ref('codex')
const sessionProvider = ref('')
const providers = ['codex', 'claude', 'antigravity', 'kimi', 'kimi-ai', 'xai', 'devin', 'meta']
const session = ref<OAuthSession | null>(null)
const status = ref('')
const oauthError = ref('')
const callback = ref('')
const { busy, run } = useApiAction()
let timer: ReturnType<typeof setTimeout> | undefined
let active = true
let generation = 0
function stopPolling() { if (timer) clearTimeout(timer); timer = undefined }
async function poll(id: number) {
  if (!active || id !== generation || !session.value?.state) return
  try {
    const result = await api<OAuthSession>(cpaManagementUrl('oauth/status'), { query: { state: session.value.state } })
    if (!active || id !== generation) return
    status.value = result.status; oauthError.value = result.error || ''
    if (result.status === 'wait') timer = setTimeout(() => void poll(id), 3000)
  } catch (error) { if (active && id === generation) { oauthError.value = apiErrorMessage(error); status.value = 'error' } }
}
async function start() {
  if (session.value?.state && status.value === 'wait') return
  if (session.value?.state && status.value === 'error') {
    const cancelled = await run(() => api(cpaManagementUrl('oauth/session'), { method: 'DELETE', query: { state: session.value!.state } }))
    if (!cancelled.ok) return
  }
  stopPolling(); generation++; oauthError.value = ''; callback.value = ''
  const result = await run(() => api<OAuthSession>(cpaManagementUrl('oauth/auth-url'), { query: { provider: provider.value.trim(), is_webui: true } }))
  if (result.ok) { session.value = result.value; sessionProvider.value = provider.value.trim(); status.value = result.value.status === 'ok' ? 'wait' : 'error'; oauthError.value = result.value.error || ''; if (result.value.state && status.value === 'wait') void poll(generation) }
}
async function cancel() {
  if (!session.value?.state) return
  const result = await run(() => api(cpaManagementUrl('oauth/session'), { method: 'DELETE', query: { state: session.value!.state } }))
  if (result.ok) { generation++; stopPolling(); status.value = 'cancelled' }
}
async function submitCallback() {
  if (!session.value?.state || !callback.value.trim()) return
  const result = await run(() => api(cpaManagementUrl('oauth/callback'), { method: 'POST', body: { provider: sessionProvider.value, state: session.value!.state, redirect_url: callback.value.trim() } }), '授权回调已提交')
  if (result.ok) { stopPolling(); void poll(generation) }
}
const browserUrl = computed(() => { try { const url = new URL(session.value?.url || ''); return ['http:', 'https:'].includes(url.protocol) ? url.href : '' } catch { return '' } })
onBeforeUnmount(() => { active = false; generation++; stopPolling() })
</script>
<template>
  <section class="panel"><div class="panel-heading"><h2>OAuth 授权</h2></div><p class="nexus-description">由 CPA 发起渠道登录并保存授权凭证。授权会话运行期间自动查询结果，离开页面后停止查询。</p><form class="nexus-form-line" @submit.prevent="start"><label class="field"><span>渠道标识</span><input v-model="provider" list="cpa-oauth-providers" required :disabled="busy || status === 'wait'"><datalist id="cpa-oauth-providers"><option v-for="item in providers" :key="item" :value="item" /></datalist><small>也可以填写已注册的插件 OAuth 渠道标识。</small></label><button class="button primary" :disabled="busy || !provider.trim() || status === 'wait'">开始授权</button></form>
    <div v-if="session" class="nexus-oauth-session" role="status"><span class="status-badge" :class="status === 'ok' ? 'green' : status === 'error' ? 'red' : 'amber'">{{ status === 'wait' ? '等待完成授权' : status === 'ok' ? '授权成功' : status === 'cancelled' ? '已取消' : '授权失败' }}</span><p v-if="session.user_code">设备授权码：<strong class="mono">{{ session.user_code }}</strong></p><p v-if="session.expires_in" class="muted">会话有效时间：{{ session.expires_in }} 秒（以内核返回为准）</p><p v-if="oauthError" class="inline-error">{{ oauthError }}</p><div class="inline-actions"><a v-if="browserUrl && status === 'wait'" :href="browserUrl" target="_blank" rel="noopener noreferrer" class="button primary"><UIcon name="i-ph-arrow-square-out-bold" />打开授权页面</a><button v-if="status === 'wait'" class="button" :disabled="busy" @click="cancel">取消授权</button><button v-if="status === 'error' && session.state" class="button" :disabled="busy" @click="status = 'wait'; oauthError = ''; poll(generation)">重新查询结果</button></div></div>
    <form v-if="session?.state && status === 'wait'" class="form-stack section-gap" @submit.prevent="submitCallback"><label class="field"><span>手动提交回调地址</span><input v-model="callback" type="url" placeholder="粘贴授权完成后的完整回调地址"><small>授权页面无法自动回到 CPA 时，可粘贴浏览器最终地址提交。</small></label><div><button class="button" :disabled="busy || !callback.trim()">提交回调</button></div></form>
  </section>
</template>
