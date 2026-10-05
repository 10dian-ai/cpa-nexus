<script setup lang="ts">
import { pluginMenuHref } from '~/utils/cpa-plugins'

useHead({ title: 'CPA 插件页面 · CPA Nexus' })
const route = useRoute()
const pluginId = computed(() => String(route.params.pluginId || ''))
const menuIndex = computed(() => Number.parseInt(String(route.params.menuIndex || ''), 10))
const { data, pending, error, refresh } = await useCpaCapabilities()
const plugin = computed(() => data.value?.plugins?.find(item => item.id === pluginId.value))
const menu = computed(() => Number.isInteger(menuIndex.value) && menuIndex.value >= 0 ? plugin.value?.menus?.[menuIndex.value] : undefined)
const source = computed(() => menu.value ? pluginMenuHref(pluginId.value, menu.value) : '')
const title = computed(() => menu.value?.name || plugin.value?.name || 'CPA 插件页面')
const revision = ref(0)
</script>

<template>
  <AppPageHeader :title="title" :description="menu?.description || `${plugin?.name || pluginId} 提供的原生管理页面。`">
    <NuxtLink to="/cpa/plugins" class="button"><UIcon name="i-ph-plugs-connected-bold" />插件管理</NuxtLink>
    <NuxtLink to="/cpa/native" class="button">原版完整控制台</NuxtLink>
    <button class="button" :disabled="!source" @click="revision++"><UIcon name="i-ph-arrow-clockwise-bold" />重新加载</button>
    <a v-if="source" class="button" :href="source" target="_blank" rel="noopener noreferrer">独立打开<UIcon name="i-ph-arrow-square-out-bold" /></a>
  </AppPageHeader>
  <CpaGate>
    <AppState v-if="pending && !data" loading compact />
    <AppState v-else-if="error" :error="error" compact @retry="refresh()" />
    <AppState v-else-if="!source" title="插件页面不可用" description="该插件页面尚未注册、插件未启用，或内核返回的菜单路径无效。请到插件管理检查运行状态。" />
    <iframe v-else :key="revision" :src="source" class="cpa-plugin-console" :title="title" referrerpolicy="same-origin" />
  </CpaGate>
</template>

<style scoped>
.cpa-plugin-console { width: 100%; height: max(780px, calc(100vh - 220px)); border: 1px solid var(--border); border-radius: 7px; background: #fff; }
</style>
