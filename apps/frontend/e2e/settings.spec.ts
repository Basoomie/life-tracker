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
  await page.route('/me', (route) =>
    route.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } })
  )
  // Standard routes the app hits on load
  await page.route(/\/api\/occurrences\?start=.*&end=.*/, (route) => route.fulfill({ json: [] }))
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

// The seeded five-bucket set, tiling the 04:00 → 04:00 window (§6.6).
function seededBuckets(): Bucket[] {
  return [
    makeBucket({ id: 'bkt-em', name: 'Early Morning', startTime: '04:00', endTime: '09:00', sortOrder: 1 }),
    makeBucket({ id: 'bkt-mo', name: 'Morning',       startTime: '09:00', endTime: '12:00', sortOrder: 2 }),
    makeBucket({ id: 'bkt-af', name: 'Afternoon',     startTime: '12:00', endTime: '17:00', sortOrder: 3 }),
    makeBucket({ id: 'bkt-ev', name: 'Evening',       startTime: '17:00', endTime: '22:00', sortOrder: 4 }),
    makeBucket({ id: 'bkt-ni', name: 'Night',         startTime: '22:00', endTime: '04:00', sortOrder: 5 }),
  ]
}

test.describe('§6.6 Buckets — boundaries are edited as seams', () => {

  test('§6.6 moving a seam moves both adjacent buckets in one edit', async ({ page }) => {
    const state: MockState = {
      categories: [],
      reasons: [],
      buckets: seededBuckets(),
      dayStartEntries: [makeDayStartEntry({ id: 'ds-1', value: '04:00', startsOn: '2025-01-01' })],
    }
    await setupMocks(page, state)

    // The API applies the move to both neighbours and returns the whole set.
    await page.route(/\/api\/buckets\/[^/]+\/seam$/, (route) => {
      route.fulfill({
        json: seededBuckets().map((b) => {
          if (b.id === 'bkt-em') return { ...b, endTime: '10:00' }
          if (b.id === 'bkt-mo') return { ...b, startTime: '10:00' }
          return b
        }),
      })
    })

    await gotoSettings(page)

    await page.getByTestId('bucket-seam-bkt-em-edit-btn').click()
    await expect(page.getByTestId('bucket-seam-form')).toBeVisible()
    await page.getByTestId('bucket-seam-time').fill('10:00')
    await page.getByTestId('bucket-seam-save').click()

    await expect(page.getByTestId('bucket-seam-form')).not.toBeVisible()
    // Both sides of the seam show the new time — the pair moved together.
    await expect(page.getByTestId('bucket-row-bkt-em')).toContainText('04:00 → 10:00')
    await expect(page.getByTestId('bucket-row-bkt-mo')).toContainText('10:00 → 12:00')
    await expect(page.getByTestId('bucket-seam-bkt-em')).toContainText('10:00')
  })

  test('§6.6 the day-boundary seam is shown but not editable here', async ({ page }) => {
    const state: MockState = {
      categories: [],
      reasons: [],
      buckets: seededBuckets(),
      dayStartEntries: [makeDayStartEntry({ id: 'ds-1', value: '04:00', startsOn: '2025-01-01' })],
    }
    await setupMocks(page, state)
    await gotoSettings(page)

    // Night's seam sits at 04:00 — the day-start — so it carries no Edit control.
    await expect(page.getByTestId('bucket-seam-day-boundary')).toBeVisible()
    await expect(page.getByTestId('bucket-seam-bkt-ni-edit-btn')).toHaveCount(0)
    // Interior seams remain editable.
    await expect(page.getByTestId('bucket-seam-bkt-em-edit-btn')).toBeVisible()
  })

  test('§6.6 a rejected seam move shows the error and keeps the form open — no silent accept or silent fix', async ({ page }) => {
    const state: MockState = {
      categories: [],
      reasons: [],
      buckets: seededBuckets(),
      dayStartEntries: [makeDayStartEntry({ id: 'ds-1', value: '04:00', startsOn: '2025-01-01' })],
    }
    await setupMocks(page, state)

    await page.route(/\/api\/buckets\/[^/]+\/seam$/, (route) => {
      route.fulfill({
        status: 400,
        json: {
          error: 'invalid_seam',
          message:
            'The seam between "Early Morning" and "Morning" must fall strictly between ' +
            '04:00 and 12:00 — the span those two buckets share. Got 18:00.',
        },
      })
    })

    await gotoSettings(page)

    await page.getByTestId('bucket-seam-bkt-em-edit-btn').click()
    await page.getByTestId('bucket-seam-time').fill('18:00')
    await page.getByTestId('bucket-seam-save').click()

    await expect(page.getByTestId('bucket-seam-error')).toBeVisible()
    await expect(page.getByTestId('bucket-seam-error')).toContainText('must fall strictly between')
    // Form stays open (no silent fix) and the stored boundary is unchanged.
    await expect(page.getByTestId('bucket-seam-form')).toBeVisible()
    await expect(page.getByTestId('bucket-row-bkt-em')).toContainText('04:00 → 09:00')
  })

  test('§6.6 a bucket set that no longer covers the day is flagged, and its wrap seam is editable', async ({ page }) => {
    // The reported defect's state: buckets anchored at 04:00, day-start now 03:00.
    const state: MockState = {
      categories: [],
      reasons: [],
      buckets: seededBuckets(),
      dayStartEntries: [makeDayStartEntry({ id: 'ds-1', value: '03:00', startsOn: '2025-01-01' })],
    }
    await setupMocks(page, state)
    await gotoSettings(page)

    await expect(page.getByTestId('bucket-tiling-warning')).toBeVisible()
    await expect(page.getByTestId('bucket-tiling-warning')).toContainText('the day starts at 03:00')

    // Because the 04:00 seam is no longer the day boundary, it can be moved back —
    // that is the repair path out of the drifted state.
    await expect(page.getByTestId('bucket-seam-day-boundary')).toHaveCount(0)
    await expect(page.getByTestId('bucket-seam-bkt-ni-edit-btn')).toBeVisible()
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

    // Local calendar date — matches DayStartSection's todayStr() (see date-range.ts),
    // not UTC, so this agrees with what the <input type="date"> min/value actually is.
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const newEntry = makeDayStartEntry({ id: 'ds-new', value: '05:00', startsOn: today })

    // Override day-start route with POST support
    await page.route('/api/day-start', (route) => {
      if (route.request().method() === 'GET') {
        route.fulfill({ json: state.dayStartEntries })
      } else if (route.request().method() === 'POST') {
        // Simulate forward-only append: new entry added to timeline. §6.7 — the
        // response also carries the (here unchanged) bucket set.
        state.dayStartEntries = [...state.dayStartEntries, newEntry]
        route.fulfill({
          status: 201,
          json: { entry: newEntry, buckets: state.buckets, reanchor: { status: 'no-buckets', changed: [] } },
        })
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

  test('§6.7 the bucket consequences of a day-start change are shown before it is applied', async ({ page }) => {
    const state: MockState = {
      categories: [],
      reasons: [],
      buckets: seededBuckets(),
      dayStartEntries: [makeDayStartEntry({ id: 'ds-1', value: '04:00', startsOn: '2025-01-01' })],
    }
    await setupMocks(page, state)
    await gotoSettings(page)

    await page.getByTestId('day-start-new-value').fill('03:00')

    const preview = page.getByTestId('day-start-reanchor-preview')
    await expect(preview).toBeVisible()
    await expect(preview).toContainText('Early Morning')
    await expect(preview).toContainText('03:00 → 09:00')
    await expect(preview).toContainText('Night')
    await expect(preview).toContainText('22:00 → 03:00')
    await expect(preview).toContainText('Every other bucket boundary stays where it is')
  })

  test('§6.7 a day-start that would split a non-edge bucket is called out before submitting', async ({ page }) => {
    const state: MockState = {
      categories: [],
      reasons: [],
      buckets: seededBuckets(),
      dayStartEntries: [makeDayStartEntry({ id: 'ds-1', value: '04:00', startsOn: '2025-01-01' })],
    }
    await setupMocks(page, state)
    await gotoSettings(page)

    await page.getByTestId('day-start-new-value').fill('10:00')

    const blocked = page.getByTestId('day-start-reanchor-blocked')
    await expect(blocked).toBeVisible()
    await expect(blocked).toContainText('falls inside bucket "Morning"')
  })

  test('§6.7 applying a day-start change re-anchors the buckets in the list', async ({ page }) => {
    const state: MockState = {
      categories: [],
      reasons: [],
      buckets: seededBuckets(),
      dayStartEntries: [makeDayStartEntry({ id: 'ds-1', value: '04:00', startsOn: '2025-01-01' })],
    }
    await setupMocks(page, state)

    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const newEntry = makeDayStartEntry({ id: 'ds-reanchor', value: '03:00', startsOn: today })
    const reanchored = seededBuckets().map((b) => {
      if (b.id === 'bkt-em') return { ...b, startTime: '03:00' }
      if (b.id === 'bkt-ni') return { ...b, endTime: '03:00' }
      return b
    })

    await page.route('/api/day-start', (route) => {
      if (route.request().method() === 'GET') {
        route.fulfill({ json: state.dayStartEntries })
      } else if (route.request().method() === 'POST') {
        state.dayStartEntries = [...state.dayStartEntries, newEntry]
        route.fulfill({
          status: 201,
          json: {
            entry: newEntry,
            buckets: reanchored,
            reanchor: { status: 'moved', changed: reanchored.filter((b) => b.id === 'bkt-em' || b.id === 'bkt-ni') },
          },
        })
      } else {
        route.continue()
      }
    })

    await gotoSettings(page)
    await page.getByTestId('day-start-new-value').fill('03:00')
    await page.getByTestId('day-start-submit').click()

    // The edge buckets followed the day-start; the set covers the day again.
    await expect(page.getByTestId('bucket-row-bkt-em')).toContainText('03:00 → 09:00')
    await expect(page.getByTestId('bucket-row-bkt-ni')).toContainText('22:00 → 03:00')
    await expect(page.getByTestId('bucket-tiling-warning')).toHaveCount(0)
    // Interior boundaries are untouched.
    await expect(page.getByTestId('bucket-row-bkt-mo')).toContainText('09:00 → 12:00')
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
    await page.route(/\/api\/occurrences\?start=.*&end=.*/, (route) =>
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
