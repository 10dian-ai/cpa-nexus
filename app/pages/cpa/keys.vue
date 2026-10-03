<script setup lang="ts">
useHead({ title: 'CPA 原生访问密钥 · CPA Nexus' })
</script>
<template><AppPageHeader title="CPA 原生访问密钥" description="保留 CPA 内核的原生客户端密钥管理，适用于完整原生模型接口。"><NuxtLink to="/keys" class="button">平台 API Key</NuxtLink><NuxtLink to="/cpa/native" class="button">原版完整控制台</NuxtLink></AppPageHeader><CpaGate><CpaClientKeys /></CpaGate></template>
