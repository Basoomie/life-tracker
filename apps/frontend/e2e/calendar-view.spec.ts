// §12.4 — Calendar view Playwright tests.
// Named after spec rules. Time injected via page.clock; API mocked via page.route.
// Proportionality is asserted numerically (height ratios), not visually.
//
// All desktop tests scope to data-testid="cal-grid-desktop" to avoid strict-mode violations
// (the same TimeGrid renders in both cal-mobile-only and cal-desktop-only; at desktop viewport
// the desktop one is visible, and scoping ensures uniqueness).

import { test, expect, type Page, type Locator } from '@playwright/test'
import type { OccurrenceWithState } from '@tracker/shared'
import type { Bucket } from '@tracker/shared'

// ── Fixture builders ───────────────────────────────────────────────────────

type MakeOccOverrides = {
  id: string
  itemId: string
  name: string
  appliesToDay?: string
  isBlocked?: boolean
  hasChildren?: boolean
  sortOrder?: number
  loggedMinutes?: number
  snapshot?: Partial<OccurrenceWithState['snapshot']>
  completionState?: Partial<OccurrenceWithState['completionState']>
  disposition?: Partial<OccurrenceWithState['disposition']>
}

function makeOcc(overrides: MakeOccOverrides): OccurrenceWithState {
  const day = overrides.appliesToDay ?? '2025-06-16'
  return {
    id: overrides.id,
    userId: 'u1',
    itemId: overrides.itemId,
    appliesToDay: day,
    materializedAt: `${day}T04:00:00Z` as unknown as null,
    snapshot: {
      name: overrides.name,
      description: null,
      categoryId: null,
      valence: null,
      priority: null,
      recurrenceRule: { type: 'daily' },
      quotaTarget: null,
      timingPrecision: 'none',
      timingBucketId: null,
      timingStartTime: null,
      timingEndTime: null,
      plannedDurationMin: null,
      dispositionPolicy: 'skip',
      parentId: null,
      prerequisiteIds: [],
      ...overrides.snapshot,
    },
    isBlocked: overrides.isBlocked ?? false,
    incompletePrerequisiteIds: [],
    completionState: {
      isLeaf: true,
      completionPercent: 0,
      isComplete: false,
      completedAt: null,
      wasRetroactive: false,
      derivedPercent: null,
      declaredPercent: null,
      ...overrides.completionState,
    },
    disposition: {
      type: 'pending',
      reasonId: null,
      comment: null,
      rescheduledToDay: null,
      derivedPercentAtClose: null,
      ...overrides.disposition,
    },
    hasChildren: overrides.hasChildren ?? false,
    sortOrder: overrides.sortOrder ?? 0,
    loggedMinutes: overrides.loggedMinutes ?? 0,
  } as OccurrenceWithState
}

const MORNING_BUCKET: Bucket = {
  id: 'b-morn', userId: 'u1', name: 'Morning',
  startTime: '08:00', endTime: '12:00', sortOrder: 1, createdAt: new Date() as unknown as Date,
}
const BUCKETS: Bucket[] = [MORNING_BUCKET]

// Day-start: 04:00 (matches design examples)
const DAY_START_ENTRIES = [{ id: 'ds1', userId: 'u1', startsOn: '2020-01-01', value: '04:00', recordedAt: new Date() }]

// Range item: 08:00–09:00 (1h)
const ONE_HOUR = makeOcc({
  id: 'occ-1h', itemId: 'item-1h', name: '1h Task',
  snapshot: { timingPrecision: 'range', timingStartTime: '08:00', timingEndTime: '09:00' },
})

// Range item: 10:00–12:30 (2.5h)
const TWO_HALF_HOUR = makeOcc({
  id: 'occ-2h5', itemId: 'item-2h5', name: '2.5h Task',
  snapshot: { timingPrecision: 'range', timingStartTime: '10:00', timingEndTime: '12:30' },
})

// Day Trading: 04:00–06:30 (at day-start → top of grid)
const TRADING = makeOcc({
  id: 'occ-trading', itemId: 'item-trading', name: 'Day Trading',
  snapshot: { timingPrecision: 'range', timingStartTime: '04:00', timingEndTime: '06:30' },
})

// Point item: 09:00
const POINT_ITEM = makeOcc({
  id: 'occ-call', itemId: 'item-call', name: 'Morning Call',
  snapshot: { timingPrecision: 'point', timingStartTime: '09:00' },
})

// Bucket item: Morning bucket (08:00–12:00)
const BUCKET_ITEM = makeOcc({
  id: 'occ-workout', itemId: 'item-workout', name: 'Workout',
  snapshot: { timingPrecision: 'bucket', timingBucketId: 'b-morn' },
})

// Unscheduled item (none)
const UNSCHEDULED = makeOcc({
  id: 'occ-read', itemId: 'item-read', name: 'Reading',
})

