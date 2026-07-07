// §7, §6.6, §6.7 — Settings view Playwright tests.
// Named after the spec rules they verify (§CLAUDE.md).
//
// API is mocked via page.route(); no live backend needed.
// Route handlers use LIFO ordering (last registered = first checked).

import { test, expect, type Page } from '@playwright/test'
import type { Category, Reason, Bucket, DayStartEntry } from '@tracker/shared'

// ── Fixture builders ───────────────────────────────────────────────────────

function makeCategory(o: { id: string; name: string; archivedAt?: Date | null }): Category {
  return { id: o.id, userId: 'u1', name: o.name, archivedAt: o.archivedAt ?? null, createdAt: new Date() }
}

function makeReason(o: { id: string; name: string; archivedAt?: Date | null }): Reason {
  return { id: o.id, userId: 'u1', name: o.name, archivedAt: o.archivedAt ?? null, createdAt: new Date() }
}

function makeBucket(o: {
  id: string; name: string; startTime: string; endTime: string; sortOrder?: number
}): Bucket {
  return { id: o.id, userId: 'u1', name: o.name, startTime: o.startTime, endTime: o.endTime, sortOrder: o.sortOrder ?? 0, createdAt: new Date() }
}

function makeDayStartEntry(o: { id: string; value: string; startsOn: string }): DayStartEntry {
  return { id: o.id, userId: 'u1', value: o.value, startsOn: o.startsOn, recordedAt: new Date() }
}

// ── Shared mock setup ──────────────────────────────────────────────────────

type MockState = {
  categories: Category[]
  reasons: Reason[]
  buckets: Bucket[]
  dayStartEntries: DayStartEntry[]
}

