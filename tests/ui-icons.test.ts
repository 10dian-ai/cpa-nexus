import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { NUXT_UI_ICONS } from '../shared/ui-icons'
import { MODULE_MANIFESTS } from '../shared/modules'
import { buildNavigationGroups } from '../app/composables/useAppNavigation'

// Only the Phosphor collection is bundled and the Iconify API fallback is off
// (nuxt.config.ts), so any other icon name renders as an empty box.
const phosphor = createRequire(import.meta.url)('@iconify-json/ph/icons.json') as { icons: Record<string, unknown>; aliases?: Record<string, unknown> }
const exists = (name: string) => name.startsWith('i-ph-') && (!!phosphor.icons[name.slice(5)] || !!phosphor.aliases?.[name.slice(5)])

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(directory, entry.name))
    : /\.(?:vue|ts)$/.test(entry.name) ? [join(directory, entry.name)] : [])
}

describe('bundled icons', () => {
  it('maps every Nuxt UI built-in icon of the installed version to Phosphor', () => {
    const shared = resolve('node_modules/@nuxt/ui/dist/shared')
    const source = readdirSync(shared).map(name => readFileSync(join(shared, name), 'utf8')).find(text => text.includes('const defaultIcons = {'))
    expect(source, 'Nuxt UI default icon table').toBeTruthy()
    const table = source!.slice(source!.indexOf('const defaultIcons = {'))
    const keys = [...table.slice(0, table.indexOf('};')).matchAll(/^\s+(\w+):\s*"/gm)].map(match => match[1]!)
    expect(keys.length).toBeGreaterThan(30)
    expect(keys.filter(key => !(key in NUXT_UI_ICONS))).toEqual([])
    for (const [key, name] of Object.entries(NUXT_UI_ICONS)) expect(exists(name), key + ' → ' + name).toBe(true)
  })

  it('only references Phosphor icons that exist in the bundled collection', () => {
    const files = [...walk(resolve('app')), ...walk(resolve('shared'))]
    const missing = files.flatMap(file => [...readFileSync(file, 'utf8').matchAll(/i-[a-z]+-[a-z0-9-]+/g)]
      .map(match => match[0]).filter(name => /^i-(?:ph|lucide|heroicons|mdi|tabler|simple-icons)-/.test(name) && !exists(name)).map(name => file + ': ' + name))
    expect(missing).toEqual([])
  })
})

describe('sidebar icons', () => {
  it('never reuses an icon for two different sidebar destinations', () => {
    const enabled = MODULE_MANIFESTS.map(manifest => ({ ...manifest, enabled: true, status: 'ready' as const }))
    const links = buildNavigationGroups(enabled).flatMap(group => group.links)
    const owners = new Map<string, string[]>()
    for (const link of links) owners.set(link.icon, [...owners.get(link.icon) || [], link.label])
    expect([...owners.entries()].filter(([, labels]) => labels.length > 1)).toEqual([])
    expect(new Set(links.map(link => link.to)).size).toBe(links.length)
  })
})
