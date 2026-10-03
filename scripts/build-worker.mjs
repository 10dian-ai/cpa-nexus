import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
await mkdir('.worker', { recursive: true })
await build({ entryPoints: { index: 'worker/index.ts', migrate: 'scripts/migrate.ts' }, outdir: '.worker', outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', sourcemap: true })
