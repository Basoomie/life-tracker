import { test, expect } from '@playwright/test'

test('frontend loads and renders the app heading', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('h1')).toBeVisible()
  await expect(page.locator('h1')).toHaveText('Tracker')
})
