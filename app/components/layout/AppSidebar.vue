<script setup lang="ts">
import type { NavigationGroup, NavigationLink } from '~/composables/useAppNavigation'

const props = defineProps<{
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

/**
 * Sections can be folded. By default only the platform section and the
 * section holding the current page are open; an explicit choice by the admin
 * is remembered per browser. The current page's section is always shown so
 * the active entry never disappears.
 */
const STORAGE_KEY = 'cpa-nexus:sidebar-sections'
const choices = ref<Record<string, boolean>>({})
onMounted(() => {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) choices.value = Object.fromEntries(Object.entries(stored).filter(([, value]) => typeof value === 'boolean')) as Record<string, boolean>
  } catch { /* Storage unavailable: keep defaults. */ }
})
const activeLabel = computed(() => props.groups.find(group => group.links.some(link => link.to === props.current.to))?.label)
function expanded(group: NavigationGroup, index: number) {
  if (group.label === activeLabel.value) return true
  return choices.value[group.label] ?? index === 0
}
function toggle(group: NavigationGroup, index: number) {
  if (group.label === activeLabel.value) return
  choices.value = { ...choices.value, [group.label]: !expanded(group, index) }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(choices.value)) } catch { /* Not persisted; still toggles. */ }
}
</script>

<template>
  <button v-if="open" class="sidebar-backdrop" aria-label="关闭导航" @click="emit('close')" />
  <aside class="sidebar" :class="{ 'is-open': open }">
    <NuxtLink to="/" class="brand" @click="emit('close')">
      <span class="brand-mark"><UIcon name="i-ph-intersect-bold" /></span>
      <span>CPA Nexus<small>模型与模块管理平台</small></span>
    </NuxtLink>
    <nav class="nexus-navigation" aria-label="主导航">
      <section v-for="(group, index) in groups" :key="group.label" :class="{ 'is-collapsed': !expanded(group, index) }">
        <button
          type="button"
          class="nav-caption nav-section-toggle"
          :aria-expanded="expanded(group, index)"
          :aria-controls="`nav-section-${index}`"
          :disabled="group.label === activeLabel"
          @click="toggle(group, index)"
        >
          <span>{{ group.label }}</span>
          <span v-if="!expanded(group, index)" class="nav-section-count">{{ group.links.length }}</span>
          <UIcon :name="expanded(group, index) ? 'i-ph-caret-down-bold' : 'i-ph-caret-right-bold'" class="nav-section-caret" aria-hidden="true" />
        </button>
        <div v-show="expanded(group, index)" :id="`nav-section-${index}`">
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
        </div>
      </section>
    </nav>
    <div class="sidebar-footer">
      <div class="admin-avatar"><UIcon name="i-ph-user-bold" aria-hidden="true" /></div>
      <div><strong>{{ username || '管理员' }}</strong><span>最高管理员</span></div>
      <button class="icon-button" :disabled="busy" aria-label="退出登录" title="退出登录" @click="emit('logout')"><UIcon name="i-ph-sign-out-bold" /></button>
    </div>
  </aside>
</template>
