<script setup lang="ts">
useHead({ title: 'CPA 内核 · CPA Nexus' })
const { data, pending, error, refresh } = await useCpaStatus()
const latest = ref<string | null>(null)
const { busy, run } = useApiAction()
async function checkVersion() {
  const result = await run(() => $fetch<{ 'latest-version': string }>(cpaManagementUrl('server/latest-version')))
  if (result.ok) latest.value = result.value['latest-version']
}
const features = [
  { to: '/cpa/credentials', title: '凭证与授权', description: '导入凭证、OAuth 登录、刷新和管理账号状态。', icon: 'i-ph-identification-card-bold' },
  { to: '/cpa/channels', title: '渠道与模型', description: '配置上游渠道、模型映射、路由与重试规则。', icon: 'i-ph-git-branch-bold' },
  { to: '/cpa/keys', title: '客户端密钥', description: '管理通过 CPA 调用模型的客户端访问密钥。', icon: 'i-ph-key-bold' },
  { to: '/cpa/plugins', title: '原生插件', description: '查看内核插件、配置和官方插件商店。', icon: 'i-ph-plugs-connected-bold' },
]
</script>
<template>
  <AppPageHeader title="CPA 内核" description="统一执行模型请求，独立管理内核版本与原生能力。"><button class="button" :disabled="pending" @click="refresh()"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: pending }" />检测连接</button></AppPageHeader>
  <AppState v-if="error" :error="error" @retry="refresh()" />
  <div v-else-if="!data" class="nexus-skeleton" role="status" aria-label="正在检测 CPA"><span /><span /><span /></div>
  <template v-else>
    <div class="nexus-stat-strip"><span class="status-badge" :class="data.connected ? 'green' : data.configured ? 'amber' : 'neutral'"><span class="status-dot" />{{ data.connected ? '内核已连接' : data.configured ? '连接异常' : '尚未配置' }}</span><div><strong>{{ data.version || '版本未返回' }}</strong><p>管理接口 {{ data.apiVersion }}</p></div><div class="inline-actions"><NuxtLink v-if="data.connected" to="/cpa/config" class="button primary">管理配置</NuxtLink><button class="button" :disabled="busy || !data.connected" @click="checkVersion">检查上游版本</button></div></div>
    <div v-if="data.error" class="notice error-notice" role="alert"><UIcon name="i-ph-warning-circle-bold" /><p>{{ data.error.message }}</p></div>
    <div v-if="latest" class="notice"><UIcon name="i-ph-package-bold" /><p>上游最新版本：<strong class="mono">{{ latest }}</strong>。更换内核前请验证原生渠道和扩展模块的兼容性。</p></div>
    <div class="nexus-two-column"><section class="panel"><div class="panel-heading"><h2>原生能力</h2><span class="muted">由 CPA 执行</span></div><div class="nexus-feature-list"><NuxtLink v-for="item in features" :key="item.to" :to="item.to"><span class="nexus-feature-icon"><UIcon :name="item.icon" /></span><div><strong>{{ item.title }}</strong><p>{{ item.description }}</p></div><UIcon name="i-ph-arrow-up-right-bold" /></NuxtLink></div></section><section class="panel"><div class="panel-heading"><h2>连接信息</h2></div><dl class="nexus-definition-list"><div><dt>管理接口</dt><dd>{{ data.apiVersion }}</dd></div><div><dt>当前版本</dt><dd class="mono">{{ data.version || '内核未返回版本信息' }}</dd></div><div><dt>最近检测</dt><dd>{{ formatDate(data.checkedAt) }}</dd></div><div><dt>已确认能力</dt><dd>{{ data.capabilities.includes('configuration') ? '配置读取' : '尚未确认' }}</dd></div></dl><p class="panel-note">页面功能直接读取内核返回的数据。新版本的配置差异由适配层集中处理。</p></section></div>
    <section v-if="!data.connected" class="panel nexus-compact-panel"><div class="panel-heading"><h2>配置连接</h2></div><p class="nexus-description">在平台部署环境中设置内核地址与管理密钥，重启平台服务后重新检测。使用部署文件中的内部服务地址；CPA 的管理访问需要已启用。</p><pre class="nexus-connect-instructions">CPA_URL=http://cpa:8317
CPA_MANAGEMENT_KEY=你的CPA管理密钥</pre><p class="panel-note">具体部署步骤与固定内核版本见项目部署说明。管理密钥保存在服务端，不会传给浏览器。</p></section>
  </template>
</template>