// Two unscheduled root items with explicit manual order, for gutter
// drag-and-drop reorder tests.
const GUTTER_A = makeOcc({
  id: 'occ-gutter-a', itemId: 'item-gutter-a', name: 'Gutter A', sortOrder: 0,
})
const GUTTER_B = makeOcc({
  id: 'occ-gutter-b', itemId: 'item-gutter-b', name: 'Gutter B', sortOrder: 1,
})

// Overlapping ranges: both 08:00–10:00
const OVERLAP_A = makeOcc({
  id: 'occ-ov-a', itemId: 'item-ov-a', name: 'Overlap A',
  snapshot: { timingPrecision: 'range', timingStartTime: '08:00', timingEndTime: '10:00' },
})
const OVERLAP_B = makeOcc({
  id: 'occ-ov-b', itemId: 'item-ov-b', name: 'Overlap B',
  snapshot: { timingPrecision: 'range', timingStartTime: '08:00', timingEndTime: '10:00' },
})

// Unscheduled parent + unscheduled child (both land in the gutter)
const UNSCHEDULED_PARENT = makeOcc({
  id: 'occ-uparent', itemId: 'item-uparent', name: 'Evening Routine',
  completionState: { isLeaf: false, derivedPercent: 0, completionPercent: 0, isComplete: false, completedAt: null, wasRetroactive: false, declaredPercent: null },
  hasChildren: true,
})
const UNSCHEDULED_CHILD = makeOcc({
  id: 'occ-uchild', itemId: 'item-uchild', name: 'Floss',
  snapshot: { parentId: 'item-uparent' },
})

// Scheduled parent (grid block) + unscheduled child (only reachable via the detail panel)
const SCHEDULED_PARENT = makeOcc({
  id: 'occ-sparent', itemId: 'item-sparent', name: 'Morning Routine',
  snapshot: { timingPrecision: 'point', timingStartTime: '04:00' },
  completionState: { isLeaf: false, derivedPercent: 0, completionPercent: 0, isComplete: false, completedAt: null, wasRetroactive: false, declaredPercent: null },
  hasChildren: true,
})
const SCHEDULED_CHILD = makeOcc({
  id: 'occ-schild', itemId: 'item-schild', name: 'Stretching',
  snapshot: { parentId: 'item-sparent' },
})

// Child of Morning Routine that happens to carry its own explicit time —
// should still nest under the parent, never get an independent grid block
const TIMED_CHILD = makeOcc({
  id: 'occ-tchild', itemId: 'item-tchild', name: 'Timed Child',
  snapshot: { parentId: 'item-sparent', timingPrecision: 'range', timingStartTime: '05:00', timingEndTime: '05:30' },
})

async function setupCalApiMocks(
  page: Page,
  occs: OccurrenceWithState[],
  buckets: Bucket[] = BUCKETS,
  dayStartEntries = DAY_START_ENTRIES
) {
  await page.route('/me', (route) =>
    route.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } })
  )
  await page.route(/\/api\/occurrences\?start=.*&end=.*/, (route) =>
    route.fulfill({ json: occs })
  )
  await page.route('/api/buckets',     (route) => route.fulfill({ json: buckets }))
  await page.route('/api/day-start',   (route) => route.fulfill({ json: dayStartEntries }))
  await page.route('/api/categories',  (route) => route.fulfill({ json: [] }))
  await page.route('/api/reasons',     (route) => route.fulfill({ json: [] }))
  await page.route('/api/preferences', (route) => route.fulfill({ json: {} }))
}

async function goToCalendarView(page: Page) {
  await page.route('/me', (r) => r.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } }))
  await page.goto('/')
  await page.getByTestId('view-nav-calendar').click()
  await expect(page.getByTestId('calendar-view')).toBeVisible()
}

