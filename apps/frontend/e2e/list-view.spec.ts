// §12.3 — List view and §12.5 filter bar Playwright tests.
// Named after spec rules. Time is injected; API is mocked.

import { test, expect, type Page } from '@playwright/test'
import type { OccurrenceWithState } from '@tracker/shared'
import type { Bucket } from '@tracker/shared'

// ── Fixture builders ───────────────────────────────────────────────────────

type MakeOccOverrides = {
  id: string
  itemId: string
  name: string
  appliesToDay?: string
  isBlocked?: boolean
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
    hasChildren: false,
  } as OccurrenceWithState
}

const BUCKETS: Bucket[] = [
  { id: 'b-morn', userId: 'u1', name: 'Morning', startTime: '08:00', endTime: '12:00', sortOrder: 1, createdAt: new Date() as unknown as Date },
]

// Occurrences with different timing for sort ordering tests
const EARLY_RANGE = makeOcc({
  id: 'occ-trading', itemId: 'item-trading', name: 'Day Trading',
  snapshot: { timingPrecision: 'range', timingStartTime: '04:00', timingEndTime: '06:30' },
})
const LATE_POINT = makeOcc({
  id: 'occ-call', itemId: 'item-call', name: 'Afternoon Call',
  snapshot: { timingPrecision: 'point', timingStartTime: '14:00' },
})
const BUCKET_OCC = makeOcc({
  id: 'occ-workout', itemId: 'item-workout', name: 'Workout',
  snapshot: { timingPrecision: 'bucket', timingBucketId: 'b-morn' },
})
const UNSCHEDULED = makeOcc({
  id: 'occ-read', itemId: 'item-read', name: 'Reading',
  // timingPrecision: 'none' (default)
})

const HIGH_OCC = makeOcc({
  id: 'occ-high', itemId: 'item-high', name: 'High Priority Task',
  snapshot: { priority: 'high' },
})
const MEDIUM_OCC = makeOcc({
  id: 'occ-med', itemId: 'item-med', name: 'Medium Priority Task',
  snapshot: { priority: 'medium' },
})
const LOW_OCC = makeOcc({
  id: 'occ-low', itemId: 'item-low', name: 'Low Priority Task',
  snapshot: { priority: 'low' },
})
const DONE_OCC = makeOcc({
  id: 'occ-done', itemId: 'item-done', name: 'Completed Task',
  completionState: {
    isLeaf: true, completionPercent: 100, isComplete: true,
    completedAt: null, wasRetroactive: false, derivedPercent: null, declaredPercent: null,
  },
  disposition: { type: 'completed', reasonId: null, comment: null, rescheduledToDay: null, derivedPercentAtClose: null },
})

async function setupApiMocks(
  page: Page,
  todayOccs: OccurrenceWithState[],
  buckets: Bucket[] = BUCKETS
) {
  // Mock range endpoint (used by List view)
  await page.route(/\/api\/occurrences\?start=.*&end=.*/, (route) =>
    route.fulfill({ json: todayOccs })
  )
  await page.route('/api/occurrences/today', (route) => route.fulfill({ json: todayOccs }))
  await page.route('/api/buckets',     (route) => route.fulfill({ json: buckets }))
  await page.route('/api/day-start',   (route) => route.fulfill({ json: [] }))
  await page.route('/api/categories',  (route) => route.fulfill({ json: [] }))
  await page.route('/api/reasons',     (route) => route.fulfill({ json: [] }))
  await page.route('/api/preferences', (route) => route.fulfill({ json: {} }))
}

