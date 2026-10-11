<script setup lang="ts">
import type { RoutingGroupView } from '#shared/groups'
const props = withDefaults(defineProps<{
  modelValue: string[]
  groups: RoutingGroupView[]
  disabled?: boolean
  label?: string
  description?: string
  /** Keep the selection order (model keys try their groups in this order). */
  ordered?: boolean
}>(), { disabled: false, ordered: false, label: '调用分组', description: '可选择多个分组，模型 Key 仅能调用与它有共同启用分组的账号。' })
const emit = defineEmits<{ 'update:modelValue': [ids: string[]] }>()
const search = ref('')
const visible = computed(() => props.groups.filter(group => group.name.toLowerCase().includes(search.value.trim().toLowerCase())))
const hasEnabledSelection = computed(() => props.groups.some(group => group.enabled && props.modelValue.includes(group.id)))
function toggle(id: string, checked: boolean) {
  const next = checked ? [...new Set([...props.modelValue, id])] : props.modelValue.filter(value => value !== id)
  emit('update:modelValue', props.ordered ? next : next.sort())
}
const groupName = (id: string) => props.groups.find(group => group.id === id)?.name || '未读取分组'
function move(index: number, offset: number) {
  const next = [...props.modelValue]
  const target = index + offset
  if (target < 0 || target >= next.length) return
  ;[next[index], next[target]] = [next[target]!, next[index]!]
  emit('update:modelValue', next)
}
</script>
<template>
  <fieldset class="group-selector" :disabled="disabled">
    <legend>{{ label }}</legend>
    <p v-if="description" class="small-text muted">{{ description }}</p>
    <label v-if="groups.length > 6" class="search-field group-search"><UIcon name="i-ph-magnifying-glass-bold" /><input v-model="search" :aria-label="'搜索' + label" placeholder="搜索分组"></label>
    <div class="group-options">
      <label v-for="group in visible" :key="group.id" class="group-option" :class="{ selected: modelValue.includes(group.id) }">
        <input type="checkbox" :checked="modelValue.includes(group.id)" @change="toggle(group.id, ($event.target as HTMLInputElement).checked)">
        <span>{{ group.name }}<small v-if="group.isDefault">默认</small><small v-if="!group.enabled" class="disabled-label">已停用</small></span>
      </label>
      <p v-if="!visible.length" class="small-text muted">{{ search ? '没有匹配的分组' : '暂无可选分组，请先创建分组。' }}</p>
    </div>
    <ol v-if="ordered && modelValue.length > 1" class="group-order" aria-label="分组调用顺序">
      <li v-for="(id, index) in modelValue" :key="id">
        <span class="group-order-index">{{ index + 1 }}</span><span class="group-order-name">{{ groupName(id) }}</span>
        <button type="button" class="icon-button" :disabled="disabled || index === 0" :aria-label="'上移 ' + groupName(id)" @click="move(index, -1)"><UIcon name="i-ph-arrow-up-bold" /></button>
        <button type="button" class="icon-button" :disabled="disabled || index === modelValue.length - 1" :aria-label="'下移 ' + groupName(id)" @click="move(index, 1)"><UIcon name="i-ph-arrow-down-bold" /></button>
      </li>
    </ol>
    <p v-if="!modelValue.length" class="group-error" role="status">至少选择一个分组。</p>
    <p v-else-if="groups.length && !hasEnabledSelection" class="group-error" role="status">所选分组均已停用，暂时无法通过这些分组调用模型。</p>
  </fieldset>
</template>
<style scoped>
.group-selector { border: 0; padding: 0; margin: 0; min-width: 0; }.group-selector legend { font-size: 14px; font-weight: 600; margin-bottom: 7px; }.group-selector > p { margin: 0 0 12px; line-height: 1.65; }.group-search { margin-bottom: 12px; }.group-search input { min-width: 0; width: 100%; }.group-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr)); gap: 8px; max-height: 260px; overflow-y: auto; }.group-option { display: flex; align-items: flex-start; gap: 9px; border: 1px solid var(--border); padding: 12px; cursor: pointer; border-radius: 5px; min-width: 0; }.group-option.selected { background: var(--green-bg); }.group-option input { margin: 2px 0 0; flex-shrink: 0; accent-color: var(--green); }.group-option > span { overflow-wrap: anywhere; font-size: 14px; line-height: 1.5; }.group-option small { margin-left: 7px; font-size: 12px; color: var(--muted); }.group-option .disabled-label { color: #a27220; }.group-selector[disabled] .group-option { cursor: default; opacity: .65; }.group-order { list-style: none; margin: 12px 0 0; padding: 0; display: grid; gap: 6px; }.group-order li { display: flex; align-items: center; gap: 8px; border: 1px solid var(--border); border-radius: 5px; padding: 6px 8px; font-size: 14px; min-width: 0; }.group-order-index { flex-shrink: 0; width: 20px; height: 20px; border-radius: 50%; background: var(--green-bg); display: grid; place-items: center; font-size: 12px; font-weight: 600; }.group-order-name { flex: 1; min-width: 0; overflow-wrap: anywhere; }.group-selector .group-error { color: #a43853; font-size: 13px; margin-top: 9px; margin-bottom: 0; }
</style>