// Desktop calendar container (avoids strict-mode duplicate-ID issues with mobile container)
function desktopGrid(page: Page) {
  return page.getByTestId('cal-grid-desktop')
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe('§12.4 — Calendar view', () => {

  test('§12.4 Calendar: 2.5h range block renders ~2.5× the height of a 1h block (proportionality)', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T07:00:00'))
    await setupCalApiMocks(page, [ONE_HOUR, TWO_HALF_HOUR])
    await goToCalendarView(page)

    const grid   = desktopGrid(page)
    const block1h  = grid.getByTestId('cal-block-occ-1h')
    const block2h5 = grid.getByTestId('cal-block-occ-2h5')

    await expect(block1h).toBeVisible()
    await expect(block2h5).toBeVisible()

    // data-height-px is set directly on the element for deterministic assertion
    const h1   = Number(await block1h.getAttribute('data-height-px'))
    const h2h5 = Number(await block2h5.getAttribute('data-height-px'))

    expect(h1).toBeGreaterThan(0)
    expect(h2h5).toBeGreaterThan(0)

    // Ratio should be 2.5 ± 5%
    const ratio = h2h5 / h1
    expect(ratio).toBeGreaterThan(2.4)
    expect(ratio).toBeLessThan(2.6)
  })

  test('§12.4 Calendar: point item renders as a marker block placed at its time on the grid', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T07:00:00'))
    await setupCalApiMocks(page, [POINT_ITEM])
    await goToCalendarView(page)

    const block = desktopGrid(page).getByTestId('cal-block-occ-call')
    await expect(block).toBeVisible()
    await expect(block).toHaveAttribute('data-kind', 'point')

    // Minimum height enforced (≥20px, stored in data-height-px)
    const h = Number(await block.getAttribute('data-height-px'))
    expect(h).toBeGreaterThanOrEqual(20)
  })

  test('§12.4 Calendar: bucketed item floats within its bucket band (not at exact minute)', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T07:00:00'))
    await setupCalApiMocks(page, [BUCKET_ITEM])
    await goToCalendarView(page)

    const block = desktopGrid(page).getByTestId('cal-block-occ-workout')
    await expect(block).toBeVisible()
    await expect(block).toHaveAttribute('data-kind', 'bucket')

    // With day-start 04:00, morning bucket starts at 08:00:
    // fromDayStart('08:00', 240) = 240 min → topPx = (240/1440)*1440 = 240px
    const topPx = Number(await block.getAttribute('data-top-px'))
    expect(topPx).toBeGreaterThanOrEqual(230)
    expect(topPx).toBeLessThanOrEqual(250)
  })

  test('§12.4 Calendar: unscheduled item appears in the gutter, not the time grid', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T07:00:00'))
    await setupCalApiMocks(page, [UNSCHEDULED, ONE_HOUR])
    await goToCalendarView(page)

    // Gutter visible and contains the unscheduled item
    const gutter = desktopGrid(page).getByTestId('cal-gutter-2025-06-16')
    await expect(gutter).toBeVisible()
    await expect(gutter.getByText('Reading')).toBeVisible()

    // Unscheduled item is NOT rendered as a cal-block on the time grid
    await expect(desktopGrid(page).getByTestId('cal-block-occ-read')).not.toBeVisible()

    // The range item IS on the grid
    await expect(desktopGrid(page).getByTestId('cal-block-occ-1h')).toBeVisible()
  })

  test('§12.4 Calendar: two overlapping ranges are both visible side by side', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T07:00:00'))
    await setupCalApiMocks(page, [OVERLAP_A, OVERLAP_B])
    await goToCalendarView(page)

    const grid   = desktopGrid(page)
    const blockA = grid.getByTestId('cal-block-occ-ov-a')
    const blockB = grid.getByTestId('cal-block-occ-ov-b')

    await expect(blockA).toBeVisible()
    await expect(blockB).toBeVisible()

    await blockA.scrollIntoViewIfNeeded()
    const boxA = await blockA.boundingBox()
    const boxB = await blockB.boundingBox()

    expect(boxA).not.toBeNull()
    expect(boxB).not.toBeNull()

    // Both have positive dimensions
    expect(boxA!.width).toBeGreaterThan(10)
    expect(boxB!.width).toBeGreaterThan(10)

    // Side-by-side: horizontal position differs — column-split applied
    expect(Math.abs(boxA!.x - boxB!.x)).toBeGreaterThan(10)
  })

  test('§12.4 Calendar: day-start framing — 04:00 trading block placed near top of grid', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T07:00:00'))
    await setupCalApiMocks(page, [TRADING])
    await goToCalendarView(page)

    const block = desktopGrid(page).getByTestId('cal-block-occ-trading')
    await expect(block).toBeVisible()

    // fromDayStart('04:00', 240) = 0 → topPx = 0
    const topPx = Number(await block.getAttribute('data-top-px'))
    expect(topPx).toBeLessThan(5)
  })

  test('§12.4 Calendar: now-indicator renders on today\'s grid', async ({ page }) => {
    // 2025-06-16T05:30 local; day-start 04:00 → fromDayStart = 90 min → 90px
    await page.clock.setFixedTime(new Date('2025-06-16T05:30:00'))
    await setupCalApiMocks(page, [TRADING])
    await goToCalendarView(page)

    // Now line exists inside the desktop grid
    const nowLine = desktopGrid(page).getByTestId('cal-now-line')
    await expect(nowLine).toBeAttached()

    const top = await nowLine.evaluate((el) =>
      parseFloat((el as HTMLElement).style.top)
    )
    // 90px from top (within grid) — not zero, not full grid height
    expect(top).toBeGreaterThan(0)
    expect(top).toBeLessThan(1440)
  })

  test('§12.4 Calendar: completion action works from a clicked calendar block', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T07:00:00'))
    await setupCalApiMocks(page, [ONE_HOUR])

    const completed: OccurrenceWithState = {
      ...ONE_HOUR,
      completionState: {
        ...ONE_HOUR.completionState,
        isComplete: true,
        completionPercent: 100,
      },
      disposition: { type: 'completed', reasonId: null, comment: null, rescheduledToDay: null, derivedPercentAtClose: null },
    }

    await page.route('/api/occurrences/occ-1h/complete', (route) =>
      route.fulfill({ json: completed })
    )

    await goToCalendarView(page)

    // Click the block to open detail panel
    const grid = desktopGrid(page)
    await grid.getByTestId('cal-block-occ-1h').click()
    await expect(grid.getByTestId('cal-detail-panel')).toBeVisible()

    // Complete via the detail panel's OccurrenceRow
    await grid.getByTestId('cal-detail-panel').getByTestId('occ-check').click()

    // Block acquires done class
    await expect(grid.getByTestId('cal-block-occ-1h')).toHaveClass(/cal-block--done/)
  })

  test('§11 Calendar degrades gracefully on narrow screen — single-day focus at 320px', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T07:00:00'))
    await setupCalApiMocks(page, [ONE_HOUR])

    await page.setViewportSize({ width: 320, height: 568 })
    await goToCalendarView(page)

    // Switch to week range (would be 7 columns on desktop)
    await page.getByTestId('cal-range-select').selectOption('this-week')

    // Mobile nav appears (single-day focus)
    await expect(page.locator('.cal-mobile-nav')).toBeVisible()
    await expect(page.locator('.cal-mobile-only')).toBeVisible()

    // Desktop multi-day grid is hidden on narrow screen
    await expect(page.locator('.cal-desktop-only')).not.toBeVisible()

    // Header doesn't overflow
    const header = await page.locator('.app-header').boundingBox()
    expect(header!.width).toBeLessThanOrEqual(320)

    // Mobile nav next button works
    const nextBtn = page.locator('.cal-mobile-nav').getByRole('button', { name: 'Next day' })
    await expect(nextBtn).toBeVisible()
    await nextBtn.click()

    // Label changes to the next day (non-empty)
    const labelText = await page.locator('.cal-mobile-nav__label').innerText()
    expect(labelText.trim().length).toBeGreaterThan(0)
  })

})

