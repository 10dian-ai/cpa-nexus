<script setup lang="ts">
useHead({ title: '额度中心 · CPA Nexus' })
</script>
<template>
  <AppPageHeader title="额度中心" description="查看 CPA 账号的额度观察，按需查询官方配额、窗口与重置时间。"><NuxtLink to="/cpa/credentials" class="button">凭证管理</NuxtLink><NuxtLink to="/cpa/native" class="button">原版完整控制台</NuxtLink></AppPageHeader>
  <CpaGate><CpaQuota /></CpaGate>
</template>