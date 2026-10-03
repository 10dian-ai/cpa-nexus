<script setup lang="ts">
useHead({ title: 'OAuth 登录 · CPA Nexus' })
async function authorized() { await refreshNuxtData('cpa-credentials') }
</script>
<template>
  <AppPageHeader title="OAuth 登录" description="登录 CPA 原生及插件渠道，管理授权回调、设备码与服务账号导入。"><NuxtLink to="/cpa/credentials" class="button"><UIcon name="i-ph-identification-card-bold" />凭证管理</NuxtLink><NuxtLink to="/cpa/plugins" class="button">管理渠道插件</NuxtLink><NuxtLink to="/cpa/native" class="button">原版完整控制台</NuxtLink></AppPageHeader>
  <CpaGate><div class="nexus-stack cpa-oauth-stack"><CpaOAuth @authorized="authorized" /><CpaVertex @imported="authorized" /><section><div class="panel-heading"><h2>已授权账号</h2><NuxtLink to="/cpa/quota" class="text-link">额度中心<UIcon name="i-ph-arrow-up-right-bold" /></NuxtLink></div><CpaCredentials /></section></div></CpaGate>
</template>
<style scoped>
.cpa-oauth-stack { grid-template-columns: minmax(0, 1fr); }.cpa-oauth-stack > * { min-width: 0; }
</style>
