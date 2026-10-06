import type { ModuleView, ModuleNavigation } from '../../shared/modules'
import { pluginMenuHref } from '../utils/cpa-plugins'

/** A single destination rendered by the shell navigation. */
export interface NavigationLink {
  to: string
  label: string
  icon: string
  description?: string
}

export interface NavigationGroup {
  label: string
  links: NavigationLink[]
}

interface CpaPluginNavigation {
  id: string
  name: string
  effectiveEnabled: boolean
  menus?: { path?: string; name?: string; description?: string }[]
}

const platformLinks: NavigationLink[] = [
  { to: '/', label: '平台概览', icon: 'i-ph-squares-four-bold' },
  { to: '/modules', label: '模块管理', icon: 'i-ph-stack-bold' },
  { to: '/keys', label: 'API Key', icon: 'i-ph-key-bold' },
  { to: '/groups', label: '调用分组', icon: 'i-ph-users-four-bold' },
  { to: '/presets', label: '酒馆预设', icon: 'i-ph-sliders-horizontal-bold' },
]

const cpaLinks: NavigationLink[] = [
  { to: '/cpa', label: '内核运行', icon: 'i-ph-cpu-bold' },
  { to: '/cpa/quick-start', label: '快速开始', icon: 'i-ph-rocket-launch-bold' },
  { to: '/cpa/config', label: '内核配置', icon: 'i-ph-sliders-horizontal-bold' },
  { to: '/cpa/credentials', label: '凭证管理', icon: 'i-ph-identification-card-bold' },
  { to: '/groups/accounts?module=cpa', label: 'CPA 凭证分组', icon: 'i-ph-users-four-bold' },
  { to: '/cpa/oauth', label: 'OAuth 授权', icon: 'i-ph-sign-in-bold' },
  { to: '/cpa/quota', label: '配额管理', icon: 'i-ph-gauge-bold' },
  { to: '/cpa/channels', label: '渠道与模型', icon: 'i-ph-git-branch-bold' },
  { to: '/cpa/requests', label: '上游请求检查', icon: 'i-ph-arrows-left-right-bold' },
  { to: '/cpa/keys', label: '原生访问密钥', icon: 'i-ph-key-bold' },
  { to: '/cpa/logs', label: '日志与用量', icon: 'i-ph-list-bullets-bold' },
  { to: '/cpa/plugins', label: '原生插件', icon: 'i-ph-plugs-connected-bold' },
  { to: '/cpa/plugins?tab=store', label: '插件商店', icon: 'i-ph-storefront-bold' },
  { to: '/cpa/system', label: '系统信息', icon: 'i-ph-info-bold' },
  { to: '/cpa/native', label: '原版完整控制台', icon: 'i-ph-browser-bold' },
]

const commandcodeLinks: NavigationLink[] = [
  { to: '/commandcode', label: '账号池概览', icon: 'i-ph-chart-bar-bold' },
  { to: '/accounts', label: '账号管理', icon: 'i-ph-users-three-bold' },
  { to: '/groups/accounts?module=commandcode', label: '账号调用分组', icon: 'i-ph-users-four-bold' },
  { to: '/official', label: '官方模型与套餐', icon: 'i-ph-book-open-bold' },
  { to: '/models', label: '模型观察', icon: 'i-ph-cube-bold' },
  { to: '/logs', label: '请求日志', icon: 'i-ph-list-bullets-bold' },
  { to: '/settings', label: '模块设置', icon: 'i-ph-sliders-horizontal-bold' },
]

function asNavigationLink(link: ModuleNavigation): NavigationLink {
  return { to: link.to, label: link.label, icon: link.icon }
}

export function buildNavigationGroups(modules: ModuleView[] = [], plugins: CpaPluginNavigation[] = []): NavigationGroup[] {
  const groups: NavigationGroup[] = [
    { label: '平台', links: platformLinks },
    { label: 'CPA 内核', links: cpaLinks },
  ]

  const pluginNavigation = plugins
    .filter(plugin => plugin.effectiveEnabled)
    .flatMap(plugin => (plugin.menus || []).map((menu, index) => ({ plugin, menu, index })))
    .filter(({ plugin, menu }) => !!pluginMenuHref(plugin.id, menu as Record<string, unknown>))
    .map(({ plugin, menu, index }) => ({
      to: `/cpa/plugin-pages/${encodeURIComponent(plugin.id)}/${index}`,
      label: menu.name || `${plugin.name} 页面 ${index + 1}`,
      icon: 'i-ph-puzzle-piece-bold',
      description: menu.description,
    }))
  if (pluginNavigation.length) groups.push({ label: 'CPA 插件页面', links: pluginNavigation })

  // Keep the core extension visible while the module request is loading or
  // unavailable. The previous layout used the same optimistic fallback.
  const commandcode = modules.find(module => module.id === 'commandcode')
  if (commandcode?.enabled !== false) {
    groups.push({ label: 'CommandCode', links: commandcodeLinks })
  }

  for (const module of modules) {
    if (!module.enabled || ['cpa', 'commandcode', 'platform', 'presets'].includes(module.id) || !module.navigation.length) continue
    groups.push({ label: module.name, links: module.navigation.map(asNavigationLink) })
  }
  return groups
}

function splitTarget(target: string): { path: string; query: URLSearchParams } {
  const [path = '/', query = ''] = target.split('?')
  return { path, query: new URLSearchParams(query) }
}

/**
 * Check a shell link against the current route. Query parameters on a link
 * are constraints, so `/cpa/plugins?tab=store` wins over `/cpa/plugins`.
 */
export function navigationLinkMatches(target: string, routePath: string, routeQuery: Record<string, unknown>): boolean {
  const { path, query } = splitTarget(target)
  const pathMatches = path === '/'
    ? routePath === '/'
    : routePath === path || routePath.startsWith(`${path}/`)
  if (!pathMatches) return false
  for (const [name, expected] of query.entries()) {
    // `/groups/accounts` defaults to CPA in the page itself. Treat the
    // explicit CPA link as selected when the query is omitted, matching the
    // page's default and preserving the old shell breadcrumb behavior.
    const actual = routeQuery[name] ?? (name === 'module' ? 'cpa' : '')
    if (String(actual) !== expected) return false
  }
  return true
}

function navigationScore(target: string, routePath: string): number {
  const { path, query } = splitTarget(target)
  const exactPath = routePath === path ? 1000 : 0
  return exactPath + path.length * 10 + query.size * 100
}

export function selectCurrentNavigation(groups: NavigationGroup[], routePath: string, routeQuery: Record<string, unknown>): NavigationLink {
  const candidates = groups.flatMap(group => group.links).filter(link => navigationLinkMatches(link.to, routePath, routeQuery))
  return candidates.sort((a, b) => navigationScore(b.to, routePath) - navigationScore(a.to, routePath))[0] || groups[0]!.links[0]!
}

export function useAppNavigation(
  moduleData: Ref<{ modules: ModuleView[] } | null | undefined>,
  cpaCapabilities: Ref<{ plugins?: CpaPluginNavigation[] } | null | undefined>,
) {
  const route = useRoute()
  const groups = computed(() => buildNavigationGroups(moduleData.value?.modules || [], cpaCapabilities.value?.plugins || []))
  const current = computed(() => selectCurrentNavigation(groups.value, route.path, route.query as Record<string, unknown>))
  return { groups, current }
}
