import { computed, ref, watch, type Ref } from 'vue'

function sameField(left: unknown, right: unknown) {
  return Object.is(left, right) || (Array.isArray(left) && Array.isArray(right) &&
    left.length === right.length && left.every((value, index) => Object.is(value, right[index])))
}

// Synchronize scalar and selection-list fields while retaining unsaved edits.
export function useEditableFields<T extends object>(source: () => T | null | undefined, identity: () => unknown = () => undefined) {
  const form = ref<T | null>(null) as Ref<T | null>
  const baseline = ref<T | null>(null) as Ref<T | null>
  let previousIdentity: unknown
  watch(() => [source(), identity()] as const, ([incoming, id]) => {
    if (!incoming) return
    const next = { ...incoming }
    if (!form.value || !baseline.value || id !== previousIdentity) {
      form.value = { ...next }
    } else {
      for (const key of Object.keys(next) as (keyof T)[]) {
        if (sameField(form.value[key], baseline.value[key])) form.value[key] = next[key]
      }
    }
    baseline.value = next
    previousIdentity = id
  }, { immediate: true })
  const dirty = computed(() => !!form.value && !!baseline.value &&
    (Object.keys(baseline.value) as (keyof T)[]).some(key => !sameField(form.value![key], baseline.value![key])))
  function reset(value = source()) {
    if (value) {
      form.value = { ...value }
      baseline.value = { ...value }
      previousIdentity = identity()
    }
  }
  return { form, dirty, reset }
}
