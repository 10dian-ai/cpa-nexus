<script setup lang="ts">
import type { GatewayKeyView } from '#shared/types'
import type { ModuleView } from '#shared/modules'
import type { RoutingGroupView } from '#shared/groups'
import { INTAKE_MODULE_IDS, type IntakeModuleId } from '#shared/intake'

type KeyKind = 'gateway' | 'service'
interface ManagedKey extends GatewayKeyView { kind: KeyKind; moduleIds?: IntakeModuleId[] }

const api = useRequestFetch()
const [gateway, service, modules, routingGroups] = await Promise.all([
  useFetch<{ items: GatewayKeyView[] }>('/api/keys'),
  useFetch<{ items: (GatewayKeyView & { moduleIds?: IntakeModuleId[] })[] }>('/api/service-keys'),
  useFetch<{ modules: ModuleView[] }>('/api/modules', { key: 'nexus-modules' }),
  useFetch<{ items: RoutingGroupView[]; defaultGroupId: string; defaultGroupIds?: string[]; moduleDefaultGroupIds?: Record<string, string> }>('/api/groups', { key: 'nexus-routing-groups' }),
])
/** Modules an external service key can add accounts to: the CPA kernel and every pool module. */
const intakeModules = computed(() => INTAKE_MODULE_IDS.map(id => ({ id, name: modules.data.value?.modules.find(module => module.id === id)?.name || id,
  enabled: modules.data.value?.modules.find(module => module.id === id)?.enabled !== false })))
