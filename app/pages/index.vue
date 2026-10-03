<script setup lang="ts">
import type { ModuleView } from '#shared/modules'
import type { CpaStatus } from '#shared/cpa'
useHead({ title: '平台概览 · CPA Nexus' })
const { data: modules, pending, error, refresh } = await useFetch<{ modules: ModuleView[] }>('/api/modules', { key: 'nexus-modules' })
const { data: cpa, refresh: refreshCpa } = await useFetch<CpaStatus>('/api/cpa/status', { key: 'nexus-cpa-status' })
const enabled = computed(() => modules.value?.modules.filter(module => module.enabled) || [])
const extensions = computed(() => modules.value?.modules.filter(module => module.kind === 'extension') || [])
const labels = { ready: '可访问', unconfigured: '待配置', unavailable: '不可访问', disabled: '已停用' }
async function reload() { await Promise.all([refresh(), refreshCpa()]) }
</script>
<template>
  <AppPageHeader title="平台概览" description="统一管理 CPA 核心与扩展模块。"><button class="button" :disabled="pending" @click="reload"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: pending }" />刷新状态</button><NuxtLink to="/modules" class="button primary">管理模块<UIcon name="i-ph-arrow-right-bold" /></NuxtLink></AppPageHeader>
  <AppState v-if="error" :error="error" @retry="reload" />
  <AppState v-else-if="!modules" :loading="pending" />
  <template v-else>
    <section class="panel nexus-overview-core" aria-labelledby="kernel-title">
      <div class="panel-heading"><div><span class="eyebrow">CPA Nexus</span><h2 id="kernel-title">模型调用由 CPA 统一处理</h2></div><StatusBadge :status="cpa?.connected ? 'ready' : 'sync_error'" :label="cpa?.connected ? '核心已连接' : cpa?.configured ? '核心不可访问' : '核心待配置'" /></div>
      <p class="muted">保留 CPA 原生渠道与协议。每个扩展模块维护自己的账号、额度与任务，面板集中管理它们的状态。</p>
      <dl class="summary-rows"><div><dt>正在运行的 CPA 版本</dt><dd class="mono small-value">{{ cpa?.version || '尚未获取' }}</dd></div><div><dt>已启用模块</dt><dd>{{ enabled.length }} / {{ modules.modules.length }}</dd></div><div><dt>管理接口检查时间</dt><dd class="small-value">{{ formatDate(cpa?.checkedAt) }}</dd></div></dl>
      <div class="nexus-overview-actions"><NuxtLink to="/cpa" class="button primary">打开 CPA 控制台<UIcon name="i-ph-arrow-up-right-bold" /></NuxtLink><NuxtLink to="/cpa/config" class="button">配置核心</NuxtLink></div>
      <p v-if="cpa?.error" class="panel-note">{{ cpa.error.message }}</p>
    </section>
    <section class="nexus-overview-modules" aria-labelledby="extensions-title">
      <div class="panel-heading"><h2 id="extensions-title">扩展模块</h2><NuxtLink to="/modules" class="text-link">查看全部模块<UIcon name="i-ph-arrow-right-bold" /></NuxtLink></div>
      <article v-for="module in extensions" :key="module.id" class="panel nexus-module-row">
        <div><h3>{{ module.name }}</h3><p class="muted">{{ module.description }}</p><div class="nexus-capability-list"><span v-for="capability in module.capabilities" :key="capability">{{ capability }}</span></div></div>
        <div class="nexus-module-row-actions"><StatusBadge :status="module.status === 'ready' ? 'ready' : module.status === 'disabled' ? 'disabled' : 'sync_error'" :label="labels[module.status]" /><NuxtLink :to="module.navigation[0]?.to || '/modules'" class="button">打开模块<UIcon name="i-ph-arrow-right-bold" /></NuxtLink></div>
      </article>
    </section>
    <section class="panel"><div class="panel-heading"><h2>开始使用</h2></div><ol class="nexus-start-list"><li><NuxtLink to="/cpa">确认 CPA 核心连接</NuxtLink><span>初始化独立配置，检查当前运行版本与服务状态。</span></li><li><NuxtLink to="/cpa/credentials">接入原生渠道</NuxtLink><span>导入凭证或完成 OAuth 登录，配置实际可用的上游。</span></li><li><NuxtLink to="/modules">连接 CommandCode 模块</NuxtLink><span>在模块管理中注册渠道，客户端使用 commandcode/ 开头的模型名称。</span></li><li><NuxtLink to="/keys">创建 API Key</NuxtLink><span>为模型密钥选择绑定模块，客户端统一使用 /v1 入口。</span></li></ol></section>
  </template>
</template>
