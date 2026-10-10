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
export const MODULE_MANIFESTS: readonly ModuleManifest[] = [
  {
    id: 'cpa', name: 'CPA 核心', kind: 'kernel', tier: 'core', navLabel: 'CPA 内核 · 一级', icon: 'i-ph-cpu-bold', required: true, version: 'v8',
    description: '统一模型调用入口，管理原生渠道、凭证、配置与插件。',
    capabilities: ['完整原版控制台', '原生模型入口', '渠道与凭证', 'OAuth 登录', '供应商配额', '配置与路由', '日志与插件'],
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
    description: '导入、编辑酒馆 JSON 预设，为模块和 API Key 选择请求处理路由。',
    capabilities: ['JSON 导入与导出', '提示词编排', '采样参数', '模块与 API Key 路由'],
    navigation: [{ to: '/presets', label: '酒馆预设', icon: 'i-ph-mask-happy-bold' }],
  },
  {
    id: 'commandcode', name: 'CommandCode', kind: 'extension', tier: 'module', navLabel: 'CommandCode 模块', icon: 'i-ph-command-bold', required: false, version: '0.2.0',
    description: 'GOAT 官方 API 账号池，保留真实额度、会话亲和与并发控制。',
    capabilities: ['官方 API', '官网目录与套餐', 'Cookie 保活', '真实额度', '并发与会话', '调用日志'],
    navigation: [
      { to: '/commandcode', label: '账号池概览', icon: 'i-ph-chart-bar-bold' },
      { to: '/accounts', label: '账号管理', icon: 'i-ph-users-three-bold' },
      { to: '/groups/accounts?module=commandcode', label: '账号分组', icon: 'i-ph-user-switch-bold' },
      { to: '/official', label: '官方模型与套餐', icon: 'i-ph-book-open-bold' },
      { to: '/models', label: '模型观察', icon: 'i-ph-binoculars-bold' },
      { to: '/logs', label: '请求日志', icon: 'i-ph-list-bullets-bold' },
      { to: '/settings', label: '模块设置', icon: 'i-ph-sliders-horizontal-bold' },
    ],
  },
  {
    id: 'devin2api', name: 'Devin', kind: 'extension', tier: 'module', navLabel: 'Devin 模块', icon: 'i-ph-robot-bold', required: false, defaultEnabled: false, version: '0.1.0',
    description: 'Devin 2API 适配模块，将 Devin 会话映射为标准模型接口。与 CPA 内核自带的 Devin 渠道相互独立。',
    capabilities: ['Responses API', 'Chat Completions', 'Messages API', '账号与令牌', '模型目录', '分组路由', '调用日志'],
    navigation: [
      { to: '/devin2api', label: '模块概览', icon: 'i-ph-robot-bold' },
      { to: '/devin2api?tab=accounts', label: '账号与令牌', icon: 'i-ph-user-list-bold' },
      { to: '/groups/accounts?module=devin2api', label: '账号分组', icon: 'i-ph-address-book-bold' },
      { to: '/devin2api?tab=models', label: '模型目录', icon: 'i-ph-cube-bold' },
      { to: '/devin2api?tab=logs', label: '请求日志', icon: 'i-ph-clipboard-text-bold' },
      { to: '/devin2api?tab=settings', label: '模块设置', icon: 'i-ph-wrench-bold' },
    ],
  },
  {
    id: 'platform', name: '平台管理', kind: 'platform', tier: 'platform', navLabel: '平台', icon: 'i-ph-squares-four-bold', required: true, version: '0.2.0',
    description: '统一管理员登录、模块管理和部署配置。',
    capabilities: ['管理员会话', '模块状态', 'API Key 管理', '持久化设置', '部署与版本适配'],
    navigation: [
      { to: '/', label: '平台概览', icon: 'i-ph-squares-four-bold' },
      { to: '/modules', label: '模块管理', icon: 'i-ph-stack-bold' },
      { to: '/keys', label: 'API Key', icon: 'i-ph-key-bold' },
      { to: '/groups', label: '调用分组', icon: 'i-ph-users-four-bold' },
    ],
  },
]

export function findModule(id: string): ModuleManifest | undefined {
  return MODULE_MANIFESTS.find(module => module.id === id)
}

export function gatedModuleForRequest(path: string, method: string): string | null {
  if (/^\/commandcode\/v1(?:\/|$)/.test(path)) return 'commandcode'
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) &&
      /^\/api\/(?:accounts|external\/accounts)(?:\/|$)/.test(path)) return 'commandcode'
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) &&
      /^\/api\/devin2api(?:\/|$)/.test(path)) return 'devin2api'
  return null
}
