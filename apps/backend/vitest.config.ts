import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    // Load .env before integration tests so DATABASE_URL / TEST_DATABASE_URL are set
    setupFiles: ['./src/__tests__/helpers/env.ts'],
    // Integration tests hit a real database — run sequentially to avoid concurrent
    // resetDatabase calls across test files
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
  resolve: {
    alias: {
      '@tracker/shared': resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
})
