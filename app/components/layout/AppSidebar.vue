<script setup lang="ts">
import type { NavigationGroup, NavigationLink } from '~/composables/useAppNavigation'

defineProps<{
  groups: NavigationGroup[]
  current: NavigationLink
  username?: string | null
  open?: boolean
  busy?: boolean
}>()

const emit = defineEmits<{
  close: []
  logout: []
}>()
</script>

<template>
  <button v-if="open" class="sidebar-backdrop" aria-label="关闭导航" @click="emit('close')" />
  <aside class="sidebar" :class="{ 'is-open': open }">
    <NuxtLink to="/" class="brand" @click="emit('close')">
      <span class="brand-mark"><UIcon name="i-ph-intersect-bold" /></span>
      <span>CPA Nexus<small>模型与模块管理平台</small></span>
    </NuxtLink>
    <nav class="nexus-navigation" aria-label="主导航">
      <section v-for="group in groups" :key="group.label">
        <div class="nav-caption">{{ group.label }}</div>
        <NuxtLink
          v-for="link in group.links"
          :key="link.to"
          :to="link.to"
          class="nav-link"
          :aria-current="current.to === link.to ? 'page' : undefined"
          :class="{ active: current.to === link.to }"
          :title="link.description"
          @click="emit('close')"
        >
          <UIcon :name="link.icon" aria-hidden="true" />
          <span>{{ link.label }}</span>
          <UIcon v-if="current.to === link.to" name="i-ph-caret-right-bold" class="nav-chevron" aria-hidden="true" />
        </NuxtLink>
      </section>
    </nav>
    <div class="sidebar-footer">
      <div class="admin-avatar"><UIcon name="i-ph-user-bold" aria-hidden="true" /></div>
      <div><strong>{{ username || '管理员' }}</strong><span>最高管理员</span></div>
      <button class="icon-button" :disabled="busy" aria-label="退出登录" title="退出登录" @click="emit('logout')"><UIcon name="i-ph-sign-out-bold" /></button>
    </div>
  </aside>
</template>

