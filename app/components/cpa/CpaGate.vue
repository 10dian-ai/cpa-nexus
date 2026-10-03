<script setup lang="ts">
const { data, pending, error, refresh } = await useCpaStatus()
</script>
<template>
  <AppState v-if="error" :error="error" @retry="refresh()" />
  <div v-else-if="pending && !data" class="nexus-skeleton" aria-label="正在读取内核状态" role="status"><span /><span /><span /></div>
  <section v-else-if="!data?.connected" class="panel nexus-connect-state">
    <span class="nexus-feature-icon"><UIcon name="i-ph-cpu-bold" /></span>
    <h2>{{ data?.configured ? 'CPA 内核暂时无法连接' : '连接你的 CPA 内核' }}</h2>
    <p>{{ data?.error?.message || '配置 CPA 内核管理地址和管理密钥后，即可在这里管理原生功能。管理密钥由平台服务端保存。' }}</p>
    <div class="inline-actions"><NuxtLink to="/cpa" class="button primary">查看连接说明</NuxtLink><button class="button" :disabled="pending" @click="refresh()">重新检测</button></div>
  </section>
  <slot v-else />
</template>
