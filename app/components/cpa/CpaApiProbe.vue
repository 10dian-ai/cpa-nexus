<script setup lang="ts">
const url = ref('')
const method = ref('GET')
const authIndex = ref('')
const headers = ref('{}')
const payload = ref('')
const resultData = ref<unknown>(null)
const validation = ref('')
const { busy, run } = useApiAction()
const responseStatus = computed(() => {
  if (!resultData.value || typeof resultData.value !== 'object') return null
  const status = (resultData.value as Record<string, unknown>).status_code
  return typeof status === 'number' ? status : null
})
async function send() {
  validation.value = ''
  let header: unknown
  try {
    const parsedUrl = new URL(url.value.trim())
    if (!['https:', 'http:'].includes(parsedUrl.protocol)) throw new Error()
    header = JSON.parse(headers.value)
  } catch { validation.value = '请输入完整的 HTTP 地址与有效的请求头 JSON 对象。'; return }
  if (!header || typeof header !== 'object' || Array.isArray(header) || Object.values(header).some(value => typeof value !== 'string')) {
    validation.value = '请求头必须是键和值均为字符串的 JSON 对象。'; return
  }
  const result = await run(() => $fetch(cpaManagementUrl('requests/api-call'), {
    method: 'POST',
    body: {
      method: method.value, url: url.value.trim(), header,
      ...(authIndex.value.trim() ? { auth_index: authIndex.value.trim() } : {}),
      ...(payload.value ? { data: payload.value } : {}),
    },
  }))
  if (result.ok) resultData.value = result.value
}
</script>
<template>
  <section class="panel"><div class="panel-heading"><h2>发送一次上游请求</h2><span v-if="responseStatus !== null" class="status-badge" :class="responseStatus >= 200 && responseStatus < 300 ? 'green' : responseStatus >= 400 ? 'red' : 'neutral'">上游 HTTP {{ responseStatus }}</span></div>
    <p class="nexus-description">由 CPA 发出实际 HTTP 请求。可选用已保存的凭证，请求头中的 $TOKEN$ 会替换为对应令牌。仅在点击发送时执行。</p>
    <form class="form-stack" @submit.prevent="send"><div class="form-row"><label class="field"><span>请求方法</span><select v-model="method" :disabled="busy"><option v-for="item in ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']" :key="item">{{ item }}</option></select></label><label class="field"><span>凭证 auth_index（可选）</span><input v-model="authIndex" placeholder="从凭证详情中复制" :disabled="busy"></label></div>
      <label class="field"><span>完整请求地址</span><input v-model="url" type="url" required placeholder="https://上游地址/路径" :disabled="busy"></label>
      <label class="field"><span>请求头 JSON</span><textarea v-model="headers" class="nexus-code-editor" rows="5" spellcheck="false" :disabled="busy" /><small>例如 {"Authorization":"Bearer $TOKEN$"}。未选凭证时，请按需要填写实际请求头。</small></label>
      <label class="field"><span>请求内容（可选）</span><textarea v-model="payload" class="nexus-code-editor" rows="6" spellcheck="false" :disabled="busy" /><small>内容按原始字符串发送；JSON 请求需要在请求头中设置 Content-Type。</small></label>
      <p v-if="validation" class="inline-error" role="alert">{{ validation }}</p><div><button class="button primary" :disabled="busy || !url.trim()"><UIcon v-if="busy" name="i-ph-circle-notch-bold" class="spinning" />发送一次请求</button></div>
    </form><JsonViewer v-if="resultData !== null" class="section-gap" :value="resultData" title="上游响应" />
  </section>
</template>
