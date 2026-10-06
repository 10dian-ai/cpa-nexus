<script setup lang="ts">
import type { ModuleView } from '#shared/modules'
const route = useRoute()
const { session } = useAuth()
const { connection } = useLiveUpdates()
const mobileOpen = ref(false)
const { data: moduleData } = await useFetch<{ modules: ModuleView[] }>('/api/modules', { key: 'nexus-modules' })
// Discover plugin pages after hydration so a temporarily unavailable CPA does
// not block every Nexus route during server rendering.
const { data: cpaCapabilities } = await useFetch<{ plugins?: { id: string; name: string; effectiveEnabled: boolean; menus?: { path: string; name: string; description?: string }[] }[] }>('/api/cpa/capabilities', { key: 'cpa-management-capabilities', server: false })
const { groups, current } = useAppNavigation(moduleData, cpaCapabilities)
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
    <AppSidebar :groups="groups" :current="current" :open="mobileOpen" :username="session?.username" :busy="busy" @close="mobileOpen = false" @logout="logout" />
    <div class="main-shell">
      <AppTopbar :current="current" :connection="connection" :show-detail="route.path !== current.to" :menu-open="mobileOpen" @open-menu="mobileOpen = true" />
      <main id="main-content" class="main-content"><slot /></main>
      <footer class="workspace-footer"><span>CPA Nexus · 模块化 AI 管理平台</span><span>时间以北京时间显示</span></footer>
    </div>
  </div>
</template>
