<script setup lang="ts">
useHead({ title: '渠道与模型 · CPA Nexus' })
const tab = ref('providers')
const channel = ref('codex')
const modelData = ref<unknown>(null)
const { busy, run } = useApiAction()
async function readModels() {
  if (!channel.value.trim()) return
  const result = await run(() => $fetch(cpaManagementUrl(`routing/model-definitions/${encodeURIComponent(channel.value.trim())}`)))
  if (result.ok) modelData.value = result.value
}
</script>
<template>
  <AppPageHeader title="渠道与模型" description="配置 CPA 上游渠道、调度行为和模型映射。" />
  <CpaGate><div class="nexus-tabs" role="tablist" aria-label="渠道设置"><button v-for="item in [{ id: 'providers', label: 'API 渠道' }, { id: 'routing', label: '路由与重试' }, { id: 'aliases', label: 'OAuth 模型映射' }, { id: 'catalog', label: '模型定义' }]" :key="item.id" role="tab" :aria-selected="tab === item.id" @click="tab = item.id">{{ item.label }}</button></div>
    <CpaResourceEditor v-if="tab === 'providers'" key="providers" path="config/api-keys" title="上游渠道配置" description="每个渠道保存一组或多组上游配置，组内包括名称、服务地址、密钥和模型。新增渠道可在这里添加；客户端访问密钥在独立页面管理。" writable allow-create />
    <CpaResourceEditor v-else-if="tab === 'routing'" key="routing" path="config/routing" title="路由配置" description="管理选号策略、会话亲和、重试和冷却规则。修改规则后由 CPA 执行。" writable allow-create />
    <CpaResourceEditor v-else-if="tab === 'aliases'" key="oauth" path="config/oauth" title="OAuth 模型映射与排除规则" description="model-alias、excluded-models 和 providers 配置均来自当前内核。别名配置与 API 渠道中的模型配置分别生效。" writable allow-create />
    <section v-else class="panel"><div class="panel-heading"><h2>渠道模型定义</h2></div><p class="nexus-description">读取 CPA 随内核提供的静态模型定义。此数据描述模型能力，不代表账号已获得调用权限。</p><form class="nexus-form-line" @submit.prevent="readModels"><label class="field"><span>渠道标识</span><input v-model="channel" placeholder="codex" required></label><button class="button" :disabled="busy || !channel.trim()">读取定义</button></form><JsonViewer v-if="modelData" :value="modelData" title="内核模型定义" /><p v-else class="nexus-empty-note">选择渠道并读取模型定义。</p></section>
  </CpaGate>
</template>