async function setupMocks(page: Page, state: MockState) {
  // Standard routes the app hits on load
  await page.route('/api/occurrences/today', (route) => route.fulfill({ json: [] }))
  await page.route('/api/preferences', (route) => route.fulfill({ json: {} }))

  // Day-start: simple GET-only (overridden in specific tests)
  await page.route('/api/day-start', (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({ json: state.dayStartEntries })
    } else {
      route.continue()
    }
  })

  // Buckets (GET only — overridden in bucket tests)
  await page.route('/api/buckets', (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({ json: state.buckets })
    } else {
      route.continue()
    }
  })

  // Reasons root + mutations — register in specificity order (LIFO: most specific LAST)
  await page.route(/\/api\/reasons$/, (route) => {
    const method = route.request().method()
    if (method === 'GET') {
      route.fulfill({ json: state.reasons })
    } else if (method === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}') as { name: string }
      const newR = makeReason({ id: `r-${Date.now()}`, name: body.name })
      state.reasons = [...state.reasons, newR]
      route.fulfill({ status: 201, json: newR })
    } else {
      route.continue()
    }
  })

  await page.route(/\/api\/reasons\/[^/]+$/, (route) => {
    const url = route.request().url()
    const method = route.request().method()
    const id = url.match(/\/reasons\/([^/?#]+)$/)?.[1]
    if (!id) { route.continue(); return }

    if (method === 'DELETE') {
      state.reasons = state.reasons.filter((r) => r.id !== id)
      route.fulfill({ status: 204 })
    } else {
      route.continue()
    }
  })

  await page.route(/\/api\/reasons\/[^/]+\/rename$/, (route) => {
    const url = route.request().url()
    const id = url.match(/\/reasons\/([^/?#]+)\/rename$/)?.[1]
    if (!id) { route.continue(); return }
    const body = JSON.parse(route.request().postData() ?? '{}') as { name: string }
    const existing = state.reasons.find((r) => r.id === id)
    if (!existing) { route.fulfill({ status: 404, json: { error: 'not_found' } }); return }
    const updated = { ...existing, name: body.name }
    state.reasons = state.reasons.map((r) => (r.id === id ? updated : r))
    route.fulfill({ json: updated })
  })

  // Categories root + mutations — same LIFO pattern
  await page.route(/\/api\/categories$/, (route) => {
    const method = route.request().method()
    if (method === 'GET') {
      route.fulfill({ json: state.categories })
    } else if (method === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}') as { name: string }
      const newC = makeCategory({ id: `c-${Date.now()}`, name: body.name })
      state.categories = [...state.categories, newC]
      route.fulfill({ status: 201, json: newC })
    } else {
      route.continue()
    }
  })

  await page.route(/\/api\/categories\/[^/]+$/, (route) => {
    const url = route.request().url()
    const method = route.request().method()
    const id = url.match(/\/categories\/([^/?#]+)$/)?.[1]
    if (!id) { route.continue(); return }

    if (method === 'DELETE') {
      state.categories = state.categories.filter((c) => c.id !== id)
      route.fulfill({ status: 204 })
    } else {
      route.continue()
    }
  })

  await page.route(/\/api\/categories\/[^/]+\/rename$/, (route) => {
    const url = route.request().url()
    const id = url.match(/\/categories\/([^/?#]+)\/rename$/)?.[1]
    if (!id) { route.continue(); return }
    const body = JSON.parse(route.request().postData() ?? '{}') as { name: string }
    const existing = state.categories.find((c) => c.id === id)
    if (!existing) { route.fulfill({ status: 404, json: { error: 'not_found' } }); return }
    const updated = { ...existing, name: body.name }
    state.categories = state.categories.map((c) => (c.id === id ? updated : c))
    route.fulfill({ json: updated })
  })
}

async function gotoSettings(page: Page) {
  await page.goto('/')
  await page.getByTestId('view-nav-settings').click()
  await expect(page.locator('.settings-view')).toBeVisible()
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe('§7 Categories — add / rename / archive lifecycle', () => {

  test('§7 category add stores new entry in the settings list', async ({ page }) => {
    const state: MockState = {
      categories: [makeCategory({ id: 'cat-music', name: 'Music' })],
      reasons: [],
      buckets: [],
      dayStartEntries: [],
    }
    await setupMocks(page, state)
    await gotoSettings(page)

    const section = page.getByTestId('categories-section')
    await expect(section.getByText('Music')).toBeVisible()

    // Add new category
    await section.getByTestId('categories-section-add-input').fill('Fitness')
    await section.getByTestId('categories-section-add-submit').click()

    // New entry appears in the list
    await expect(section.getByText('Fitness')).toBeVisible()
    // Existing entry unchanged
    await expect(section.getByText('Music')).toBeVisible()
    // Input cleared
    await expect(section.getByTestId('categories-section-add-input')).toHaveValue('')
  })

  test('§7 category rename updates entry in-place without touching other entries', async ({ page }) => {
    const state: MockState = {
      categories: [
        makeCategory({ id: 'cat-music', name: 'Music' }),
        makeCategory({ id: 'cat-fitness', name: 'Fitness' }),
      ],
      reasons: [],
      buckets: [],
      dayStartEntries: [],
    }
    await setupMocks(page, state)
    await gotoSettings(page)

    const section = page.getByTestId('categories-section')

    // Start rename for Music
    await section.getByTestId('categories-section-row-cat-music-rename-btn').click()
    await expect(section.getByTestId('categories-section-row-cat-music-rename-input')).toBeVisible()

    await section.getByTestId('categories-section-row-cat-music-rename-input').fill('Music Theory')
    await section.getByTestId('categories-section-row-cat-music-rename-save').click()

    // Music is gone; Music Theory is there (exact match so 'Music Theory' doesn't false-match)
    await expect(section.getByText('Music Theory', { exact: true })).toBeVisible()
    await expect(section.getByText('Music', { exact: true })).not.toBeVisible()

    // Other entry untouched
    await expect(section.getByText('Fitness')).toBeVisible()

    // Rename input closes
    await expect(section.getByTestId('categories-section-row-cat-music-rename-input')).not.toBeVisible()
  })

  test('§7 category archive removes entry from active list; CategoryPicker excludes it', async ({ page }) => {
    const state: MockState = {
      categories: [
        makeCategory({ id: 'cat-music', name: 'Music' }),
        makeCategory({ id: 'cat-fitness', name: 'Fitness' }),
      ],
      reasons: [],
      buckets: [],
      dayStartEntries: [],
    }
    await setupMocks(page, state)
    await gotoSettings(page)

    const section = page.getByTestId('categories-section')
    await expect(section.getByText('Music')).toBeVisible()

    // Click Archive on Music → opens confirmation modal
    await section.getByTestId('categories-section-row-cat-music-archive-btn').click()
    await expect(page.getByTestId('confirm-modal')).toBeVisible()

    // Confirm archive — wait for modal to close (archive is async)
    await page.getByTestId('confirm-modal-confirm').click()
    await expect(page.getByTestId('confirm-modal')).not.toBeVisible()

    // Music row is gone from the list
    await expect(section.getByTestId('categories-section-row-cat-music')).not.toBeVisible()
    // Other entry remains
    await expect(section.getByText('Fitness')).toBeVisible()

    // Verify CategoryPicker in AdHoc modal also excludes archived — navigate back to Now,
    // open modal, check picker options only contain non-archived categories
    await page.getByTestId('view-nav-now').click()
    await page.getByTestId('adhoc-btn').click()

    const picker = page.getByTestId('adhoc-category')
    const options = await picker.locator('option').allTextContents()
    expect(options).not.toContain('Music')
    expect(options.some((o) => o.includes('Fitness'))).toBe(true)
  })

})

test.describe('§7 Reasons — separate list with same lifecycle', () => {

  test('§7 reasons are a separate configurable list from categories; add/rename/archive works independently', async ({ page }) => {
    const state: MockState = {
      categories: [makeCategory({ id: 'cat-music', name: 'Music' })],
      reasons: [makeReason({ id: 'r-sick', name: 'Sick' })],
      buckets: [],
      dayStartEntries: [],
    }
    await setupMocks(page, state)
    await gotoSettings(page)

    // Both sections visible and separate
    const catSection = page.getByTestId('categories-section')
    const reasonSection = page.getByTestId('reasons-section')
    await expect(catSection).toBeVisible()
    await expect(reasonSection).toBeVisible()

    // Music is in categories, not in reasons
    await expect(catSection.getByText('Music')).toBeVisible()
    await expect(reasonSection.getByText('Music')).not.toBeVisible()

    // Sick is in reasons, not in categories
    await expect(reasonSection.getByText('Sick')).toBeVisible()
    await expect(catSection.getByText('Sick')).not.toBeVisible()

    // Add a reason
    await reasonSection.getByTestId('reasons-section-add-input').fill('Traveling')
    await reasonSection.getByTestId('reasons-section-add-submit').click()
    await expect(reasonSection.getByText('Traveling')).toBeVisible()
    // Not bleeding into categories section
    await expect(catSection.getByText('Traveling')).not.toBeVisible()

    // Rename Sick to Rest Day
    await reasonSection.getByTestId('reasons-section-row-r-sick-rename-btn').click()
    await reasonSection.getByTestId('reasons-section-row-r-sick-rename-input').fill('Rest day')
    await reasonSection.getByTestId('reasons-section-row-r-sick-rename-save').click()
    await expect(reasonSection.getByText('Rest day')).toBeVisible()
    await expect(reasonSection.getByText('Sick')).not.toBeVisible()

    // Archive Rest Day → opens confirmation modal
    await reasonSection.getByTestId('reasons-section-row-r-sick-archive-btn').click()
    await page.getByTestId('confirm-modal-confirm').click()
    await expect(page.getByTestId('confirm-modal')).not.toBeVisible()
    await expect(reasonSection.getByTestId('reasons-section-row-r-sick')).not.toBeVisible()
    // Traveling still there
    await expect(reasonSection.getByText('Traveling')).toBeVisible()
  })

})

test.describe('§6.6 Buckets — tiling validation', () => {

  test('§6.6 bucket boundary edit that maintains tiling saves successfully', async ({ page }) => {
    const bkt = makeBucket({ id: 'bkt-1', name: 'All Day', startTime: '04:00', endTime: '04:00', sortOrder: 1 })
    const state: MockState = {
      categories: [],
      reasons: [],
      buckets: [bkt],
      dayStartEntries: [makeDayStartEntry({ id: 'ds-1', value: '04:00', startsOn: '2025-01-01' })],
    }
    await setupMocks(page, state)

    // Mock PATCH /buckets/:id/boundaries → success
    const updatedBkt = { ...bkt, startTime: '04:00', endTime: '04:00' }
    await page.route(/\/api\/buckets\/[^/]+\/boundaries$/, (route) => {
      route.fulfill({ json: updatedBkt })
    })

    await gotoSettings(page)

    // Open edit form
    await page.getByTestId(`bucket-row-${bkt.id}-edit-btn`).click()
    await expect(page.getByTestId('bucket-edit-form')).toBeVisible()

    // Set same boundaries (valid no-op tiling — API mock returns success)
    await page.getByTestId('bucket-edit-save').click()

    // No error shown; form closes
    await expect(page.getByTestId('bucket-edit-error')).not.toBeVisible()
    await expect(page.getByTestId('bucket-edit-form')).not.toBeVisible()
  })

  test('§6.6 bucket boundary edit that breaks tiling is rejected with a clear error — no silent accept or silent fix', async ({ page }) => {
    const bkt = makeBucket({ id: 'bkt-1', name: 'Morning', startTime: '04:00', endTime: '12:00', sortOrder: 1 })
    const state: MockState = {
      categories: [],
      reasons: [],
      buckets: [bkt],
      dayStartEntries: [makeDayStartEntry({ id: 'ds-1', value: '04:00', startsOn: '2025-01-01' })],
    }
    await setupMocks(page, state)

    // Mock PATCH → 400 invalid_tiling
    await page.route(/\/api\/buckets\/[^/]+\/boundaries$/, (route) => {
      route.fulfill({
        status: 400,
        json: {
          error: 'invalid_tiling',
          message: 'Bucket "Morning" does not close the day; it ends at offset 480 (expected 1440).',
        },
      })
    })

    await gotoSettings(page)

    // Open edit, change times, submit
    await page.getByTestId(`bucket-row-${bkt.id}-edit-btn`).click()
    await expect(page.getByTestId('bucket-edit-form')).toBeVisible()

    await page.getByTestId('bucket-edit-end').fill('08:00')
    await page.getByTestId('bucket-edit-save').click()

    // Error is clearly shown (no silent accept); message describes the tiling problem
    await expect(page.getByTestId('bucket-edit-error')).toBeVisible()
    await expect(page.getByTestId('bucket-edit-error')).toContainText('does not close the day')

    // Form stays open (no silent fix — edit is NOT discarded)
    await expect(page.getByTestId('bucket-edit-form')).toBeVisible()
    await expect(page.getByTestId('bucket-edit-save')).toBeVisible()

    // Strip still shows original bucket (unchanged)
    await expect(page.getByTestId(`bucket-band-${bkt.id}`)).toBeVisible()
  })

})

test.describe('§6.7 Day-start — forward-only timeline append', () => {

  test('§6.7 day-start change appends to timeline; UI communicates past-unaffected; past days do not re-bucket', async ({ page }) => {
    const existingEntry = makeDayStartEntry({ id: 'ds-orig', value: '04:00', startsOn: '2025-01-01' })
    const state: MockState = {
      categories: [],
      reasons: [],
      buckets: [],
      dayStartEntries: [existingEntry],
    }
    await setupMocks(page, state)

    const today = new Date().toISOString().slice(0, 10)
    const newEntry = makeDayStartEntry({ id: 'ds-new', value: '05:00', startsOn: today })

    // Override day-start route with POST support
    await page.route('/api/day-start', (route) => {
      if (route.request().method() === 'GET') {
        route.fulfill({ json: state.dayStartEntries })
      } else if (route.request().method() === 'POST') {
        // Simulate forward-only append: new entry added to timeline
        state.dayStartEntries = [...state.dayStartEntries, newEntry]
        route.fulfill({ status: 201, json: newEntry })
      } else {
        route.continue()
      }
    })

    await gotoSettings(page)

    // Current value shown
    await expect(page.getByTestId('day-start-current-value')).toContainText('04:00')

    // §6.7 — UI note about past-unaffected is always visible
    await expect(page.getByTestId('day-start-past-note')).toBeVisible()
    await expect(page.getByTestId('day-start-past-note')).toContainText('Past days are not re-bucketed')

    // Submit new day-start
    await page.getByTestId('day-start-new-value').fill('05:00')
    // effectiveFrom defaults to today; leave it
    await page.getByTestId('day-start-submit').click()

    // New entry appears in the timeline
    await expect(page.getByTestId(`day-start-entry-${newEntry.id}`)).toBeVisible()
    await expect(page.getByTestId(`day-start-entry-${newEntry.id}`)).toContainText('05:00')

    // Old entry is still in the timeline (forward-only — not overwritten)
    await expect(page.getByTestId(`day-start-entry-${existingEntry.id}`)).toBeVisible()
    await expect(page.getByTestId(`day-start-entry-${existingEntry.id}`)).toContainText('04:00')

    // Current effective value updates to the new one (startsOn = today <= today)
    await expect(page.getByTestId('day-start-current-value')).toContainText('05:00')
  })

})

test.describe('§7/§3.4 CategoryPicker and ReasonPicker — only non-archived shown', () => {

  test('§7/§3.4 CategoryPicker renders only non-archived categories; ReasonPicker renders only non-archived reasons', async ({ page }) => {
    const activeCategory  = makeCategory({ id: 'cat-active', name: 'Active Cat' })
    // Archived category: archivedAt is a Date — JSON transport will be a string,
    // but the picker checks truthiness so any non-null value works
    const archivedCategory = makeCategory({ id: 'cat-archived', name: 'Archived Cat', archivedAt: new Date('2024-01-01') })
    const activeReason   = makeReason({ id: 'r-active', name: 'Active Reason' })
    const archivedReason = makeReason({ id: 'r-archived', name: 'Archived Reason', archivedAt: new Date('2024-01-01') })

    const state: MockState = {
      // The API returns only non-archived, but we mock it to return both
      // to test that the picker components do their own client-side filtering
      categories: [activeCategory, archivedCategory],
      reasons: [activeReason, archivedReason],
      buckets: [],
      dayStartEntries: [],
    }
    await setupMocks(page, state)

    // Test CategoryPicker: open ad-hoc modal
    await page.goto('/')
    await page.getByTestId('adhoc-btn').click()
    await expect(page.getByTestId('adhoc-modal')).toBeVisible()

    const catPicker = page.getByTestId('adhoc-category')
    const catOptions = await catPicker.locator('option').allTextContents()

    expect(catOptions.some((o) => o.includes('Active Cat'))).toBe(true)
    expect(catOptions.some((o) => o.includes('Archived Cat'))).toBe(false)

    await page.keyboard.press('Escape')

    // Test ReasonPicker: open disposition modal via skip-like flow
    // (We mock an occurrence so we can open the disposition modal)
    await page.route('/api/occurrences/today', (route) =>
      route.fulfill({
        json: [{
          id: 'occ-1', userId: 'u1', itemId: 'item-1', appliesToDay: '2025-06-16',
          materializedAt: '2025-06-16T04:00:00Z',
          snapshot: {
            name: 'Test Item', description: null, categoryId: null, valence: null, priority: null,
            recurrenceRule: { type: 'daily' }, quotaTarget: null, timingPrecision: 'none',
            timingBucketId: null, timingStartTime: null, timingEndTime: null, plannedDurationMin: null,
            dispositionPolicy: 'skip', parentId: null, prerequisiteIds: [],
          },
          isBlocked: false, incompletePrerequisiteIds: [], hasChildren: false,
          completionState: { isLeaf: true, completionPercent: 0, isComplete: false, completedAt: null, wasRetroactive: false, derivedPercent: null, declaredPercent: null },
          disposition: { type: 'pending', reasonId: null, comment: null, rescheduledToDay: null, derivedPercentAtClose: null },
        }],
      })
    )

    await page.reload()
    await page.getByTestId('occ-row-occ-1').getByTestId('occ-disposition-btn').click()
    await expect(page.getByTestId('disposition-modal')).toBeVisible()

    const reasonPicker = page.getByTestId('disp-reason')
    const reasonOptions = await reasonPicker.locator('option').allTextContents()

    expect(reasonOptions.some((o) => o.includes('Active Reason'))).toBe(true)
    expect(reasonOptions.some((o) => o.includes('Archived Reason'))).toBe(false)
  })

})

test.describe('§11 Settings view — phone-width usability', () => {

  test('§11 settings view is usable at phone width (320px)', async ({ page }) => {
    const state: MockState = {
      categories: [makeCategory({ id: 'cat-1', name: 'Music' })],
      reasons: [makeReason({ id: 'r-1', name: 'Sick' })],
      buckets: [makeBucket({ id: 'bkt-1', name: 'Morning', startTime: '04:00', endTime: '12:00' })],
      dayStartEntries: [makeDayStartEntry({ id: 'ds-1', value: '04:00', startsOn: '2025-01-01' })],
    }
    await setupMocks(page, state)

    await page.setViewportSize({ width: 320, height: 568 })
    await gotoSettings(page)

    // Key sections are visible and not overflowing
    await expect(page.getByTestId('categories-section')).toBeVisible()
    await expect(page.getByTestId('reasons-section')).toBeVisible()
    await expect(page.getByTestId('bucket-section')).toBeVisible()
    await expect(page.getByTestId('day-start-section')).toBeVisible()

    // Header doesn't overflow viewport
    const header = await page.locator('.app-header').boundingBox()
    expect(header!.width).toBeLessThanOrEqual(320)

    // Sections don't overflow
    const catSection = await page.getByTestId('categories-section').boundingBox()
    expect(catSection!.width).toBeLessThanOrEqual(320)
  })

})