async function goToListView(page: Page) {
  await page.goto('/')
  await page.getByTestId('view-nav-list').click()
  await expect(page.getByTestId('list-view')).toBeVisible()
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe('§12.3 — List view', () => {

  test('§12.3 List view: default sort places timing items before unscheduled, early before late', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, [UNSCHEDULED, LATE_POINT, EARLY_RANGE, BUCKET_OCC])
    await goToListView(page)

    // All items visible
    await expect(page.getByText('Day Trading')).toBeVisible()
    await expect(page.getByText('Workout')).toBeVisible()
    await expect(page.getByText('Afternoon Call')).toBeVisible()
    await expect(page.getByText('Reading')).toBeVisible()

    // Ordering: early range (04:00) → bucket morning (08:00) → late point (14:00) → unscheduled
    const rows = page.locator('.occ-row')
    const names = await rows.allInnerTexts()
    const joined = names.join('|')
    const tradingIdx = joined.indexOf('Day Trading')
    const workoutIdx = joined.indexOf('Workout')
    const callIdx    = joined.indexOf('Afternoon Call')
    const readIdx    = joined.indexOf('Reading')
    expect(tradingIdx).toBeLessThan(workoutIdx)
    expect(workoutIdx).toBeLessThan(callIdx)
    expect(callIdx).toBeLessThan(readIdx)
  })

  test('§12.3 List view: unscheduled items appear at the bottom in default sort', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, [UNSCHEDULED, EARLY_RANGE])
    await goToListView(page)

    const rows = page.locator('.occ-row')
    const names = await rows.allInnerTexts()
    const joined = names.join('|')
    expect(joined.indexOf('Day Trading')).toBeLessThan(joined.indexOf('Reading'))
  })

  test('§12.3 List view: priority-flip regroups into High / Med / Low groups', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, [HIGH_OCC, MEDIUM_OCC, LOW_OCC, UNSCHEDULED])
    await goToListView(page)

    // Default: no priority groups visible
    await expect(page.getByTestId('priority-group-high')).not.toBeVisible()

    // Enable priority flip
    await page.getByTestId('priority-flip-toggle').click()

    await expect(page.getByTestId('list-priority-view')).toBeVisible()
    await expect(page.getByTestId('priority-group-high')).toBeVisible()
    await expect(page.getByTestId('priority-group-medium')).toBeVisible()
    await expect(page.getByTestId('priority-group-low')).toBeVisible()

    // High group contains the high-priority item
    await expect(page.getByTestId('priority-group-high').getByText('High Priority Task')).toBeVisible()
    await expect(page.getByTestId('priority-group-medium').getByText('Medium Priority Task')).toBeVisible()
    await expect(page.getByTestId('priority-group-low').getByText('Low Priority Task')).toBeVisible()
  })

  test('§12.3 List view: priority-flip is view state only — no data mutation', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, [HIGH_OCC, MEDIUM_OCC])

    const mutationCalls: string[] = []
    await page.route('**/api/**', (route) => {
      const method = route.request().method()
      if (method !== 'GET') mutationCalls.push(`${method} ${route.request().url()}`)
      route.continue()
    })

    await goToListView(page)

    // Toggle priority flip multiple times
    await page.getByTestId('priority-flip-toggle').click()
    await page.getByTestId('priority-flip-toggle').click()
    await page.getByTestId('priority-flip-toggle').click()

    // No non-GET calls should have been made for the toggle
    const flipMutations = mutationCalls.filter((c) => !c.includes('preferences'))
    expect(flipMutations.length).toBe(0)
  })

  test('§12.3 List view: range switch refetches occurrences for the new range', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))

    const fetchedRanges: string[] = []
    await page.route(/\/api\/occurrences\?start=.*&end=.*/, (route) => {
      fetchedRanges.push(route.request().url())
      route.fulfill({ json: [] })
    })
    await page.route('/api/occurrences/today', (route) => route.fulfill({ json: [] }))
    await page.route('/api/buckets',     (route) => route.fulfill({ json: [] }))
    await page.route('/api/day-start',   (route) => route.fulfill({ json: [] }))
    await page.route('/api/categories',  (route) => route.fulfill({ json: [] }))
    await page.route('/api/reasons',     (route) => route.fulfill({ json: [] }))
    await page.route('/api/preferences', (route) => route.fulfill({ json: {} }))

    await page.goto('/')
    await page.getByTestId('view-nav-list').click()

    // Switch to "This Week" — wait for the range fetch before proceeding
    const weekReq = page.waitForRequest(/\/api\/occurrences\?start=/)
    await page.getByTestId('range-select').selectOption('this-week')
    await weekReq

    // Switch to "This Month" — wait for the range fetch before proceeding
    const monthReq = page.waitForRequest(/\/api\/occurrences\?start=/)
    await page.getByTestId('range-select').selectOption('this-month')
    await monthReq

    // Each range switch should have triggered a new fetch
    const weekFetch  = fetchedRanges.some((u) => u.includes('start=') && u.includes('&end='))
    expect(weekFetch).toBe(true)
    // At least 2 range fetches (week + month)
    expect(fetchedRanges.length).toBeGreaterThanOrEqual(2)

    // No two consecutive fetches have the same start+end (ranges differ)
    if (fetchedRanges.length >= 2) {
      expect(fetchedRanges[0]).not.toBe(fetchedRanges[fetchedRanges.length - 1])
    }
  })

  // ── Filter bar (§12.5) ─────────────────────────────────────────────────

  test('§12.5 Filter: priority filter narrows to matching items only', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, [HIGH_OCC, MEDIUM_OCC, LOW_OCC, UNSCHEDULED])
    await goToListView(page)

    // Open filters
    await page.getByTestId('toggle-filters').click()
    await expect(page.getByTestId('filter-bar')).toBeVisible()

    // Select "High" priority filter
    await page.getByTestId('filter-priority-high').click()
    await expect(page.getByTestId('filter-priority-high')).toHaveAttribute('aria-pressed', 'true')

    // Only high-priority item visible
    await expect(page.getByText('High Priority Task')).toBeVisible()
    await expect(page.getByText('Medium Priority Task')).not.toBeVisible()
    await expect(page.getByText('Low Priority Task')).not.toBeVisible()
    await expect(page.getByText('Reading')).not.toBeVisible()
  })

  test('§12.5 Filter: completion-state filter shows only complete or only incomplete', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, [HIGH_OCC, DONE_OCC])
    await goToListView(page)

    await page.getByTestId('toggle-filters').click()

    // Filter to "Done"
    await page.getByTestId('filter-completion-complete').click()
    await expect(page.getByText('Completed Task')).toBeVisible()
    await expect(page.getByText('High Priority Task')).not.toBeVisible()

    // Switch to "Todo"
    await page.getByTestId('filter-completion-incomplete').click()
    await expect(page.getByText('High Priority Task')).toBeVisible()
    await expect(page.getByText('Completed Task')).not.toBeVisible()
  })

  test('§12.5 Filter: combining two filters applies AND logic', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    // high+incomplete, high+done, medium+incomplete
    const highDone = makeOcc({
      id: 'occ-hi-done', itemId: 'item-hi-done', name: 'High Done',
      snapshot: { priority: 'high' },
      completionState: { isLeaf: true, completionPercent: 100, isComplete: true, completedAt: null, wasRetroactive: false, derivedPercent: null, declaredPercent: null },
      disposition: { type: 'completed', reasonId: null, comment: null, rescheduledToDay: null, derivedPercentAtClose: null },
    })
    await setupApiMocks(page, [HIGH_OCC, highDone, MEDIUM_OCC])
    await goToListView(page)

    await page.getByTestId('toggle-filters').click()
    await page.getByTestId('filter-priority-high').click()
    await page.getByTestId('filter-completion-incomplete').click()

    // Only high + incomplete survives both filters (AND)
    await expect(page.getByText('High Priority Task')).toBeVisible()
    await expect(page.getByText('High Done')).not.toBeVisible()
    await expect(page.getByText('Medium Priority Task')).not.toBeVisible()
  })

  test('§12.5 Filter: filters are view state — no mutation when toggling filters', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, [HIGH_OCC, MEDIUM_OCC])

    const mutations: string[] = []
    await page.route('**/api/**', (route) => {
      if (route.request().method() !== 'GET') mutations.push(route.request().url())
      route.continue()
    })

    await goToListView(page)
    await page.getByTestId('toggle-filters').click()
    await page.getByTestId('filter-priority-high').click()
    await page.getByTestId('filter-priority-medium').click()
    await page.getByTestId('filter-completion-complete').click()

    // No non-GET calls from filter interactions
    const filterMutations = mutations.filter((u) => !u.includes('preferences'))
    expect(filterMutations.length).toBe(0)
  })

  test('§11 List view is usable at phone width (320px)', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, [EARLY_RANGE, UNSCHEDULED])

    await page.setViewportSize({ width: 320, height: 568 })
    await page.goto('/')
    await page.getByTestId('view-nav-list').click()

    await expect(page.getByTestId('list-view')).toBeVisible()
    // Header doesn't overflow
    const header = await page.locator('.app-header').boundingBox()
    expect(header!.width).toBeLessThanOrEqual(320)
    // View nav visible
    await expect(page.locator('.view-nav')).toBeVisible()
  })

})

