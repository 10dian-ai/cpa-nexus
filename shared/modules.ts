export interface ModuleNavigation { to: string; label: string; icon: string }
/**
 * Where a module sits in the platform hierarchy. The sidebar renders one
 * section per tier in this order: platform services, the first-level CPA
 * kernel, the second-level SillyTavern (酒馆) kernel, then ordinary modules.
 */
export type ModuleTier = 'platform' | 'core' | 'secondary' | 'module'
export const MODULE_TIER_ORDER: readonly ModuleTier[] = ['platform', 'core', 'secondary', 'module']
export interface ModuleManifest {
  id: string
  name: string
  description: string
  kind: 'kernel' | 'extension' | 'platform'
  tier: ModuleTier
  /** Sidebar section title. Ordinary modules default to their name. */
  navLabel?: string
  /** Identifies the module on the module pages; unique across manifests. */
  icon: string
  required: boolean
  defaultEnabled?: boolean
  version: string
  capabilities: string[]
  /**
   * The module's complete sidebar entries. Icons are unique across the whole
   * sidebar so that different destinations never look alike.
   */
  navigation: ModuleNavigation[]
}
export interface ModuleView extends ModuleManifest {
  enabled: boolean
  status: 'ready' | 'unconfigured' | 'unavailable' | 'disabled'
  message?: string
  runtimeVersion?: string | null
}

/**
 * Account-pool modules sit below the CPA kernel. Each one reaches clients only
 * through a kernel-owned bridge channel, and its models are published to CPA
 * under `<alias>/<model id>`. The alias is part of the public routing contract.
 */
export const POOL_MODULE_IDS = ['logicc'] as const
export type PoolModuleId = typeof POOL_MODULE_IDS[number]
export const POOL_MODULE_ALIASES: Record<PoolModuleId, string> = { logicc: 'logicc' }
export function isPoolModuleId(value: unknown): value is PoolModuleId {
  return typeof value === 'string' && (POOL_MODULE_IDS as readonly string[]).includes(value)
}

export const MODULE_MANIFESTS: readonly ModuleManifest[] = [
  {
    id: 'cpa', name: 'CPA 核心', kind: 'kernel', tier: 'core', navLabel: 'CPA 内核 · 一级', icon: 'i-ph-cpu-bold', required: true, version: 'v8',
    description: '统一模型调用入口，管理原生渠道、凭证、配置与插件；扩展模块只能通过内核声明的桥接渠道接入。',
    capabilities: ['完整原版控制台', '原生模型入口', '渠道与凭证', 'OAuth 登录', '供应商配额', '配置与路由', '模块桥接', '日志与插件'],
    navigation: [
      { to: '/cpa', label: '内核运行', icon: 'i-ph-cpu-bold' },
      { to: '/cpa/quick-start', label: '快速开始', icon: 'i-ph-rocket-launch-bold' },
      { to: '/cpa/config', label: '内核配置', icon: 'i-ph-gear-six-bold' },
      { to: '/cpa/credentials', label: '凭证管理', icon: 'i-ph-identification-card-bold' },
      { to: '/groups/accounts?module=cpa', label: '凭证分组', icon: 'i-ph-tree-structure-bold' },
      { to: '/cpa/oauth', label: 'OAuth 授权', icon: 'i-ph-sign-in-bold' },
      { to: '/cpa/quota', label: '配额管理', icon: 'i-ph-gauge-bold' },
      { to: '/cpa/channels', label: '渠道与模型', icon: 'i-ph-git-branch-bold' },
      { to: '/cpa/requests', label: '上游请求检查', icon: 'i-ph-flask-bold' },
      { to: '/cpa/keys', label: '原生访问密钥', icon: 'i-ph-lock-key-bold' },
      { to: '/cpa/logs', label: '日志与用量', icon: 'i-ph-scroll-bold' },
      { to: '/cpa/plugins', label: '原生插件', icon: 'i-ph-plugs-connected-bold' },
      { to: '/cpa/plugins?tab=store', label: '插件商店', icon: 'i-ph-storefront-bold' },
      { to: '/cpa/system', label: '系统信息', icon: 'i-ph-info-bold' },
      { to: '/cpa/native', label: '原版完整控制台', icon: 'i-ph-browser-bold' },
    ],
  },
  {
    id: 'presets', name: '酒馆预设', kind: 'extension', tier: 'secondary', navLabel: '酒馆内核 · 二级', icon: 'i-ph-mask-happy-bold', required: false, defaultEnabled: false, version: '0.1.0',
    description: '导入、编辑酒馆 JSON 预设，按调用分组开关和叠加预设。',
    capabilities: ['JSON 导入与导出', '提示词编排', '采样参数', '按分组叠加'],
    navigation: [{ to: '/presets', label: '酒馆预设', icon: 'i-ph-mask-happy-bold' }],
  },
  {
    id: 'logicc', name: 'Logicc', kind: 'extension', tier: 'module', navLabel: 'Logicc 模块', icon: 'i-ph-lightning-bold', required: false, defaultEnabled: true, version: '0.1.0',
    description: 'Logicc 网页会话账号池：Clerk 凭据自动续期，经 CPA 内核桥接渠道统一调用，本地计算 usage。',
    capabilities: ['Clerk 自动续期', '批量与远程加号', '模型目录同步', '并发与冷却', '工具调用模拟', 'usage 本地计算'],
    navigation: [
      { to: '/logicc', label: '号池概览', icon: 'i-ph-lightning-bold' },
      { to: '/logicc/accounts', label: '账号管理', icon: 'i-ph-address-book-bold' },
      { to: '/groups/accounts?module=logicc', label: '账号分组', icon: 'i-ph-users-bold' },
      { to: '/logicc/settings', label: '模块设置', icon: 'i-ph-faders-bold' },
    ],
  },
  {
    id: 'platform', name: '平台管理', kind: 'platform', tier: 'platform', navLabel: '平台', icon: 'i-ph-squares-four-bold', required: true, version: '0.3.0',
    description: '统一管理员登录、模块管理、API Key、外调服务与部署配置。',
    capabilities: ['管理员会话', '模块状态', 'API Key 与分组', '外调服务 API', '请求日志', '部署与版本适配'],
    navigation: [
      { to: '/', label: '平台概览', icon: 'i-ph-squares-four-bold' },
      { to: '/modules', label: '模块管理', icon: 'i-ph-stack-bold' },
      { to: '/keys', label: 'API Key', icon: 'i-ph-key-bold' },
      { to: '/groups', label: '调用分组', icon: 'i-ph-users-four-bold' },
      { to: '/logs', label: '请求日志', icon: 'i-ph-list-bullets-bold' },
      { to: '/settings', label: '平台设置', icon: 'i-ph-sliders-horizontal-bold' },
    ],
  },
]

export function findModule(id: string): ModuleManifest | undefined {
  return MODULE_MANIFESTS.find(module => module.id === id)
}

/**
 * Admin write paths owned by an optional module. While the module is stopped
 * these return 503; reads stay available so data can still be inspected.
 */
export function gatedModuleForRequest(path: string, method: string): string | null {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return null
  const match = /^\/api\/(?:modules\/)?([a-z0-9-]+)\/(?:accounts|import|sync)(?:\/|$)/.exec(path)
  return match && isPoolModuleId(match[1]) ? match[1] : null
}
