<script setup lang="ts">
import type { GatewayKeyView } from '#shared/types'
import type { ModuleView } from '#shared/modules'

type KeyKind = 'gateway' | 'service'
type ModelModule = 'cpa' | 'commandcode'
interface ManagedKey extends GatewayKeyView { kind: KeyKind }

const api = useRequestFetch()
const [gateway, service, modules] = await Promise.all([
  useFetch<{ items: GatewayKeyView[] }>('/api/keys'),
  useFetch<{ items: GatewayKeyView[] }>('/api/service-keys'),
  useFetch<{ modules: ModuleView[] }>('/api/modules', { key: 'nexus-modules' }),
])
const commandcodeEnabled = computed(() => modules.data.value?.modules.find(module => module.id === 'commandcode')?.enabled === true)
const pending = computed(() => gateway.pending.value || service.pending.value || modules.pending.value)
const loaded = computed(() => !!gateway.data.value || !!service.data.value)
const items = computed<ManagedKey[]>(() => [
  ...(gateway.data.value?.items || []).map(key => ({ ...key, kind: 'gateway' as const })),
  ...(service.data.value?.items || []).map(key => ({ ...key, kind: 'service' as const })),
].sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
const filter = ref<'all' | KeyKind>('all')
const visibleItems = computed(() => items.value.filter(key => filter.value === 'all' || key.kind === filter.value))
async function refreshKeys() { await Promise.all([gateway.refresh(), service.refresh()]) }
async function refresh() { await Promise.all([refreshKeys(), modules.refresh()]) }
useLiveRefresh(refreshKeys)

const createOpen = ref(false)
const createKind = ref<KeyKind>('gateway')
const keyName = ref('')
const moduleId = ref<ModelModule>('cpa')
const canCreate = computed(() => !!keyName.value.trim() && !modules.pending.value && !modules.error.value && (createKind.value === 'service' ? commandcodeEnabled.value : moduleId.value === 'cpa' || commandcodeEnabled.value))
watch(commandcodeEnabled, enabled => {
  if (!enabled) {
    createKind.value = 'gateway'
    moduleId.value = 'cpa'
  }
})
const editTarget = ref<ManagedKey | null>(null)
const editName = ref('')
const editModule = ref<ModelModule>('cpa')
const editOpen = computed({ get: () => !!editTarget.value, set: value => { if (!value) editTarget.value = null } })
const canEdit = computed(() => !!editName.value.trim() && (editTarget.value?.kind === 'service' || editModule.value === boundModule(editTarget.value) || editModule.value === 'cpa' || commandcodeEnabled.value))
const createdKey = ref('')
const createdKind = ref<KeyKind>('gateway')
const createdModule = ref<ModelModule>('cpa')
const secretOpen = computed({ get: () => !!createdKey.value, set: value => { if (!value) createdKey.value = '' } })
const revokeTarget = ref<ManagedKey | null>(null)
const revokeOpen = computed({ get: () => !!revokeTarget.value, set: value => { if (!value) revokeTarget.value = null } })
const { busy, run } = useApiAction()
const toast = useToast()

function endpoint(kind: KeyKind) { return kind === 'service' ? '/api/service-keys' : '/api/keys' }
function kindLabel(kind: KeyKind) { return kind === 'service' ? '外调服务 API Key' : '模型 API Key' }
function boundModule(key: ManagedKey | null): ModelModule { return key?.kind === 'service' ? 'commandcode' : key?.moduleId || 'commandcode' }
function moduleLabel(value: ModelModule) { return value === 'cpa' ? 'CPA 核心' : 'Command Code' }
function moduleDisabled(key: ManagedKey) { return boundModule(key) === 'commandcode' && modules.data.value?.modules.find(module => module.id === 'commandcode')?.enabled === false }
function startCreate() {
  keyName.value = ''
  createKind.value = 'gateway'
  moduleId.value = 'cpa'
  createOpen.value = true
}
async function createKey() {
  if (!canCreate.value) return
  const kind = createKind.value
  const binding = moduleId.value
  const result = await run(() => api<{ key: string; item: GatewayKeyView }>(endpoint(kind), {
    method: 'POST', body: { name: keyName.value.trim(), ...(kind === 'gateway' ? { moduleId: binding } : {}) },
  }))
  if (result.ok) {
    createOpen.value = false
    createdKind.value = kind
    createdModule.value = binding
    createdKey.value = result.value.key
    await refreshKeys()
  }
}
function startEdit(key: ManagedKey) {
  editName.value = key.name
  editModule.value = boundModule(key)
  editTarget.value = key
}
async function saveKey() {
  const target = editTarget.value
  if (!target || !canEdit.value) return
  const result = await run(() => api(endpoint(target.kind) + '/' + target.id, {
    method: 'PATCH', body: {
      name: editName.value.trim(),
      ...(target.kind === 'gateway' && editModule.value !== boundModule(target) ? { moduleId: editModule.value } : {}),
    },
  }), '密钥设置已保存')
  if (result.ok) { editTarget.value = null; await refreshKeys() }
}
async function toggle(key: ManagedKey) {
  if (!key.enabled && moduleDisabled(key)) return
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
      <div><h2>调用密钥</h2><p class="small-text muted">模型调用按密钥绑定的模块转发；外调服务密钥用于 Command Code 账号导入与状态查询。</p></div>
      <div class="inline-actions toolbar-meta">
        <select v-model="filter" aria-label="按密钥类型筛选"><option value="all">全部类型</option><option value="gateway">模型 API Key</option><option v-if="commandcodeEnabled || items.some(key => key.kind === 'service')" value="service">外调服务 API Key</option></select>
        <button class="button" :disabled="pending" @click="refresh()"><UIcon name="i-ph-arrow-clockwise-bold" :class="{ spinning: pending }" />刷新</button>
        <button class="button primary" :disabled="busy || modules.pending.value || !!modules.error.value" @click="startCreate"><UIcon name="i-ph-plus-bold" />创建 API Key</button>
      </div>
    </div>
    <AppState v-if="modules.error.value" :error="modules.error.value" compact title="无法读取模块状态" @retry="modules.refresh()" />
    <AppState v-if="gateway.error.value" :error="gateway.error.value" compact title="模型密钥读取失败" @retry="gateway.refresh()" />
    <AppState v-if="service.error.value" :error="service.error.value" compact title="外调服务密钥读取失败" @retry="service.refresh()" />
    <AppState v-if="!loaded && pending" loading />
    <AppState v-else-if="loaded && !visibleItems.length" icon="i-ph-key-bold" :title="filter === 'all' ? '还没有 API Key' : '没有此类型的密钥'" description="创建模型 API Key 并选择绑定模块，即可配置到模型客户端。">
      <button class="button primary" :disabled="busy || modules.pending.value || !!modules.error.value" @click="startCreate">创建 API Key</button>
    </AppState>
    <div v-else-if="visibleItems.length" class="table-scroll">
      <table class="data-table">
        <thead><tr><th>名称 / 密钥标识</th><th>类型</th><th>绑定模块</th><th>状态</th><th>创建时间</th><th>最近使用</th><th class="align-right">操作</th></tr></thead>
        <tbody>
          <tr v-for="key in visibleItems" :key="key.kind + ':' + key.id">
            <td><strong>{{ key.name }}</strong><div class="cell-secondary mono">{{ key.prefix }}…</div></td>
            <td>{{ kindLabel(key.kind) }}</td>
            <td>{{ moduleLabel(boundModule(key)) }}<div v-if="moduleDisabled(key)" class="cell-error">模块已停用，调用不可用</div></td>
            <td><StatusBadge :status="key.enabled ? 'enabled' : 'disabled'" :label="key.enabled ? '已启用' : '已停用'" /></td>
            <td>{{ formatDate(key.createdAt) }}</td><td>{{ formatDate(key.lastUsedAt) }}</td>
            <td><div class="inline-actions justify-end"><button class="button small" :disabled="busy" @click="startEdit(key)">编辑</button><button class="button small" :disabled="busy || (!key.enabled && moduleDisabled(key))" @click="toggle(key)">{{ key.enabled ? '停用' : '启用' }}</button><button class="button small danger" :disabled="busy" @click="revokeTarget = key">撤销</button></div></td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="table-footnote">完整密钥只在创建时显示一次。模型 API Key 可修改绑定模块；酒馆预设在「酒馆预设」页面按 API Key 单独设置。</div>
  </section>

  <AppDialog v-model="createOpen" title="创建 API Key" description="选择密钥类型和绑定模块，名称用于区分客户端或用途。" :close-disabled="busy">
    <form id="create-api-key-form" class="form-stack" @submit.prevent="createKey">
      <label class="field"><span>密钥名称</span><input v-model="keyName" required maxlength="80" placeholder="例如：KA、KB 或日常开发客户端" :disabled="busy" autofocus></label>
      <label class="field"><span>密钥类型</span><select v-model="createKind" :disabled="busy"><option value="gateway">模型 API Key</option><option v-if="commandcodeEnabled" value="service">外调服务 API Key</option></select><small v-if="!commandcodeEnabled">启用 Command Code 模块后，可创建外调服务 API Key。</small></label>
      <label v-if="createKind === 'gateway'" class="field"><span>绑定模块</span><select v-model="moduleId" :disabled="busy"><option value="cpa">CPA 核心</option><option v-if="commandcodeEnabled" value="commandcode">Command Code</option></select><small>此密钥仅调用所选模块的模型。酒馆预设可在创建后按此密钥设置。</small></label>
      <p v-else class="small-text muted">绑定 Command Code，用于外部服务添加账号、查询导入进度和账号池状态。</p>
    </form>
    <template #footer><button class="button" :disabled="busy" @click="createOpen = false">取消</button><button form="create-api-key-form" class="button primary" :disabled="busy || !canCreate">创建密钥</button></template>
  </AppDialog>

  <AppDialog v-model="editOpen" title="编辑 API Key" description="修改名称或绑定模块后，客户端继续使用原有密钥。" :close-disabled="busy">
    <form id="edit-api-key-form" class="form-stack" @submit.prevent="saveKey">
      <label class="field"><span>密钥名称</span><input v-model="editName" required maxlength="80" :disabled="busy"></label>
      <p class="small-text muted">类型：{{ editTarget ? kindLabel(editTarget.kind) : '' }}</p>
      <label v-if="editTarget?.kind === 'gateway'" class="field"><span>绑定模块</span><select v-model="editModule" :disabled="busy"><option value="cpa">CPA 核心</option><option v-if="commandcodeEnabled || editModule === 'commandcode'" value="commandcode" :disabled="!commandcodeEnabled">Command Code{{ commandcodeEnabled ? '' : '（模块已停用）' }}</option></select><small>保存后，此密钥的后续模型请求会使用所选模块。</small></label>
      <p v-else class="small-text muted">外调服务 API Key 固定绑定 Command Code。</p>
    </form>
    <template #footer><button class="button" :disabled="busy" @click="editTarget = null">取消</button><button form="edit-api-key-form" class="button primary" :disabled="busy || !canEdit">保存设置</button></template>
  </AppDialog>

  <AppDialog v-model="secretOpen" :title="'请保存新' + kindLabel(createdKind)" description="完整密钥仅显示这一次。关闭后无法再次查看。">
    <div class="secret-box"><code>{{ createdKey }}</code></div>
    <p v-if="createdKind === 'gateway'" class="small-text muted">已绑定 {{ moduleLabel(createdModule) }}。将此密钥填入模型客户端的 API Key 设置，Base URL 使用你的域名加 /v1。</p>
    <p v-else class="small-text muted">将此密钥配置到外部服务，通过 Authorization: Bearer 或 x-api-key 请求 /api/external/*。</p>
    <template #footer><button class="button" @click="secretOpen = false">已保存，关闭</button><button class="button primary" @click="copyKey"><UIcon name="i-ph-copy-bold" />复制密钥</button></template>
  </AppDialog>

  <AppDialog v-model="revokeOpen" title="撤销 API Key" :description="'确认撤销「' + (revokeTarget?.name || '') + '」？使用此密钥的' + (revokeTarget?.kind === 'service' ? '外部服务将无法继续添加账号或查询状态。' : '客户端将无法继续调用模型。')" :close-disabled="busy">
    <p class="muted">此操作不能撤销。如只需暂时关闭访问，可以选择停用。</p>
    <template #footer><button class="button" :disabled="busy" @click="revokeTarget = null">取消</button><button class="button danger-solid" :disabled="busy" @click="revoke">确认撤销</button></template>
  </AppDialog>
</template>
