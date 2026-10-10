import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  resolve: { alias: { '#shared': fileURLToPath(new URL('./shared', import.meta.url)).replaceAll('\\', '/') } },
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 15000, fileParallelism: false },
})
