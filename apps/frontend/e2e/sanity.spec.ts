import { test, expect } from '@playwright/test'

test('frontend loads and renders the app heading', async ({ page }) => {
  // Mock /me so the auth gate passes and the main app renders (not the login form)
  await page.route('/me', (route) =>
    route.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } })
  )
  await page.route('/api/occurrences/today', (route) => route.fulfill({ json: [] }))
  await page.route('/api/buckets', (route) => route.fulfill({ json: [] }))
  await page.route('/api/categories', (route) => route.fulfill({ json: [] }))
  await page.route('/api/preferences', (route) => route.fulfill({ json: {} }))

  await page.goto('/')
  await expect(page.locator('h1')).toBeVisible()
  await expect(page.locator('h1')).toHaveText('Tracker')
})
