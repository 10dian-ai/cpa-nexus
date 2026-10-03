import { config as loadEnvironment } from 'dotenv'
loadEnvironment({ path: '.env.cpa', quiet: true })
export default defineNuxtConfig({
  compatibilityDate: '2026-09-01',
  devtools: { enabled: false },
  telemetry: false,
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css', '~/assets/css/nexus.css'],
  app: { head: { htmlAttrs: { lang: 'zh-CN' }, title: 'CPA Nexus', link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }], meta: [{ name: 'description', content: '基于 CLIProxyAPI 的模块化 AI 管理平台' }] } },
  ui: { colorMode: false, fonts: false },
  icon: { serverBundle: { collections: ['ph'] }, fallbackToApi: false },
  nitro: { preset: 'node-server', experimental: { tasks: false } },
  typescript: { strict: true },
})
