// §13.1 — E2E auth tests.
// These tests require the backend to be running with a bootstrapped user.
// Set TEST_USER_EMAIL and TEST_USER_PASSWORD env vars to the bootstrap credentials.

import { test, expect } from '@playwright/test'

const TEST_EMAIL    = process.env.TEST_USER_EMAIL    ?? 'admin@tracker.local'
const TEST_PASSWORD = process.env.TEST_USER_PASSWORD ?? 'change_me_on_first_login'

test('§13.1 login screen is shown on first access when unauthenticated', async ({ page }) => {
  // Clear any existing session cookies
  await page.context().clearCookies()

  await page.goto('/')

  // Login form should be visible
  await expect(page.locator('[data-testid="login-email"]')).toBeVisible()
  await expect(page.locator('[data-testid="login-password"]')).toBeVisible()
  await expect(page.locator('[data-testid="login-submit"]')).toBeVisible()
})

test('§13.1 successful login reaches the main app', async ({ page }) => {
  await page.context().clearCookies()
  await page.goto('/')

  await page.fill('[data-testid="login-email"]', TEST_EMAIL)
  await page.fill('[data-testid="login-password"]', TEST_PASSWORD)
  await page.click('[data-testid="login-submit"]')

  // After login, the main app header should appear
  await expect(page.locator('h1')).toBeVisible()
  await expect(page.locator('h1')).toContainText('Tracker')
  await expect(page.locator('[data-testid="logout-btn"]')).toBeVisible()
})

test('§13.1 wrong password shows error and stays on login screen', async ({ page }) => {
  await page.context().clearCookies()
  await page.goto('/')

  await page.fill('[data-testid="login-email"]', TEST_EMAIL)
  await page.fill('[data-testid="login-password"]', 'definitely_wrong_password_xyz')
  await page.click('[data-testid="login-submit"]')

  await expect(page.locator('[data-testid="login-error"]')).toBeVisible()
  await expect(page.locator('[data-testid="login-email"]')).toBeVisible()  // still on login
})

test('§13.1 logout returns to the login screen', async ({ page }) => {
  await page.context().clearCookies()
  await page.goto('/')

  // Login
  await page.fill('[data-testid="login-email"]', TEST_EMAIL)
  await page.fill('[data-testid="login-password"]', TEST_PASSWORD)
  await page.click('[data-testid="login-submit"]')
  await expect(page.locator('[data-testid="logout-btn"]')).toBeVisible()

  // Logout
  await page.click('[data-testid="logout-btn"]')

  // Should return to login screen
  await expect(page.locator('[data-testid="login-email"]')).toBeVisible()
})

test('§13.1 unauthenticated direct API call is rejected', async ({ request }) => {
  const res = await request.get('/api/occurrences?start=2025-01-15&end=2025-01-15')
  expect(res.status()).toBe(401)
})
