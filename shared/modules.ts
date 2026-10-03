export interface ModuleNavigation { to: string; label: string; icon: string }
export interface ModuleManifest {
  id: string
  name: string
  description: string
  kind: 'kernel' | 'extension' | 'platform'
  required: boolean
  defaultEnabled?: boolean
  version: string
  capabilities: string[]
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
    id: 'cpa', name: 'CPA 核心', kind: 'kernel', required: true, version: 'v8',
    description: '统一模型调用入口，管理原生渠道、凭证、配置与插件。',
    capabilities: ['原生模型入口', '渠道与凭证', 'OAuth 登录', '配置与路由', '日志与插件'],
    navigation: [{ to: '/cpa', label: 'CPA 核心', icon: 'i-ph-cpu-bold' }],
  },
  {
    id: 'commandcode', name: 'CommandCode', kind: 'extension', required: false, version: '0.2.0',
    description: 'GOAT 官方 API 账号池，保留真实额度、会话亲和与并发控制。',
    capabilities: ['官方 API', '官网目录与套餐', 'Cookie 保活', '真实额度', '并发与会话', '调用日志'],
    navigation: [
      { to: '/commandcode', label: '账号池概览', icon: 'i-ph-chart-bar-bold' },
      { to: '/accounts', label: '账号管理', icon: 'i-ph-users-three-bold' },
      { to: '/official', label: '官方模型与套餐', icon: 'i-ph-globe-bold' },
      { to: '/models', label: '模型权限', icon: 'i-ph-cube-bold' },
      { to: '/keys', label: '模块密钥', icon: 'i-ph-key-bold' },
      { to: '/logs', label: '模块日志', icon: 'i-ph-list-bullets-bold' },
    ],
  },
  {
    id: 'presets', name: '酒馆预设', kind: 'extension', required: false, defaultEnabled: false, version: '0.1.0',
    description: '导入、编辑酒馆 JSON 预设，为模块和账号选择请求处理路由。',
    capabilities: ['JSON 导入与导出', '提示词编排', '采样参数', '模块与账号路由'],
    navigation: [{ to: '/presets', label: '酒馆预设', icon: 'i-ph-sliders-horizontal-bold' }],
  },
  {
    id: 'platform', name: '平台管理', kind: 'platform', required: true, version: '0.2.0',
    description: '统一管理员登录、模块管理和部署配置。',
    capabilities: ['管理员会话', '模块状态', '持久化设置', '部署与版本适配'],
    navigation: [{ to: '/modules', label: '模块管理', icon: 'i-ph-stack-bold' }],
  },
]

export function findModule(id: string): ModuleManifest | undefined {
  return MODULE_MANIFESTS.find(module => module.id === id)
}

export function gatedModuleForRequest(path: string, method: string): string | null {
  if (/^(?:\/commandcode)?\/v1(?:\/|$)/.test(path)) return 'commandcode'
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) &&
      /^\/api\/(?:accounts|external\/accounts)(?:\/|$)/.test(path)) return 'commandcode'
  return null
}