// Not part of the original §12.4 spec — added on direct user request: a
// skipped/excused/carried-forward occurrence must read as visually distinct
// in the grid too, not just in the detail-panel row.
test.describe('Disposition status is visible in the grid (Calendar view)', () => {

  test('a skipped occurrence renders with cal-block--skipped in the day grid', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T07:00:00'))
    const skipped: OccurrenceWithState = {
      ...ONE_HOUR,
      disposition: { type: 'skipped', reasonId: null, comment: null, rescheduledToDay: null, derivedPercentAtClose: null },
    }
    await setupCalApiMocks(page, [skipped])

    await goToCalendarView(page)

    const grid = desktopGrid(page)
    await expect(grid.getByTestId('cal-block-occ-1h')).toHaveClass(/cal-block--skipped/)
  })

  test('the detail panel for a skipped occurrence shows the restore button, not the checkbox', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T07:00:00'))
    const skipped: OccurrenceWithState = {
      ...ONE_HOUR,
      disposition: { type: 'skipped', reasonId: null, comment: null, rescheduledToDay: null, derivedPercentAtClose: null },
    }
    await setupCalApiMocks(page, [skipped])

    await goToCalendarView(page)

    const grid = desktopGrid(page)
    await grid.getByTestId('cal-block-occ-1h').click()
    const panel = grid.getByTestId('cal-detail-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByTestId('occ-check')).toHaveCount(0)
    await expect(panel.getByTestId('occ-restore-btn')).toBeVisible()
  })

})

// Completed item fixture for uncomplete tests
const DONE_OCC = makeOcc({
  id: 'occ-done', itemId: 'item-done', name: 'Completed Task',
  snapshot: { timingPrecision: 'range', timingStartTime: '08:00', timingEndTime: '09:00' },
  completionState: {
    isLeaf: true, completionPercent: 100, isComplete: true,
    completedAt: null, wasRetroactive: false, derivedPercent: null, declaredPercent: null,
  },
  disposition: { type: 'completed', reasonId: null, comment: null, rescheduledToDay: null, derivedPercentAtClose: null },
})

