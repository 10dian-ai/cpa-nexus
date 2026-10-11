<script setup lang="ts">
import type { GroupListView } from '#shared/groups'
import type { NexusRouteRecord } from '#shared/usage'

/** How CPAN routed one request: serving group, strategy, credential, presets and skipped sources. */
const props = defineProps<{ route: NexusRouteRecord }>()
const { data: groups } = await useFetch<GroupListView>('/api/groups', { key: 'nexus-routing-groups' })
const groupName = (id?: string) => (id && groups.value?.items.find(group => group.id === id)?.name) || (id ? '已删除的分组' : '—')
const STRATEGY: Record<string, string> = { failover: '自动切换', mixed: '混合轮换' }
const DEVIN_SOURCE: Record<string, string> = { model: '模型名后缀', request: '请求参数', default: '默认档位' }
const rows = computed(() => {
  const route = props.route
  const items: Array<[string, string]> = [['处理分组', groupName(route.groupId)]]
  if ((route.groupIds?.length || 0) > 1) items.push(['可用分组', route.groupIds!.map(groupName).join('、') + '（' + (STRATEGY[route.strategy || ''] || route.strategy || '—') + '）'])
  if (route.nativeModel) items.push(['实际模型', route.nativeModel])
  if (route.authIndex) items.push(['CPA 凭证', route.authIndex])
  items.push(['酒馆预设', route.presetIds?.length ? `叠加 ${route.presetIds.length} 个` : '未叠加'])
  if (route.devin?.level) items.push(['Devin 思考档位', `${route.devin.level}（来自${DEVIN_SOURCE[route.devin.source || ''] || route.devin.source}）`])
  if (route.devin?.removed?.length) items.push(['已移除参数', route.devin.removed.join('、')])
  return items
})
</script>

<template>
  <section class="panel section-gap route-summary">
    <div class="panel-heading"><h2>调用路径</h2></div>
    <dl class="route-fields"><div v-for="[label, value] in rows" :key="label"><dt>{{ label }}</dt><dd>{{ value }}</dd></div></dl>
    <div v-if="route.failover?.length" class="route-failover">
      <h3>切换记录</h3>
      <ol>
        <li v-for="(item, index) in route.failover" :key="index">
          <strong>{{ groupName(item.groupId) }}</strong><span class="muted">{{ item.kind === 'commandcode' ? 'CommandCode' : item.model || 'CPA' }} · HTTP {{ item.status ?? '—' }}</span>
          <p>{{ item.error }}</p>
        </li>
      </ol>
    </div>
  </section>
</template>

<style scoped>
.route-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 14px 24px; margin: 0; }
.route-fields div { min-width: 0; }
.route-fields dt { color: var(--muted); font-size: 14px; margin-bottom: 4px; }
.route-fields dd { margin: 0; overflow-wrap: anywhere; }
.route-failover { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); }
.route-failover h3 { margin-bottom: 10px; }
.route-failover ol { margin: 0; padding-left: 20px; display: grid; gap: 10px; }
.route-failover li span { margin-left: 8px; font-size: 14px; }
.route-failover p { margin-top: 2px; color: var(--muted); font-size: 14px; overflow-wrap: anywhere; }
</style>