test.describe('§4 — Uncomplete with confirmation (List view)', () => {

  test('§4 clicking checked checkbox in List view shows confirmation modal', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, [DONE_OCC])
    await goToListView(page)

    const doneRow = page.getByTestId(`occ-row-${DONE_OCC.id}`)
    await expect(doneRow).toBeVisible()

    await doneRow.getByTestId('occ-check').click()

    await expect(page.getByTestId('confirm-modal')).toBeVisible()
    await expect(page.getByTestId('confirm-modal')).toContainText(DONE_OCC.snapshot.name)
  })

  test('§4 cancelling uncomplete in List view makes no API call', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, [DONE_OCC])

    const uncompleteCalls: string[] = []
    await page.route(`/api/occurrences/${DONE_OCC.id}/uncomplete`, (route) => {
      uncompleteCalls.push(route.request().url())
      route.fulfill({ json: DONE_OCC })
    })

    await goToListView(page)
    await page.getByTestId(`occ-row-${DONE_OCC.id}`).getByTestId('occ-check').click()
    await expect(page.getByTestId('confirm-modal')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()

    await expect(page.getByTestId('confirm-modal')).not.toBeVisible()
    expect(uncompleteCalls.length).toBe(0)
  })

  test('§4 confirming uncomplete in List view calls API and reverts item state', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))

    const uncompletedOcc: OccurrenceWithState = {
      ...DONE_OCC,
      completionState: { ...DONE_OCC.completionState, isComplete: false, completionPercent: 0 },
      disposition: { type: 'pending', reasonId: null, comment: null, rescheduledToDay: null, derivedPercentAtClose: null },
    }

    await setupApiMocks(page, [DONE_OCC])
    await page.route(`/api/occurrences/${DONE_OCC.id}/uncomplete`, (route) =>
      route.fulfill({ json: uncompletedOcc })
    )

    await goToListView(page)
    await page.getByTestId(`occ-row-${DONE_OCC.id}`).getByTestId('occ-check').click()
    await expect(page.getByTestId('confirm-modal')).toBeVisible()
    await page.getByTestId('confirm-modal-confirm').click()

    await expect(page.getByTestId('confirm-modal')).not.toBeVisible()
    // Item reverted — checkbox is no longer checked
    const row = page.getByTestId(`occ-row-${DONE_OCC.id}`)
    await expect(row.getByTestId('occ-check')).not.toHaveClass(/occ-check--checked/)
  })

})

