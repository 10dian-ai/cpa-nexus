<script setup lang="ts">
import type { ModuleView } from '#shared/modules'
const route = useRoute()
const { session } = useAuth()
const { connection } = useLiveUpdates()
const mobileOpen = ref(false)
const { data: moduleData } = await useFetch<{ modules: ModuleView[] }>('/api/modules', { key: 'nexus-modules' })
const commandcodeEnabled = computed(() => moduleData.value?.modules.find(module => module.id === 'commandcode')?.enabled !== false)
const groups = computed(() => [
  { label: '平台', links: [
    { to: '/', label: '平台概览', icon: 'i-ph-squares-four-bold' },
    { to: '/modules', label: '模块管理', icon: 'i-ph-stack-bold' },
    { to: '/keys', label: 'API Key', icon: 'i-ph-key-bold' },
    { to: '/presets', label: '酒馆预设', icon: 'i-ph-sliders-horizontal-bold' },
  ] },
  { label: 'CPA 内核', links: [
    { to: '/cpa', label: '内核运行', icon: 'i-ph-cpu-bold' },
    { to: '/cpa/config', label: '内核配置', icon: 'i-ph-sliders-horizontal-bold' },
    { to: '/cpa/credentials', label: '凭证与授权', icon: 'i-ph-identification-card-bold' },
    { to: '/cpa/channels', label: '渠道与模型', icon: 'i-ph-git-branch-bold' },
    { to: '/cpa/requests', label: '上游请求检查', icon: 'i-ph-arrows-left-right-bold' },
    { to: '/cpa/logs', label: '日志与用量', icon: 'i-ph-list-bullets-bold' },
    { to: '/cpa/plugins', label: '原生插件', icon: 'i-ph-plugs-connected-bold' },
  ] },
  ...(commandcodeEnabled.value ? [{ label: 'CommandCode', links: [
    { to: '/commandcode', label: '账号池概览', icon: 'i-ph-chart-bar-bold' },
    { to: '/accounts', label: '账号管理', icon: 'i-ph-users-three-bold' },
    { to: '/official', label: '官方模型与套餐', icon: 'i-ph-book-open-bold' },
    { to: '/models', label: '模型观察', icon: 'i-ph-cube-bold' },
    { to: '/logs', label: '请求日志', icon: 'i-ph-list-bullets-bold' },
    { to: '/settings', label: '模块设置', icon: 'i-ph-sliders-horizontal-bold' },
  ] }] : []),
  ...(moduleData.value?.modules.filter(module => module.enabled && !['cpa', 'commandcode', 'platform', 'presets'].includes(module.id) && module.navigation.length).map(module => ({ label: module.name, links: module.navigation })) || []),
])
const current = computed(() => groups.value.flatMap(group => group.links).find(link => link.to === '/' || link.to === '/cpa' ? route.path === link.to : route.path.startsWith(link.to)) || groups.value[0]!.links[0]!)
watch(() => route.fullPath, () => { mobileOpen.value = false })
const { busy, run } = useApiAction()
async function logout() {
  const result = await run(() => $fetch('/api/auth/logout', { method: 'POST' }))
  if (result.ok) { session.value = { authenticated: false, username: null }; await navigateTo('/login') }
}
</script>
<template>
  <div class="app-shell nexus-shell" @keydown.esc="mobileOpen = false">
    <a href="#main-content" class="nexus-skip-link">跳至页面内容</a>
    <button v-if="mobileOpen" class="sidebar-backdrop" aria-label="关闭导航" @click="mobileOpen = false" />
    <aside class="sidebar" :class="{ 'is-open': mobileOpen }">
      <NuxtLink to="/" class="brand"><span class="brand-mark"><UIcon name="i-ph-intersect-bold" /></span><span>CPA Nexus<small>模型与模块管理平台</small></span></NuxtLink>
      <nav class="nexus-navigation" aria-label="主导航"><section v-for="group in groups" :key="group.label"><div class="nav-caption">{{ group.label }}</div><NuxtLink v-for="link in group.links" :key="link.to" :to="link.to" class="nav-link" :aria-current="current.to === link.to ? 'page' : undefined" :class="{ active: current.to === link.to }"><UIcon :name="link.icon" /><span>{{ link.label }}</span><UIcon v-if="current.to === link.to" name="i-ph-caret-right-bold" class="nav-chevron" /></NuxtLink></section></nav>
      <div class="sidebar-footer"><div class="admin-avatar"><UIcon name="i-ph-user-bold" /></div><div><strong>{{ session?.username || '管理员' }}</strong><span>最高管理员</span></div><button class="icon-button" :disabled="busy" aria-label="退出登录" title="退出登录" @click="logout"><UIcon name="i-ph-sign-out-bold" /></button></div>
    </aside>
    <div class="main-shell">
      <header class="topbar"><div class="breadcrumbs"><button class="icon-button mobile-menu" aria-label="打开导航" :aria-expanded="mobileOpen" @click="mobileOpen = true"><UIcon name="i-ph-list-bold" /></button><span class="workspace-label">管理工作台</span><UIcon name="i-ph-caret-right-bold" /><NuxtLink :to="current.to">{{ current.label }}</NuxtLink><template v-if="route.path !== current.to && current.to !== '/'"><UIcon name="i-ph-caret-right-bold" /><span>详情</span></template></div><div class="live-status" :class="{ connected: connection === 'live' }"><span class="status-dot" />{{ connection === 'live' ? '实时更新已连接' : connection === 'connecting' ? '正在连接更新' : '更新连接重试中' }}</div></header>
      <main id="main-content" class="main-content"><slot /></main>
      <footer class="workspace-footer"><span>CPA Nexus · 模块化 AI 管理平台</span><span>时间以北京时间显示</span></footer>
    </div>
  </div>
</template>
