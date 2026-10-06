<script setup lang="ts">
import type { NavigationLink } from '~/composables/useAppNavigation'

defineProps<{
  current: NavigationLink
  connection: 'connecting' | 'live' | 'reconnecting'
  showDetail?: boolean
  menuOpen?: boolean
}>()

const emit = defineEmits<{ openMenu: [] }>()
</script>

<template>
  <header class="topbar">
    <div class="breadcrumbs">
      <button class="icon-button mobile-menu" aria-label="打开导航" :aria-expanded="menuOpen" @click="emit('openMenu')"><UIcon name="i-ph-list-bold" /></button>
      <span class="workspace-label">管理工作台</span>
      <UIcon name="i-ph-caret-right-bold" aria-hidden="true" />
      <NuxtLink :to="current.to">{{ current.label }}</NuxtLink>
      <template v-if="showDetail && current.to !== '/'">
        <UIcon name="i-ph-caret-right-bold" aria-hidden="true" />
        <span>详情</span>
      </template>
    </div>
    <div class="live-status" :class="{ connected: connection === 'live' }">
      <span class="status-dot" />
      {{ connection === 'live' ? '实时更新已连接' : connection === 'connecting' ? '正在连接更新' : '更新连接重试中' }}
    </div>
  </header>
</template>