function moduleName(id: string) { return intakeModules.value.find(module => module.id === id)?.name || id }
const pending = computed(() => gateway.pending.value || service.pending.value || modules.pending.value)
const loaded = computed(() => !!gateway.data.value || !!service.data.value)
const items = computed<ManagedKey[]>(() => [
  ...(gateway.data.value?.items || []).map(key => ({ ...key, kind: 'gateway' as const })),
  ...(service.data.value?.items || []).map(key => ({ ...key, kind: 'service' as const })),
].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
const filter = ref<'all' | KeyKind>('all')
const visibleItems = computed(() => items.value.filter(key => filter.value === 'all' || key.kind === filter.value))
async function refreshKeys() { await Promise.all([gateway.refresh(), service.refresh(), routingGroups.refresh()]) }
async function refresh() { await Promise.all([refreshKeys(), modules.refresh()]) }
useLiveRefresh(refreshKeys)

const createOpen = ref(false)
const createKind = ref<KeyKind>('gateway')
const keyName = ref('')
type GroupStrategy = 'failover' | 'mixed'
const createStrategy = ref<GroupStrategy>('failover')
const createGroupIds = ref<string[]>([])
const createModuleIds = ref<IntakeModuleId[]>([...INTAKE_MODULE_IDS])
const canCreate = computed(() => !!keyName.value.trim() && !modules.pending.value && !modules.error.value && (createKind.value === 'service' ? createModuleIds.value.length > 0 : !!routingGroups.data.value && !routingGroups.error.value && createGroupIds.value.length > 0))
const editTarget = ref<ManagedKey | null>(null)
const editName = ref('')
const editStrategy = ref<GroupStrategy>('failover')
const editGroupIds = ref<string[]>([])
const editModuleIds = ref<IntakeModuleId[]>([])
const editOpen = computed({ get: () => !!editTarget.value, set: value => { if (!value) editTarget.value = null } })
const canEdit = computed(() => !!editName.value.trim() && (editTarget.value?.kind === 'service' ? editModuleIds.value.length > 0 : (!!routingGroups.data.value && !routingGroups.error.value && editGroupIds.value.length > 0)))
const createdKey = ref('')
const createdKind = ref<KeyKind>('gateway')
const createdGroups = ref('')
const secretOpen = computed({ get: () => !!createdKey.value, set: value => { if (!value) createdKey.value = '' } })
const revokeTarget = ref<ManagedKey | null>(null)
const revokeOpen = computed({ get: () => !!revokeTarget.value, set: value => { if (!value) revokeTarget.value = null } })
const { busy, run } = useApiAction()
const toast = useToast()

function endpoint(kind: KeyKind) { return kind === 'service' ? '/api/service-keys' : '/api/keys' }
function kindLabel(kind: KeyKind) { return kind === 'service' ? '外调服务 API Key' : '模型 API Key' }
function serviceModules(key: ManagedKey) { return (key.moduleIds || []).map(moduleName).join('、') || '—' }
const STRATEGY_LABELS: Record<GroupStrategy, string> = { failover: '自动切换', mixed: '混合轮换' }
function strategyLabel(key: ManagedKey) { return STRATEGY_LABELS[key.groupStrategy === 'mixed' ? 'mixed' : 'failover'] }
function groupNames(key: ManagedKey) {
  const ids = key.groupIds || []
  return ids.map((id, index) => routingGroups.data.value?.items.find(group => group.id === id)?.name || key.groupNames?.[index] || '未读取分组').join('、') || '默认分组'
}
/** New model keys default to every source module's group (CPA, then Logicc …). */
function modelDefaultGroupIds() {
  const value = routingGroups.data.value
  if (!value) return []
  const defaults = value.moduleDefaultGroupIds
  if (defaults) return [...new Set(['cpa', 'logicc', ...Object.keys(defaults)].map(id => defaults[id]).filter((id): id is string => !!id))]
  return value.defaultGroupIds || [value.defaultGroupId]
}

function startCreate() {
  keyName.value = ''
  createKind.value = 'gateway'
  createStrategy.value = 'failover'
  createGroupIds.value = modelDefaultGroupIds()
  createModuleIds.value = [...INTAKE_MODULE_IDS]
  createOpen.value = true
}
async function createKey() {
  if (!canCreate.value) return
  const kind = createKind.value
  const result = await run(() => api<{ key: string; item: GatewayKeyView }>(endpoint(kind), {
    method: 'POST', body: { name: keyName.value.trim(), ...(kind === 'gateway' ? { groupStrategy: createStrategy.value, groupIds: [...createGroupIds.value] } : { moduleIds: [...createModuleIds.value] }) },
  }))
  if (result.ok) {
    createOpen.value = false
    createdKind.value = kind
    createdGroups.value = groupNames({ ...result.value.item, kind })
    createdKey.value = result.value.key
    await refreshKeys()
  }
}
function startEdit(key: ManagedKey) {
  editName.value = key.name
  editStrategy.value = key.groupStrategy === 'mixed' ? 'mixed' : 'failover'
  editGroupIds.value = [...(key.groupIds || modelDefaultGroupIds())]
  editModuleIds.value = [...(key.moduleIds || [])]
  editTarget.value = key
}
async function saveKey() {
  const target = editTarget.value
  if (!target || !canEdit.value) return
  const result = await run(() => api(endpoint(target.kind) + '/' + target.id, {
    method: 'PATCH', body: {
      name: editName.value.trim(),
      ...(target.kind === 'gateway' ? { groupStrategy: editStrategy.value, groupIds: [...editGroupIds.value] } : { moduleIds: [...editModuleIds.value] }),
    },
  }), '密钥设置已保存')
  if (result.ok) { editTarget.value = null; await refreshKeys() }
}
async function toggle(key: ManagedKey) {
  const result = await run(() => api(endpoint(key.kind) + '/' + key.id, {
    method: 'PATCH', body: { enabled: !key.enabled },
  }), key.enabled ? '密钥已停用' : '密钥已启用')
  if (result.ok) await refreshKeys()
}
async function revoke() {
  const target = revokeTarget.value
  if (!target) return
  const result = await run(() => api(endpoint(target.kind) + '/' + target.id, { method: 'DELETE' }), '密钥已撤销')
  if (result.ok) { revokeTarget.value = null; await refreshKeys() }
}
async function copyKey() {
  try {
    await navigator.clipboard.writeText(createdKey.value)
    toast.add({ title: '密钥已复制', icon: 'i-ph-check-bold' })
  } catch {
    toast.add({ title: '无法访问剪贴板，请手动复制密钥', color: 'error', icon: 'i-ph-warning-bold' })
  }
}
</script>

<template>
  <section class="table-panel">
    <div class="table-toolbar">
      <div><h2>调用密钥</h2><p class="small-text muted">模型密钥按分组顺序选择来源，每个分组使用自己的酒馆预设；外调服务密钥用于远程给各模块加号（外调 API 与公网加号页面）。</p></div>
      <div class="inline-actions toolbar-meta">
        <select v-model="filter" aria-label="按密钥类型筛选"><option value="all">全部类型</option><option value="gateway">模型 API Key</option><option value="service">外调服务 API Key</option></select>
        <button class="button" :disabled="pending" @click="refresh()"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: pending }" />刷新</button>
        <button class="button primary" :disabled="busy || modules.pending.value || !!modules.error.value" @click="startCreate"><UIcon name="i-ph-plus-bold" />创建 API Key</button>
      </div>
    </div>
    <AppState v-if="modules.error.value" :error="modules.error.value" compact title="无法读取模块状态" @retry="modules.refresh()" />
    <AppState v-if="gateway.error.value" :error="gateway.error.value" compact title="模型密钥读取失败" @retry="gateway.refresh()" />
    <AppState v-if="service.error.value" :error="service.error.value" compact title="外调服务密钥读取失败" @retry="service.refresh()" />
    <AppState v-if="routingGroups.error.value" :error="routingGroups.error.value" compact title="调用分组读取失败" @retry="routingGroups.refresh()" />
    <AppState v-if="!loaded && pending" loading />
    <AppState v-else-if="loaded && !visibleItems.length" icon="i-ph-key-bold" :title="filter === 'all' ? '还没有 API Key' : '没有此类型的密钥'" description="创建模型 API Key 并选择调用分组，即可配置到模型客户端。">
      <button class="button primary" :disabled="busy || modules.pending.value || !!modules.error.value" @click="startCreate">创建 API Key</button>
    </AppState>
    <div v-else-if="visibleItems.length" class="table-scroll">
      <table class="data-table">
        <thead><tr><th>名称 / 密钥标识</th><th>类型</th><th>调用分组 / 加号模块</th><th>多分组策略</th><th>状态</th><th>创建时间</th><th>最近使用</th><th class="align-right">操作</th></tr></thead>
        <tbody>
          <tr v-for="key in visibleItems" :key="key.kind + ':' + key.id">
            <td><strong>{{ key.name }}</strong><div class="cell-secondary mono">{{ key.prefix }}…</div></td>
            <td>{{ kindLabel(key.kind) }}</td>
            <td class="wrap-cell"><span v-if="key.kind === 'gateway'">{{ groupNames(key) }}</span><span v-else>{{ serviceModules(key) }}</span></td>
            <td><template v-if="key.kind === 'gateway'">{{ (key.groupIds?.length || 0) > 1 ? strategyLabel(key) : '单分组' }}</template><span v-else class="muted">—</span></td>
            <td><StatusBadge :status="key.enabled ? 'enabled' : 'disabled'" :label="key.enabled ? '已启用' : '已停用'" /></td>
            <td>{{ formatDate(key.createdAt) }}</td><td>{{ formatDate(key.lastUsedAt) }}</td>
            <td><div class="inline-actions justify-end"><button class="button small" :disabled="busy" @click="startEdit(key)">编辑</button><button class="button small" :disabled="busy" @click="toggle(key)">{{ key.enabled ? '停用' : '启用' }}</button><button class="button small danger" :disabled="busy" @click="revokeTarget = key">撤销</button></div></td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="table-footnote">完整密钥只在创建时显示一次。请求由哪个分组处理，就使用该分组在「酒馆预设」中的预设设置。</div>
  </section>

  <AppDialog v-model="createOpen" title="创建 API Key" description="选择密钥类型和调用分组，名称用于区分客户端或用途。" :close-disabled="busy">
    <form id="create-api-key-form" class="form-stack" @submit.prevent="createKey">
      <label class="field"><span>密钥名称</span><input v-model="keyName" required maxlength="80" placeholder="例如：KA、KB 或日常开发客户端" :disabled="busy" autofocus></label>
      <label class="field"><span>密钥类型</span><select v-model="createKind" :disabled="busy"><option value="gateway">模型 API Key</option><option value="service">外调服务 API Key</option></select></label>
      <template v-if="createKind === 'gateway'">
        <GroupSelector v-model="createGroupIds" ordered :groups="routingGroups.data.value?.items || []" :disabled="busy || !routingGroups.data.value || !!routingGroups.error.value" description="可选择多个分组，并调整调用顺序。模型 Key 仅能调用这些分组中的来源。" />
        <NuxtLink to="/groups" class="text-link" @click="createOpen = false">管理调用分组</NuxtLink>
        <label v-if="createGroupIds.length > 1" class="field"><span>多分组策略</span><select v-model="createStrategy" :disabled="busy"><option value="failover">自动切换：按顺序使用分组，失败时换下一个</option><option value="mixed">混合轮换：在分组之间轮流分配，失败时换下一个</option></select><small>每个请求由处理它的分组决定使用哪些酒馆预设。</small></label>
      </template>
      <fieldset v-else class="field"><span>可加号的模块</span><label v-for="module in intakeModules" :key="module.id" class="checkbox-line"><input v-model="createModuleIds" type="checkbox" :value="module.id" :disabled="busy">{{ module.name }}<small v-if="!module.enabled" class="muted">（模块已停用）</small></label><small>持有此 Key 的人可以通过外调 API 或公网加号页面给这些模块加号。</small></fieldset>
    </form>
    <template #footer><button class="button" :disabled="busy" @click="createOpen = false">取消</button><button form="create-api-key-form" class="button primary" :disabled="busy || !canCreate">创建密钥</button></template>
  </AppDialog>

  <AppDialog v-model="editOpen" title="编辑 API Key" description="修改名称或调用分组后，客户端继续使用原有密钥。" :close-disabled="busy">
    <form id="edit-api-key-form" class="form-stack" @submit.prevent="saveKey">
      <label class="field"><span>密钥名称</span><input v-model="editName" required maxlength="80" :disabled="busy"></label>
      <p class="small-text muted">类型：{{ editTarget ? kindLabel(editTarget.kind) : '' }}</p>
      <fieldset v-if="editTarget?.kind === 'service'" class="field"><span>可加号的模块</span><label v-for="module in intakeModules" :key="module.id" class="checkbox-line"><input v-model="editModuleIds" type="checkbox" :value="module.id" :disabled="busy">{{ module.name }}</label></fieldset>
      <template v-if="editTarget?.kind === 'gateway'">
        <GroupSelector v-model="editGroupIds" ordered :groups="routingGroups.data.value?.items || []" :disabled="busy || !routingGroups.data.value || !!routingGroups.error.value" description="可选择多个分组，并调整调用顺序。模型 Key 仅能调用这些分组中的来源。" />
        <label v-if="editGroupIds.length > 1" class="field"><span>多分组策略</span><select v-model="editStrategy" :disabled="busy"><option value="failover">自动切换：按顺序使用分组，失败时换下一个</option><option value="mixed">混合轮换：在分组之间轮流分配，失败时换下一个</option></select><small>每个请求由处理它的分组决定使用哪些酒馆预设。</small></label>
      </template>
    </form>
    <template #footer><button class="button" :disabled="busy" @click="editTarget = null">取消</button><button form="edit-api-key-form" class="button primary" :disabled="busy || !canEdit">保存设置</button></template>
  </AppDialog>

  <AppDialog v-model="secretOpen" :title="'请保存新' + kindLabel(createdKind)" description="完整密钥仅显示这一次。关闭后无法再次查看。">
    <div class="secret-box"><code>{{ createdKey }}</code></div>
    <p v-if="createdKind === 'gateway'" class="small-text muted">调用分组：{{ createdGroups }}。此 Key 可调用分组内各来源的模型。将它填入模型客户端的 API Key 设置，Base URL 使用你的域名加 /v1。</p>
    <p v-if="createdKind === 'service'" class="small-text muted">打开公网加号页面（服务器 3041 端口）输入此密钥即可加号；外部脚本可通过 Authorization: Bearer 或 x-api-key 请求 /api/external/*。</p>
    <template #footer><button class="button" @click="secretOpen = false">已保存，关闭</button><button class="button primary" @click="copyKey"><UIcon name="i-ph-copy-bold" />复制密钥</button></template>
  </AppDialog>

  <AppDialog v-model="revokeOpen" title="撤销 API Key" :description="'确认撤销「' + (revokeTarget?.name || '') + '」？使用此密钥的' + (revokeTarget?.kind === 'service' ? '外部服务将无法继续添加账号或查询状态。' : '客户端将无法继续调用模型。')" :close-disabled="busy">
    <p class="muted">此操作不能撤销。如只需暂时关闭访问，可以选择停用。</p>
    <template #footer><button class="button" :disabled="busy" @click="revokeTarget = null">取消</button><button class="button danger-solid" :disabled="busy" @click="revoke">确认撤销</button></template>
  </AppDialog>
</template>
