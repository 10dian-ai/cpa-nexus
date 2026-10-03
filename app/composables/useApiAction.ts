export function apiErrorMessage(error: unknown): string {
  const value = error as { data?: { statusMessage?: string; message?: string; error?: string | { message?: string }; data?: { message?: string } }; statusMessage?: string; message?: string }
  const upstream = typeof value?.data?.error === 'string' ? value.data.error : value?.data?.error?.message
  return value?.data?.data?.message || value?.data?.message || value?.data?.statusMessage || upstream || value?.statusMessage || value?.message || '操作失败，请稍后重试'
}
export function isPlatformAuthenticationError(error: unknown): boolean {
  const value = error as { statusCode?: number; status?: number; response?: { headers?: { get(name: string): string | null } } }
  return (value?.statusCode === 401 || value?.status === 401) && value.response?.headers?.get('x-nexus-upstream') !== 'cpa'
}
export function useApiAction() {
  const busy = ref(false)
  const toast = useToast()
  const route = useRoute()
  const { session } = useAuth()
  async function run<T>(action: () => Promise<T>, message?: string): Promise<{ ok: true; value: T } | { ok: false }> {
    if (busy.value) return { ok: false }
    busy.value = true
    try {
      const value = await action()
      if (message) toast.add({ title: message, color: 'success', icon: 'i-ph-check-circle-bold' })
      return { ok: true, value }
    } catch (error) {
      if (isPlatformAuthenticationError(error) && route.path !== '/login') {
        session.value = { authenticated: false, username: null }
        await navigateTo({ path: '/login', query: { redirect: route.fullPath } })
      } else {
        toast.add({ title: '操作未完成', description: apiErrorMessage(error), color: 'error', icon: 'i-ph-warning-circle-bold' })
      }
      return { ok: false }
    } finally { busy.value = false }
  }
  return { busy, run }
}