test.describe('§4 — Uncomplete with confirmation (Calendar view)', () => {

  test('§4 clicking checked checkbox in Calendar detail panel shows confirmation modal', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T07:00:00'))
    await setupCalApiMocks(page, [DONE_OCC])
    await goToCalendarView(page)

    const grid = desktopGrid(page)

    // Click the block to open detail panel
    await grid.getByTestId('cal-block-occ-done').click()
    await expect(grid.getByTestId('cal-detail-panel')).toBeVisible()

    // Click the checked (green) checkbox
    await grid.getByTestId('cal-detail-panel').getByTestId('occ-check').click()

    // Confirmation modal appears
    await expect(page.getByTestId('confirm-modal')).toBeVisible()
    await expect(page.getByTestId('confirm-modal')).toContainText('Completed Task')
  })

  test('§4 cancelling uncomplete in Calendar view makes no API call', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T07:00:00'))
    await setupCalApiMocks(page, [DONE_OCC])

    const uncompleteCalls: string[] = []
    await page.route(`/api/occurrences/${DONE_OCC.id}/uncomplete`, (route) => {
      uncompleteCalls.push(route.request().url())
      route.fulfill({ json: DONE_OCC })
    })

    await goToCalendarView(page)

    const grid = desktopGrid(page)
    await grid.getByTestId('cal-block-occ-done').click()
    await grid.getByTestId('cal-detail-panel').getByTestId('occ-check').click()

    await expect(page.getByTestId('confirm-modal')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()

    await expect(page.getByTestId('confirm-modal')).not.toBeVisible()
    expect(uncompleteCalls.length).toBe(0)
  })

  test('§4 confirming uncomplete in Calendar view calls API and reverts block state', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T07:00:00'))

    const uncompletedOcc: OccurrenceWithState = {
      ...DONE_OCC,
      completionState: { ...DONE_OCC.completionState, isComplete: false, completionPercent: 0 },
      disposition: { type: 'pending', reasonId: null, comment: null, rescheduledToDay: null, derivedPercentAtClose: null },
    }

    await setupCalApiMocks(page, [DONE_OCC])
    await page.route(`/api/occurrences/${DONE_OCC.id}/uncomplete`, (route) =>
      route.fulfill({ json: uncompletedOcc })
    )

    await goToCalendarView(page)

    const grid = desktopGrid(page)
    await grid.getByTestId('cal-block-occ-done').click()
    await grid.getByTestId('cal-detail-panel').getByTestId('occ-check').click()

    await expect(page.getByTestId('confirm-modal')).toBeVisible()
    await page.getByTestId('confirm-modal-confirm').click()

    await expect(page.getByTestId('confirm-modal')).not.toBeVisible()
    // Block loses the done class after revert
    await expect(grid.getByTestId('cal-block-occ-done')).not.toHaveClass(/cal-block--done/)
  })

  test('§8 Calendar: unscheduled gutter is collapsible', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T07:00:00'))
    await setupCalApiMocks(page, [UNSCHEDULED, ONE_HOUR])
    await goToCalendarView(page)

    const grid = desktopGrid(page)
    const gutter = grid.getByTestId('cal-gutter-2025-06-16')
    await expect(gutter).toBeVisible()

    // Item visible by default (expanded)
    await expect(gutter.getByText('Reading')).toBeVisible()

    // Click the collapsible header button to collapse
    await gutter.locator('.cal-gutter__header').click()
    await expect(gutter.getByText('Reading')).not.toBeVisible()

    // Click again to expand
    await gutter.locator('.cal-gutter__header').click()
    await expect(gutter.getByText('Reading')).toBeVisible()
  })

})

test.describe('§12.4 — Calendar view custom date picker', () => {

  test('§12.4 Calendar view: picking a custom date fetches that single day and switches the dropdown to Custom', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T07:00:00'))

    const fetchedRanges: string[] = []
    await page.route('/me', (r) => r.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } }))
    await page.route(/\/api\/occurrences\?start=.*&end=.*/, (route) => {
      fetchedRanges.push(route.request().url())
      route.fulfill({ json: [] })
    })
    await page.route('/api/buckets',     (route) => route.fulfill({ json: BUCKETS }))
    await page.route('/api/day-start',   (route) => route.fulfill({ json: DAY_START_ENTRIES }))
    await page.route('/api/categories',  (route) => route.fulfill({ json: [] }))
    await page.route('/api/reasons',     (route) => route.fulfill({ json: [] }))
    await page.route('/api/preferences', (route) => route.fulfill({ json: {} }))

    await goToCalendarView(page)

    const customReq = page.waitForRequest(/\/api\/occurrences\?start=2025-07-04&end=2025-07-04/)
    await page.getByTestId('cal-range-custom-date').fill('2025-07-04')
    await customReq

    await expect(page.getByTestId('cal-range-select')).toHaveValue('custom')
    expect(fetchedRanges.some((u) => u.includes('start=2025-07-04&end=2025-07-04'))).toBe(true)
  })
})

test.describe('§9 — Calendar view state persistence across navigation', () => {

  test('§9 Calendar view range persists after navigating to Now and back', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T07:00:00'))
    await setupCalApiMocks(page, [])
    await goToCalendarView(page)

    await page.getByTestId('cal-range-select').selectOption('this-week')
    await expect(page.getByTestId('cal-range-select')).toHaveValue('this-week')

    await page.getByTestId('view-nav-now').click()
    await page.getByTestId('view-nav-calendar').click()
    await expect(page.getByTestId('calendar-view')).toBeVisible()

    await expect(page.getByTestId('cal-range-select')).toHaveValue('this-week')
  })

  test('§9 Calendar view filters persist after navigating away and back', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T07:00:00'))
    await setupCalApiMocks(page, [ONE_HOUR])
    await goToCalendarView(page)

    await page.getByTestId('cal-toggle-filters').click()
    await page.getByTestId('filter-priority-high').click()
    await expect(page.getByTestId('filter-priority-high')).toHaveAttribute('aria-pressed', 'true')

    await page.getByTestId('view-nav-now').click()
    await page.getByTestId('view-nav-calendar').click()
    await expect(page.getByTestId('calendar-view')).toBeVisible()

    await page.getByTestId('cal-toggle-filters').click()
    await expect(page.getByTestId('filter-priority-high')).toHaveAttribute('aria-pressed', 'true')
  })

})

