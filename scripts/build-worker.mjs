import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
await mkdir('.worker', { recursive: true })
await build({ entryPoints: { index: 'worker/index.ts', migrate: 'scripts/migrate.ts', 'setup-native-cpa': 'scripts/setup-native-cpa.mjs' }, outdir: '.worker', outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', sourcemap: true })
