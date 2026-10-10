import { MODULE_MANIFESTS, MODULE_TIER_ORDER, type ModuleManifest, type ModuleNavigation, type ModuleView } from '#shared/modules'
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

function asNavigationLink(link: ModuleNavigation): NavigationLink {
  return { to: link.to, label: link.label, icon: link.icon }
}

/** Platform services and the CPA kernel are always present. */
const ALWAYS_VISIBLE_TIERS = new Set(['platform', 'core'])

function moduleVisible(manifest: ModuleManifest, view: ModuleView | undefined): boolean {
  if (manifest.required || ALWAYS_VISIBLE_TIERS.has(manifest.tier)) return true
  // While module metadata loads, keep default-on modules visible (the previous
  // optimistic fallback) and hide opt-in modules until they are confirmed.
  return view ? view.enabled : manifest.defaultEnabled !== false
}

/**
 * Sidebar sections follow the platform hierarchy declared by the module
 * manifests: platform → CPA (first-level kernel) → its enabled plugin pages →
 * SillyTavern (second-level kernel) → ordinary modules. Server views decide
 * which optional modules are enabled; unknown server modules are appended last.
 */
export function buildNavigationGroups(modules: ModuleView[] = [], plugins: CpaPluginNavigation[] = []): NavigationGroup[] {
  const views = new Map(modules.map(module => [module.id, module]))
  const known = new Set(MODULE_MANIFESTS.map(manifest => manifest.id))
  const entries: ModuleManifest[] = [
    // Known modules render from the client's own manifest; the server view
    // only decides whether the module is enabled.
    ...MODULE_MANIFESTS,
    ...modules.filter(module => !known.has(module.id)).map(module => ({ ...module, tier: module.tier || 'module' as const })),
  ]
  const groups: NavigationGroup[] = []
  for (const tier of MODULE_TIER_ORDER) {
    for (const manifest of entries.filter(entry => entry.tier === tier)) {
      if (!moduleVisible(manifest, views.get(manifest.id)) || !manifest.navigation.length) continue
      groups.push({ label: manifest.navLabel || manifest.name, links: manifest.navigation.map(asNavigationLink) })
      if (manifest.id === 'cpa') {
        const pages = pluginNavigation(plugins)
        if (pages.length) groups.push({ label: 'CPA 插件页面', links: pages })
      }
    }
  }
  return groups
}

function pluginNavigation(plugins: CpaPluginNavigation[]): NavigationLink[] {
  return plugins
    .filter(plugin => plugin.effectiveEnabled)
    .flatMap(plugin => (plugin.menus || []).map((menu, index) => ({ plugin, menu, index })))
    .filter(({ plugin, menu }) => !!pluginMenuHref(plugin.id, menu as Record<string, unknown>))
    .map(({ plugin, menu, index }) => ({
      to: `/cpa/plugin-pages/${encodeURIComponent(plugin.id)}/${index}`,
      label: menu.name || `${plugin.name} 页面 ${index + 1}`,
      icon: 'i-ph-puzzle-piece-bold',
      description: menu.description,
    }))
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
