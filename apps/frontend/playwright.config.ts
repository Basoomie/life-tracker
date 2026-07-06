import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:4173',
  },
  // Starts `vite preview` (serves the already-built dist/) before running tests.
  // Run `npm run test:e2e` which does `vite build && playwright test` so dist/ exists.
  webServer: {
    command: 'npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
  },
})
