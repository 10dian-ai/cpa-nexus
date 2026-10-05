<script setup lang="ts">
useHead({ title: 'CPA 原版完整控制台 · CPA Nexus' })
const revision = ref(0)
const section = ref('/dashboard')
const sections = [
  { id: '/dashboard', name: '运行总览' },
  { id: '/quick-start', name: '快速开始' },
  { id: '/ai-providers', name: 'AI 提供商' },
  { id: '/auth-files', name: '认证文件' },
  { id: '/oauth', name: 'OAuth 登录' },
  { id: '/quota', name: '配额管理' },
  { id: '/logs', name: '日志查看' },
  { id: '/config', name: '配置面板' },
  { id: '/plugins', name: '插件管理' },
  { id: '/plugin-store', name: '插件商店' },
  { id: '/system', name: '中心信息' },
]
const source = computed(() => `/api/cpa/native-panel?revision=${revision.value}#${section.value}`)
</script>
<template>
  <AppPageHeader title="CPA 原版完整控制台" description="保留官方管理面板的完整功能，通过当前管理员登录直接使用。"><button class="button" @click="revision++"><UIcon name="i-ph-arrow-clockwise-bold" />重新加载</button><a class="button" :href="source" target="_blank" rel="noopener noreferrer">独立打开<UIcon name="i-ph-arrow-square-out-bold" /></a></AppPageHeader>
  <CpaGate><p class="panel-note">OAuth、供应商配额、原生密钥、插件页面和高级配置均由官方 CPA 控制台提供。管理密钥由服务器处理，无需重复输入。</p><div class="nexus-tabs" role="tablist" aria-label="原版控制台入口"><button v-for="item in sections" :key="item.id" role="tab" :aria-selected="section === item.id" @click="section = item.id">{{ item.name }}</button></div><iframe :key="revision" :src="source" class="cpa-native-console" title="CPA 官方原版管理控制台" referrerpolicy="same-origin" /></CpaGate>
</template>
<style scoped>
.cpa-native-console { width: 100%; height: max(780px, calc(100vh - 220px)); border: 1px solid var(--border); border-radius: 7px; background: #fff; }
</style>
