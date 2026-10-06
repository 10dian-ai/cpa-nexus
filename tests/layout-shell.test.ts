import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('default application shell', () => {
  it('registers nested sidebar and topbar components explicitly', async () => {
    const source = await readFile(resolve('app/layouts/default.vue'), 'utf8')

    // Nuxt 4 path-prefixes components in `components/layout` (for example,
    // `LayoutAppSidebar`). The layout uses the shorter names, so these imports
    // are required; unresolved component tags otherwise become empty comments
    // in SSR and remove the entire navigation shell without an exception.
    expect(source).toContain("import AppSidebar from '~/components/layout/AppSidebar.vue'")
    expect(source).toContain("import AppTopbar from '~/components/layout/AppTopbar.vue'")
    expect(source).toMatch(/<AppSidebar\s/)
    expect(source).toMatch(/<AppTopbar\s/)
  })
})