test.describe('§4 — Calendar complete keeps detail panel open', () => {

  test('§4 completing an item in Calendar detail panel keeps panel open and updates block to done', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T07:00:00'))

    const completedOcc: OccurrenceWithState = {
      ...ONE_HOUR,
      completionState: { ...ONE_HOUR.completionState, isComplete: true, completionPercent: 100 },
      disposition: { type: 'completed', reasonId: null, comment: null, rescheduledToDay: null, derivedPercentAtClose: null },
    }

    await setupCalApiMocks(page, [ONE_HOUR])
    await page.route(`/api/occurrences/${ONE_HOUR.id}/complete`, (route) =>
      route.fulfill({ json: completedOcc })
    )

    await goToCalendarView(page)

    const grid = desktopGrid(page)

    // Click block to open detail panel
    await grid.getByTestId('cal-block-occ-1h').click()
    await expect(grid.getByTestId('cal-detail-panel')).toBeVisible()

    // Click the (unchecked) checkbox to complete
    await grid.getByTestId('cal-detail-panel').getByTestId('occ-check').click()

    // Detail panel stays open (no modal, no close)
    await expect(grid.getByTestId('cal-detail-panel')).toBeVisible()

    // Block gains the done class
    await expect(grid.getByTestId('cal-block-occ-1h')).toHaveClass(/cal-block--done/)
  })

})

test.describe('§5.4 — Calendar complete works for unmaterialized (id=null) recurring occurrences', () => {

  test('§5.4 completing a null-id occurrence calls complete-by-item-day and updates block to done', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T07:00:00'))

    // Occurrence has no stored row yet — id is null
    const nullIdOcc: OccurrenceWithState = {
      ...ONE_HOUR,
      id: null,
      materializedAt: null,
    }

    const completedOcc: OccurrenceWithState = {
      ...ONE_HOUR,
      id: 'occ-materialized',
      completionState: { ...ONE_HOUR.completionState, isComplete: true, completionPercent: 100 },
      disposition: { type: 'completed', reasonId: null, comment: null, rescheduledToDay: null, derivedPercentAtClose: null },
    }

    await setupCalApiMocks(page, [nullIdOcc])

    const calls: string[] = []
    await page.route('/api/occurrences/complete-by-item-day', (route) => {
      calls.push(JSON.stringify(route.request().postDataJSON()))
      route.fulfill({ json: completedOcc })
    })

    await goToCalendarView(page)

    const grid = desktopGrid(page)

    // Block is keyed by itemId when occ.id is null
    await grid.getByTestId(`cal-block-${nullIdOcc.itemId}`).click()
    await expect(grid.getByTestId('cal-detail-panel')).toBeVisible()

    await grid.getByTestId('cal-detail-panel').getByTestId('occ-check').click()

    // complete-by-item-day was called with the correct payload
    expect(calls.length).toBe(1)
    const payload = JSON.parse(calls[0])
    expect(payload.itemId).toBe(nullIdOcc.itemId)
    expect(payload.appliesToDay).toBe(nullIdOcc.appliesToDay)

    // Detail panel stays open
    await expect(grid.getByTestId('cal-detail-panel')).toBeVisible()
  })

})

test.describe('§3 — Archive / delete task (Calendar view)', () => {

  test('§3 delete button in Calendar gutter shows confirmation modal', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T07:00:00'))
    await setupCalApiMocks(page, [UNSCHEDULED])
    await page.route('/api/items/item-read', (route) => route.fulfill({ status: 204, body: '' }))

    await goToCalendarView(page)

    const grid = desktopGrid(page)
    const gutter = grid.getByTestId('cal-gutter-2025-06-16')
    await expect(gutter).toBeVisible()

    const row = gutter.getByTestId('occ-row-occ-read')
    await row.getByTestId('occ-archive-btn').click()

    await expect(page.getByTestId('confirm-modal')).toBeVisible()
    await expect(page.getByTestId('confirm-modal')).toContainText('Reading')
  })

  test('§3 confirming delete in Calendar view calls DELETE and removes the task', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T07:00:00'))
    await page.route('/me', (r) => r.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } }))

    let archived = false
    await page.route(/\/api\/occurrences\?start=.*&end=.*/, (route) =>
      route.fulfill({ json: archived ? [] : [UNSCHEDULED] })
    )
    await page.route('/api/buckets', (route) => route.fulfill({ json: BUCKETS }))
    await page.route('/api/day-start', (route) => route.fulfill({ json: DAY_START_ENTRIES }))
    await page.route('/api/categories', (route) => route.fulfill({ json: [] }))
    await page.route('/api/reasons', (route) => route.fulfill({ json: [] }))
    await page.route('/api/preferences', (route) => route.fulfill({ json: {} }))

    const archiveCalls: string[] = []
    await page.route('/api/items/item-read', (route) => {
      archiveCalls.push(route.request().method())
      archived = true
      route.fulfill({ status: 204, body: '' })
    })

    await goToCalendarView(page)

    const grid = desktopGrid(page)
    const gutter = grid.getByTestId('cal-gutter-2025-06-16')
    const row = gutter.getByTestId('occ-row-occ-read')

    await row.getByTestId('occ-archive-btn').click()
    await expect(page.getByTestId('confirm-modal')).toBeVisible()
    await page.getByTestId('confirm-modal-confirm').click()

    await expect(page.getByTestId('confirm-modal')).not.toBeVisible()
    expect(archiveCalls.length).toBe(1)
    expect(archiveCalls[0]).toBe('DELETE')
    await expect(grid.getByTestId('occ-row-occ-read')).not.toBeVisible()
  })

})

