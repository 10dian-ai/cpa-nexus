<script setup lang="ts">
useHead({ title: '原生插件 · CPA Nexus' })
const route = useRoute()
const tab = ref(['installed', 'store', 'config'].includes(String(route.query.tab)) ? String(route.query.tab) : 'installed')
watch(() => route.query.tab, value => { if (['installed', 'store', 'config'].includes(String(value))) tab.value = String(value) })
async function selectTab(id: string) { tab.value = id; await navigateTo({ path: '/cpa/plugins', query: { tab: id } }) }
</script>
<template><AppPageHeader title="原生插件" description="接入 CPA 全部商店来源与插件类型，管理安装、更新、配置、登录、配额和插件自带页面。"><NuxtLink to="/cpa/oauth" class="button">OAuth 登录</NuxtLink><NuxtLink to="/cpa/quota" class="button">额度中心</NuxtLink><NuxtLink to="/cpa/native" class="button">原版完整控制台</NuxtLink></AppPageHeader><CpaGate><div class="nexus-tabs" role="tablist" aria-label="插件管理"><button v-for="item in [{ id: 'installed', label: '本地插件' }, { id: 'store', label: '插件商店' }, { id: 'config', label: '插件全局配置' }]" :key="item.id" role="tab" :aria-selected="tab === item.id" @click="selectTab(item.id)">{{ item.label }}</button></div><CpaPlugins v-if="tab === 'installed'" /><CpaPluginStore v-else-if="tab === 'store'" /><CpaResourceEditor v-else path="config/plugins" title="插件全局配置" description="配置插件目录、总开关、全部商店来源和商店认证。字段由 CPA 内核校验，保留已安装插件及原生版本记录。" writable /></CpaGate></template>
