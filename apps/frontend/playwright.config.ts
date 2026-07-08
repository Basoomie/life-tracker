import { defineConfig, devices } from '@playwright/test'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Load root .env so TEST_USER_EMAIL / TEST_USER_PASSWORD reach process.env.
// These are only set as defaults (existing shell env takes precedence).
try {
  const lines = readFileSync(resolve(__dirname, '../../.env'), 'utf8').split('\n')
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch { /* .env is optional */ }

// E2E tests run against vite preview (built frontend) with the real backend.
// Before running: docker compose up (or backend running at localhost:37801).
// The preview server proxies /api/*, /me, /health to localhost:37801.

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