test.describe('§9 — List view state persistence across navigation', () => {

  test('§9 List view range persists after navigating to Now and back', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, [])

    await goToListView(page)

    // Change range to "This Week"
    await page.getByTestId('range-select').selectOption('this-week')
    await expect(page.getByTestId('range-select')).toHaveValue('this-week')

    // Navigate away to Now, then back to List
    await page.getByTestId('view-nav-now').click()
    await page.getByTestId('view-nav-list').click()
    await expect(page.getByTestId('list-view')).toBeVisible()

    // Range should be restored
    await expect(page.getByTestId('range-select')).toHaveValue('this-week')
  })

  test('§9 List view priority-flip toggle persists after navigating away and back', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, [HIGH_OCC, MEDIUM_OCC])

    await goToListView(page)

    // Enable priority flip by clicking the label
    await page.getByTestId('priority-flip-toggle').click()
    await expect(page.getByTestId('list-priority-view')).toBeVisible()

    // Navigate away and back
    await page.getByTestId('view-nav-now').click()
    await page.getByTestId('view-nav-list').click()
    await expect(page.getByTestId('list-view')).toBeVisible()

    // Priority view should still be active
    await expect(page.getByTestId('list-priority-view')).toBeVisible()
  })

  test('§9 List view filters persist after navigating away and back', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, [HIGH_OCC, MEDIUM_OCC])

    await goToListView(page)

    // Open filters and select "High" priority
    await page.getByTestId('toggle-filters').click()
    await page.getByTestId('filter-priority-high').click()
    await expect(page.getByTestId('filter-priority-high')).toHaveAttribute('aria-pressed', 'true')

    // Navigate away and back
    await page.getByTestId('view-nav-now').click()
    await page.getByTestId('view-nav-list').click()
    await expect(page.getByTestId('list-view')).toBeVisible()

    // Open filters again — high should still be active
    await page.getByTestId('toggle-filters').click()
    await expect(page.getByTestId('filter-priority-high')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByText('Medium Priority Task')).not.toBeVisible()
  })

  test('§9 Filter Reset button appears when filters are non-default and resets to default', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, [HIGH_OCC, MEDIUM_OCC])

    await goToListView(page)
    await page.getByTestId('toggle-filters').click()

    // Reset not shown at default state
    await expect(page.getByTestId('filter-reset')).not.toBeVisible()

    // Apply a filter
    await page.getByTestId('filter-priority-high').click()
    await expect(page.getByTestId('filter-reset')).toBeVisible()

    // Click reset
    await page.getByTestId('filter-reset').click()

    // All filters back to default, reset button gone
    await expect(page.getByTestId('filter-priority-high')).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByTestId('filter-reset')).not.toBeVisible()
  })

})