test.describe('§12.4 — Timer is gated to today\'s occurrences; skip/excuse/carry is not', () => {

  test('§12.4 timer is hidden on a non-today day column, shown on today\'s; skip/excuse/carry menu is available on both', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T07:00:00'))

    const todayUnscheduled = makeOcc({ id: 'occ-today', itemId: 'item-today', name: 'Today Task', appliesToDay: '2025-06-16' })
    const futureUnscheduled = makeOcc({ id: 'occ-future', itemId: 'item-future', name: 'Future Task', appliesToDay: '2025-06-18' })

    await setupCalApiMocks(page, [todayUnscheduled, futureUnscheduled])
    await goToCalendarView(page)

    // Switch to "This Week" so both today's and a future day's column render together
    await page.getByTestId('cal-range-select').selectOption('this-week')

    const grid = desktopGrid(page)
    const todayRow = grid.getByTestId('cal-gutter-2025-06-16').getByTestId('occ-row-occ-today')
    const futureRow = grid.getByTestId('cal-gutter-2025-06-18').getByTestId('occ-row-occ-future')

    await expect(todayRow).toBeVisible()
    await expect(futureRow).toBeVisible()

    // Today's row: timer start button + three-dot disposition menu both present
    await expect(todayRow.getByTestId('timer-start')).toBeVisible()
    await expect(todayRow.getByTestId('occ-disposition-btn')).toBeVisible()

    // Future day's row: timer is gated to today, but skip/excuse/carry-forward
    // is a valid action on any day (backend never restricted it to today either) —
    // e.g. skipping/excusing a past occurrence that was never touched.
    await expect(futureRow.getByTestId('timer-start')).not.toBeVisible()
    await expect(futureRow.getByTestId('occ-disposition-btn')).toBeVisible()
  })

  test('§9.1 a non-today occurrence with logged time shows the read-only total, never a play button', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T07:00:00'))

    const futureOcc = makeOcc({
      id: 'occ-future-logged', itemId: 'item-future-logged', name: 'Future Reading',
      appliesToDay: '2025-06-18', loggedMinutes: 45,
    })

    await setupCalApiMocks(page, [futureOcc])
    await goToCalendarView(page)
    await page.getByTestId('cal-range-select').selectOption('this-week')

    const row = desktopGrid(page).getByTestId('cal-gutter-2025-06-18').getByTestId('occ-row-occ-future-logged')
    await expect(row.getByTestId('timer-logged')).toHaveText('45:00')
    await expect(row.getByTestId('timer-start')).not.toBeVisible()
    await expect(row.getByTestId('timer-running')).not.toBeVisible()
  })

})

