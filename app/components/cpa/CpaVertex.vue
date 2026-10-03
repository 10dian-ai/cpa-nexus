<script setup lang="ts">
const file = shallowRef<File | null>(null)
const location = ref('us-central1')
const resultData = ref<unknown>(null)
const validation = ref('')
const fileInput = ref<HTMLInputElement>()
const { busy, run } = useApiAction()
function selectFile(event: Event) {
  file.value = (event.target as HTMLInputElement).files?.[0] || null
  validation.value = ''
  if (file.value && !file.value.name.toLowerCase().endsWith('.json')) {
    validation.value = '请选择 JSON 服务账号文件。'; file.value = null
  }
}
async function upload() {
  if (!file.value) return
  const body = new FormData(); body.set('file', file.value)
  if (location.value.trim()) body.set('location', location.value.trim())
  const result = await run(() => $fetch(cpaManagementUrl('oauth/import'), { method: 'POST', query: { provider: 'vertex' }, body }), 'Vertex 服务账号已导入')
  if (result.ok) { resultData.value = result.value; file.value = null; if (fileInput.value) fileInput.value.value = '' }
}
</script>
<template>
  <section class="panel"><div class="panel-heading"><h2>Vertex 服务账号导入</h2><span class="status-badge neutral">provider: vertex</span></div><p class="nexus-description">选择 Google 服务账号 JSON 文件，由 CPA 导入并保存为凭证。选择文件后点击导入才会提交。</p>
    <form class="form-stack" @submit.prevent="upload"><label class="field"><span>服务账号文件</span><input ref="fileInput" type="file" accept=".json,application/json" :disabled="busy" required @change="selectFile"><small v-if="file">已选择 {{ file.name }} · {{ formatNumber(file.size) }} 字节</small><small v-else>选择文件不会自动上传。</small></label><label class="field"><span>区域 location</span><input v-model="location" placeholder="us-central1" :disabled="busy"><small>留空由 CPA 使用默认区域 us-central1。</small></label><p v-if="validation" class="inline-error" role="alert">{{ validation }}</p><div><button class="button primary" :disabled="busy || !file"><UIcon v-if="busy" name="i-ph-circle-notch-bold" class="spinning" />导入服务账号</button></div></form>
    <JsonViewer v-if="resultData !== null" class="section-gap" :value="resultData" title="CPA 导入结果" />
  </section>
</template>
