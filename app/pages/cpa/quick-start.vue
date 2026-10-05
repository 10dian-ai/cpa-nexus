<script setup lang="ts">
useHead({ title: '快速开始 · CPA Nexus' })
const revision = ref(0)
const source = computed(() => `/api/cpa/native-panel?revision=${revision.value}#/quick-start`)
</script>

<template>
  <AppPageHeader title="快速开始" description="使用官方 CPA 快速配置向导完成首个 API 提供商接入，所有请求仍由当前管理员会话代理。">
    <button class="button" @click="revision++"><UIcon name="i-ph-arrow-clockwise-bold" />重新加载</button>
    <NuxtLink to="/cpa/channels" class="button">渠道与模型</NuxtLink>
    <NuxtLink to="/cpa/native" class="button">原版完整控制台</NuxtLink>
  </AppPageHeader>
  <CpaGate><p class="panel-note">快速开始使用官方向导处理固定提供商字段；需要完整 provider 分组、模型别名和路由规则时，请进入渠道与模型页面。</p><iframe :key="revision" :src="source" class="cpa-quick-start" title="CPA 官方快速开始" referrerpolicy="same-origin" /></CpaGate>
</template>

<style scoped>
.cpa-quick-start { width: 100%; height: max(780px, calc(100vh - 220px)); border: 1px solid var(--border); border-radius: 7px; background: #fff; }
</style>
