<script setup lang="ts">
useHead({ title: '原生插件 · CPA Nexus' })
const tab = ref('installed')
</script>
<template><AppPageHeader title="原生插件" description="管理 CPA 内核插件与商店，平台业务模块在模块管理中维护。" /><CpaGate><div class="nexus-tabs" role="tablist" aria-label="插件管理"><button v-for="item in [{ id: 'installed', label: '本地插件' }, { id: 'store', label: '插件商店' }, { id: 'config', label: '插件全局配置' }]" :key="item.id" role="tab" :aria-selected="tab === item.id" @click="tab = item.id">{{ item.label }}</button></div><CpaPlugins v-if="tab === 'installed'" /><CpaPluginStore v-else-if="tab === 'store'" /><CpaResourceEditor v-else path="config/plugins" title="插件全局配置" description="配置插件目录、总开关、商店源和插件配置，保留内核管理的只读版本字段。" writable /></CpaGate></template>
