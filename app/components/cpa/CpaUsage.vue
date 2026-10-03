<script setup lang="ts">
const api = useRequestFetch()
const count = ref(10)
const queue = ref<unknown>(null)
const apiKeys = ref<unknown>(null)
const consume = ref(false)
const { busy, run } = useApiAction()
async function readQueue() {
  if (!consume.value || !Number.isInteger(count.value) || count.value < 1 || count.value > 1000) return
  const result = await run(() => api(cpaManagementUrl('observability/usage/queue'), { query: { count: count.value } }))
  if (result.ok) queue.value = result.value
}
async function readBuckets() {
  const result = await run(() => api(cpaManagementUrl('observability/usage/api-keys')))
  if (result.ok) apiKeys.value = result.value
}
</script>
<template>
  <div class="nexus-stack"><section class="panel"><div class="panel-heading"><h2>上游 API Key 用量</h2><button class="button small" :disabled="busy" @click="readBuckets">读取统计</button></div><p class="nexus-description">读取 CPA 进程内保存的成功与失败统计。重启内核后统计可能重置，数据需要内核启用用量聚合。</p><JsonViewer v-if="apiKeys !== null" :value="apiKeys" title="内核用量统计" /><p v-else class="nexus-empty-note">点击读取获取当前内核统计。</p></section>
    <section class="panel"><div class="panel-heading"><h2>用量事件队列</h2><span class="status-badge amber">读取会消费记录</span></div><p class="nexus-description">CPA 的队列接口会取出并移除事件。此页只在你点击时读取，返回的是这一批事件，不能用作完整历史调用总量。</p><label class="nexus-inline-label"><input v-model="consume" type="checkbox">我确认取出这一批记录，其他队列读取方将无法再取到它们</label><form class="nexus-form-line section-gap" @submit.prevent="readQueue"><label class="field"><span>本次最多取出条数</span><input v-model.number="count" type="number" min="1" max="1000" step="1" required></label><button class="button" :disabled="busy || !consume">取出事件</button></form><JsonViewer v-if="queue !== null" :value="queue" title="本次取出的用量事件" /><p v-else class="nexus-empty-note">尚未读取队列。</p></section></div>
</template>
