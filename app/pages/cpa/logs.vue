<script setup lang="ts">
useHead({ title: '日志与用量 · CPA Nexus' })
const tab = ref('logs')
</script>
<template><AppPageHeader title="日志与用量" description="查看 CPA 原生日志和进程内用量，观测配置直接保存在内核。" /><CpaGate><div class="nexus-tabs" role="tablist" aria-label="内核观测"><button v-for="item in [{ id: 'logs', label: '日志' }, { id: 'usage', label: '用量' }, { id: 'config', label: '观测配置' }]" :key="item.id" role="tab" :aria-selected="tab === item.id" @click="tab = item.id">{{ item.label }}</button></div><CpaLogs v-if="tab === 'logs'" /><CpaUsage v-else-if="tab === 'usage'" /><template v-else><CpaObservabilitySettings /><CpaResourceEditor path="config/observability" title="日志与用量配置" description="配置文件日志、请求日志、保留大小和用量聚合。修改后由内核处理。" writable allow-create /></template></CpaGate></template>