test.describe('§3 — Archive / delete task (List view)', () => {

  test('§3 delete button in List view shows confirmation modal', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, [UNSCHEDULED])
    await page.route('/api/items/item-read', (route) => route.fulfill({ status: 204, body: '' }))

    await goToListView(page)

    const row = page.getByTestId('occ-row-occ-read')
    await expect(row).toBeVisible()
    await row.getByTestId('occ-archive-btn').click()

    await expect(page.getByTestId('confirm-modal')).toBeVisible()
    await expect(page.getByTestId('confirm-modal')).toContainText('Reading')
  })

  test('§3 confirming delete in List view calls DELETE and removes the task', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))

    let archived = false
    await page.route(/\/api\/occurrences\?start=.*&end=.*/, (route) =>
      route.fulfill({ json: archived ? [] : [UNSCHEDULED] })
    )
    await page.route('/api/occurrences/today', (route) => route.fulfill({ json: [UNSCHEDULED] }))
    await page.route('/api/buckets', (route) => route.fulfill({ json: BUCKETS }))
    await page.route('/api/day-start', (route) => route.fulfill({ json: [] }))
    await page.route('/api/categories', (route) => route.fulfill({ json: [] }))
    await page.route('/api/reasons', (route) => route.fulfill({ json: [] }))
    await page.route('/api/preferences', (route) => route.fulfill({ json: {} }))

    const archiveCalls: string[] = []
    await page.route('/api/items/item-read', (route) => {
      archiveCalls.push(route.request().method())
      archived = true
      route.fulfill({ status: 204, body: '' })
    })

    await goToListView(page)

    const row = page.getByTestId('occ-row-occ-read')
    await row.getByTestId('occ-archive-btn').click()
    await expect(page.getByTestId('confirm-modal')).toBeVisible()
    await page.getByTestId('confirm-modal-confirm').click()

    await expect(page.getByTestId('confirm-modal')).not.toBeVisible()
    expect(archiveCalls.length).toBe(1)
    expect(archiveCalls[0]).toBe('DELETE')
    await expect(page.getByTestId('occ-row-occ-read')).not.toBeVisible()
  })

})
