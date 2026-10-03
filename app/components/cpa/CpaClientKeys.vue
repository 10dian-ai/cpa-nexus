<script setup lang="ts">
const api = useRequestFetch()
const { data, pending, error, refresh } = await useFetch<string[]>(cpaManagementUrl('config/access/api-keys'))
const keys = ref<string[]>([])
const baseline = ref<string[]>([])
const newKey = ref('')
const reveal = ref(false)
const validation = ref('')
const { busy, run } = useApiAction()
const dirty = computed(() => JSON.stringify(keys.value) !== JSON.stringify(baseline.value))
const missingNode = computed(() => error.value?.statusCode === 404 || error.value?.status === 404)
watch([data, missingNode], ([value, missing]) => {
  const incoming = missing ? [] : value
  if (!Array.isArray(incoming)) return
  if (!dirty.value) keys.value = [...incoming]
  baseline.value = [...incoming]
}, { immediate: true })
function add() {
  const value = newKey.value.trim()
  if (!value) return
  if (keys.value.includes(value)) { validation.value = '该密钥已存在。'; return }
  keys.value.push(value); newKey.value = ''; validation.value = ''
}
function generate() { newKey.value = `nexus_${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}` }
async function save() {
  const result = await run(() => api(cpaManagementUrl('config/access/api-keys'), { method: 'PUT', body: keys.value }), 'CPA 客户端密钥已保存')
  if (result.ok) { baseline.value = [...keys.value]; await refresh() }
}
</script>
<template>
  <section class="panel"><div class="panel-heading"><h2>CPA 客户端访问密钥</h2><button class="button small" :disabled="busy || pending" @click="refresh()">重新读取</button></div><p class="nexus-description">这些密钥用于通过 CPA 模型入口发起调用。编辑列表后统一保存，已移除的密钥会立即失效。</p><AppState v-if="error && !missingNode" :error="error" compact @retry="refresh()" /><AppState v-else-if="pending && !data" loading compact /><template v-else>
    <p v-if="missingNode" class="nexus-description">内核尚未配置客户端密钥。加入密钥并保存后，将创建访问密钥配置。</p>
    <form class="nexus-form-line" @submit.prevent="add"><label class="field"><span>新增密钥</span><input v-model="newKey" autocomplete="off" :type="reveal ? 'text' : 'password'" placeholder="输入或生成客户端密钥" :disabled="busy"></label><button type="button" class="button" :disabled="busy" @click="generate">生成密钥</button><button class="button" :disabled="busy || !newKey.trim()">加入列表</button></form><p v-if="validation" class="inline-error" role="alert">{{ validation }}</p><label class="nexus-inline-label"><input v-model="reveal" type="checkbox">显示完整密钥</label>
    <div v-if="keys.length" class="table-scroll section-gap"><table class="data-table"><thead><tr><th>客户端密钥</th><th>操作</th></tr></thead><tbody><tr v-for="(key, i) in keys" :key="`${i}-${key}`"><td class="mono wrap-cell">{{ reveal ? key : `${key.slice(0, 6)}${'•'.repeat(16)}${key.slice(-4)}` }}</td><td><button class="button small danger" :disabled="busy" @click="keys.splice(i, 1)">从列表移除</button></td></tr></tbody></table></div><AppState v-else compact title="尚未设置客户端密钥" description="可以生成或输入密钥后保存。" />
    <div class="nexus-editor-footer"><span class="muted small-text">{{ dirty ? '有未保存的修改' : '已读取当前密钥列表' }}</span><div class="inline-actions"><button class="button" :disabled="busy || !dirty" @click="keys = [...baseline]">还原修改</button><button class="button primary" :disabled="busy || !dirty" @click="save">保存密钥列表</button></div></div>
  </template></section>
</template>
