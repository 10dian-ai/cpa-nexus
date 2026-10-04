import type { OfficialCatalogView } from '#shared/official-catalog'

export function useOfficialCatalog() {
  const result = useFetch<OfficialCatalogView>('/api/official/catalog', { key: 'nexus-official-catalog' })
  const { busy, run } = useApiAction()
  const toast = useToast()
  useLiveRefresh(result.refresh)

  async function refreshOfficial() {
    const checked = await run(() => $fetch<OfficialCatalogView>('/api/official/refresh', {
      method: 'POST', timeout: 120_000,
    }))
    if (checked.ok) {
      result.data.value = checked.value
      if (checked.value.refreshInProgress) toast.add({ title: '后台正在刷新，请稍后查看', description: '当前保留最近成功结果，页面会自动读取更新。', color: 'info' })
      else if (checked.value.stale || checked.value.error || checked.value.availabilitySync?.bridgeError) toast.add({ title: '刷新未完全成功', description: checked.value.availabilitySync?.bridgeError || checked.value.error || '部分来源仍未取得新快照，当前保留最近成功数据。', color: 'warning' })
      else toast.add({ title: '可使用模型列表已更新', icon: 'i-ph-check-bold' })
    }
    return checked.ok
  }

  let timer: ReturnType<typeof setInterval> | undefined
  onMounted(() => {
    timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !result.pending.value && !busy.value) void result.refresh()
    }, 60_000)
  })
  onBeforeUnmount(() => { if (timer) clearInterval(timer) })
  return { ...result, busy, refreshOfficial }
}
