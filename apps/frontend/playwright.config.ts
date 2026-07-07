import { defineConfig, devices } from '@playwright/test'

// E2E tests run against vite preview (built frontend) with the real backend.
// Before running: docker compose up (or backend running at localhost:3000).
// The preview server proxies /api/* and /health to localhost:3000.

export default defineConfig({
  testDir: './e2e',
  timeout: 15_000,
  retries: 0,  // §CLAUDE.md: flaky tests are defects; no retries to paper over them
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:4173',
    // Inject a stable test date for deterministic tier calculations
    // (overridden per-test via page.clock.setFixedTime() where needed)
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run build && npm run preview',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