test.describe('Occurrence nesting — parent/child cards (Calendar view)', () => {

  test('an unscheduled child never renders as its own top-level gutter row', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupCalApiMocks(page, [UNSCHEDULED_PARENT, UNSCHEDULED_CHILD])
    await goToCalendarView(page)

    const grid = desktopGrid(page)
    // Child never gets its own top-level gutter row
    await expect(grid.getByTestId(`occ-row-${UNSCHEDULED_CHILD.id}`)).toHaveCount(0)
    // It's reachable once the parent's card is expanded
    await grid.getByTestId(`occ-card-toggle-${UNSCHEDULED_PARENT.itemId}`).click()
    await expect(grid.getByTestId(`occ-row-${UNSCHEDULED_CHILD.id}`)).toBeVisible()
  })

  test('an unscheduled parent with children renders as a collapsed card in the gutter, same as Now/List', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupCalApiMocks(page, [UNSCHEDULED_PARENT, UNSCHEDULED_CHILD, UNSCHEDULED])
    await goToCalendarView(page)

    const grid = desktopGrid(page)
    const card = grid.getByTestId(`occ-card-${UNSCHEDULED_PARENT.itemId}`)
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute('data-expanded', 'false')
    // A plain leaf occurrence in the gutter is unaffected — no card chrome
    await expect(grid.getByTestId(`occ-card-${UNSCHEDULED.itemId}`)).toHaveCount(0)
    await expect(grid.getByTestId(`occ-row-${UNSCHEDULED.id}`)).toBeVisible()
  })

  test('a parent with hasChildren=true but no children in the fetched range still renders as an expandable card, not a flat leaf row', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    // Only the parent comes back — its children aren't due/materialized for
    // the viewed range. occ.hasChildren (item-level) must still drive the card.
    await setupCalApiMocks(page, [UNSCHEDULED_PARENT])
    await goToCalendarView(page)

    const grid = desktopGrid(page)
    const card = grid.getByTestId(`occ-card-${UNSCHEDULED_PARENT.itemId}`)
    await expect(card).toBeVisible()
    await expect(grid.getByTestId(`occ-card-toggle-${UNSCHEDULED_PARENT.itemId}`)).toBeVisible()
    await expect(grid.getByTestId(`occ-card-progress-${UNSCHEDULED_PARENT.itemId}`)).toHaveText('0/0')
  })

  test("a scheduled parent's children are reachable via the detail panel, expanded by default", async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupCalApiMocks(page, [SCHEDULED_PARENT, SCHEDULED_CHILD])
    await goToCalendarView(page)

    const grid = desktopGrid(page)
    // Parent shows as its own grid block; child never independently appears anywhere yet
    await expect(grid.getByTestId(`cal-block-${SCHEDULED_PARENT.id}`)).toBeVisible()
    await expect(page.getByTestId(`occ-row-${SCHEDULED_CHILD.id}`)).toHaveCount(0)

    await grid.getByTestId(`cal-block-${SCHEDULED_PARENT.id}`).click()

    const panel = page.getByTestId('cal-detail-panel')
    await expect(panel).toBeVisible()
    const panelCard = panel.getByTestId(`occ-card-${SCHEDULED_PARENT.itemId}`)
    await expect(panelCard).toBeVisible()
    // Expanded by default in the panel — no extra click needed
    await expect(panelCard).toHaveAttribute('data-expanded', 'true')
    await expect(panel.getByTestId(`occ-row-${SCHEDULED_CHILD.id}`)).toBeVisible()
  })

  test('a child with its own explicit time still nests under its parent instead of getting an independent grid block', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupCalApiMocks(page, [SCHEDULED_PARENT, TIMED_CHILD])
    await goToCalendarView(page)

    const grid = desktopGrid(page)
    // Only the parent gets a block — the timed child does not get its own
    await expect(grid.getByTestId(`cal-block-${SCHEDULED_PARENT.id}`)).toBeVisible()
    await expect(grid.getByTestId(`cal-block-${TIMED_CHILD.id}`)).toHaveCount(0)

    await grid.getByTestId(`cal-block-${SCHEDULED_PARENT.id}`).click()
    await expect(page.getByTestId('cal-detail-panel').getByTestId(`occ-row-${TIMED_CHILD.id}`)).toBeVisible()
  })

})

// @dnd-kit's PointerSensor listens for pointer events, not HTML5 dragstart/
// dragover — locator.dragTo() won't trigger it. Drive it via raw mouse events
// with an intermediate move past the activation distance instead. Scoped to
// `root` (mobile + desktop both render the same TimeGrid, so an unscoped
// getByTestId hits a strict-mode duplicate — see desktopGrid()).
async function dragHandleTo(page: Page, root: Page | Locator, fromTestId: string, toTestId: string) {
  const from = root.getByTestId(fromTestId)
  const to = root.getByTestId(toTestId)
  const fromBox = (await from.boundingBox())!
  const toBox = (await to.boundingBox())!

  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2 + 8, { steps: 2 })
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height + 4, { steps: 5 })
  await page.mouse.up()
}

test.describe('Manual root reordering (drag-and-drop, unscheduled gutter, Calendar view)', () => {

  test('drag handles appear on gutter items but not on scheduled grid blocks', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupCalApiMocks(page, [ONE_HOUR, GUTTER_A, GUTTER_B])
    await goToCalendarView(page)

    const grid = desktopGrid(page)
    await expect(grid.getByTestId(`root-drag-handle-${GUTTER_A.itemId}`)).toBeVisible()
    await expect(grid.getByTestId(`root-drag-handle-${GUTTER_B.itemId}`)).toBeVisible()
    await expect(grid.getByTestId(`root-drag-handle-${ONE_HOUR.itemId}`)).toHaveCount(0)
  })

  test('dragging a gutter item calls reorder-root with the dropped-after neighbor', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupCalApiMocks(page, [GUTTER_A, GUTTER_B])
    await goToCalendarView(page)

    let reorderBody: { afterItemId: string | null } | null = null
    await page.route(`/api/items/${GUTTER_A.itemId}/reorder-root`, async (route) => {
      reorderBody = route.request().postDataJSON()
      await route.fulfill({ json: [] })
    })

    await dragHandleTo(
      page,
      desktopGrid(page),
      `root-drag-handle-${GUTTER_A.itemId}`,
      `root-drag-handle-${GUTTER_B.itemId}`
    )

    await expect.poll(() => reorderBody).not.toBeNull()
    expect(reorderBody!.afterItemId).toBe(GUTTER_B.itemId)
  })

})
