<script setup lang="ts">
useHead({ title: '内核配置 · CPA Nexus' })
const tab = ref('json')
const node = ref('routing')
const selectedNode = ref('routing')
const validNode = computed(() => /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(node.value.trim()) && !node.value.includes('..'))
</script>
<template>
  <AppPageHeader title="内核配置" description="读取和修改 CPA 当前配置，保存后由内核验证并热加载。" />
  <CpaGate><div class="nexus-tabs" role="tablist" aria-label="配置视图"><button v-for="item in [{ id: 'json', label: '完整 JSON' }, { id: 'node', label: '指定配置节点' }, { id: 'yaml', label: '原始 YAML' }]" :key="item.id" role="tab" :aria-selected="tab === item.id" @click="tab = item.id">{{ item.label }}</button></div>
    <CpaResourceEditor v-if="tab === 'json'" key="full-config" path="config" title="完整配置" description="编辑当前 v8 配置。合并对象保留未提交的字段，列表会整组替换。内核管理的只读字段应保留原值。" writable />
    <template v-else-if="tab === 'node'"><form class="nexus-form-line" @submit.prevent="validNode && (selectedNode = node.trim())"><label class="field"><span>配置路径</span><input v-model="node" placeholder="routing/retry" required pattern="[a-zA-Z0-9_./-]+"><small>按配置映射层级读取，例如 routing、requests/streaming、oauth/providers/codex。列表需要整组编辑。</small></label><button class="button" :disabled="!validNode">读取节点</button></form><CpaResourceEditor :key="selectedNode" :path="`config/${selectedNode}`" :title="selectedNode" writable allow-create deletable /></template>
    <CpaResourceEditor v-else key="yaml-config" path="config.yaml" title="YAML 配置" description="保存将替换完整配置文件。请保留仍需使用的字段与凭证，并检查内核校验结果。" format="text" writable replace-only />
  </CpaGate>
</template>
