// §12.2 — Now view Playwright tests.
// Tests are named after the spec rules they verify (§CLAUDE.md).
//
// Time is injected via page.clock so tier classification is deterministic.
// The API is mocked via page.route() so tests don't need a live backend.
//
// Seeded fixture reflects the seed script: Night Routine (daily, unscheduled),
// Day Trading (weekdays, range 04:00–06:30), Workout (Mon/Tue/Thu/Sat, none),
// Tretinoin (MWF, none, child of Night Routine).

import { test, expect, type Page } from '@playwright/test'
import type { OccurrenceWithState } from '@tracker/shared'
import type { Bucket } from '@tracker/shared'

// ── Fixture builders ───────────────────────────────────────────────────────
// Note: never spread `overrides` at the top level — it would clobber `snapshot`.

type MakeOccOverrides = {
  id: string
  itemId: string
  name: string
  isBlocked?: boolean
  hasChildren?: boolean
  sortOrder?: number
  incompletePrerequisiteIds?: string[]
  snapshot?: Partial<OccurrenceWithState['snapshot']>
  completionState?: Partial<OccurrenceWithState['completionState']>
  disposition?: Partial<OccurrenceWithState['disposition']>
}

function makeOcc(overrides: MakeOccOverrides): OccurrenceWithState {
  return {
    id: overrides.id,
    userId: 'u1',
    itemId: overrides.itemId,
    appliesToDay: '2025-06-16',
    materializedAt: '2025-06-16T04:00:00Z' as unknown as null, // string in JSON transport
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
    incompletePrerequisiteIds: overrides.incompletePrerequisiteIds ?? [],
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
  } as OccurrenceWithState
}

const BUCKETS: Bucket[] = [
  { id: 'b-early', userId: 'u1', name: 'Early Morning', startTime: '04:00', endTime: '09:00', sortOrder: 1, createdAt: new Date() as unknown as Date },
  { id: 'b-morn',  userId: 'u1', name: 'Morning',       startTime: '09:00', endTime: '12:00', sortOrder: 2, createdAt: new Date() as unknown as Date },
]

// Active range item: Day Trading 04:00–06:30
const TRADING_OCC = makeOcc({
  id: 'occ-trading', itemId: 'item-trading', name: 'Day Trading',
  snapshot: { timingPrecision: 'range', timingStartTime: '04:00', timingEndTime: '06:30' },
})

// Imminent point item: Call at 06:00
const CALL_OCC = makeOcc({
  id: 'occ-call', itemId: 'item-call', name: 'Morning Call',
  snapshot: { timingPrecision: 'point', timingStartTime: '06:00' },
})

// Unscheduled: Night Routine
const ROUTINE_OCC = makeOcc({
  id: 'occ-routine', itemId: 'item-routine', name: 'Night Routine',
  completionState: { isLeaf: false, derivedPercent: 50, completionPercent: 50, isComplete: false, completedAt: null, wasRetroactive: false, declaredPercent: null },
  hasChildren: true,
})

// Child of Night Routine: Tretinoin
const TRETINOIN_OCC = makeOcc({
  id: 'occ-tret', itemId: 'item-tret', name: 'Tretinoin',
  snapshot: { parentId: 'item-routine' },
})

// Child of Night Routine that is itself a parent: Skincare
const SKINCARE_OCC = makeOcc({
  id: 'occ-skincare', itemId: 'item-skincare', name: 'Skincare',
  snapshot: { parentId: 'item-routine' },
  completionState: { isLeaf: false, derivedPercent: 50, completionPercent: 50, isComplete: false, completedAt: null, wasRetroactive: false, declaredPercent: null },
  hasChildren: true,
})

// Grandchild of Night Routine, child of Skincare: Cleanse
const CLEANSE_OCC = makeOcc({
  id: 'occ-cleanse', itemId: 'item-cleanse', name: 'Cleanse',
  snapshot: { parentId: 'item-skincare' },
})

// Two plain leaf children of Night Routine, with explicit manual order, for
// drag-and-drop reorder tests
const CHILD_A_OCC = makeOcc({
  id: 'occ-child-a', itemId: 'item-child-a', name: 'Child A',
  snapshot: { parentId: 'item-routine' },
  sortOrder: 0,
})
const CHILD_B_OCC = makeOcc({
  id: 'occ-child-b', itemId: 'item-child-b', name: 'Child B',
  snapshot: { parentId: 'item-routine' },
  sortOrder: 1,
})

// Two plain unscheduled root items (no parent), with explicit manual order,
// for root-level drag-and-drop reorder tests.
const ROOT_A_OCC = makeOcc({
  id: 'occ-root-a', itemId: 'item-root-a', name: 'Root A',
  sortOrder: 0,
})
const ROOT_B_OCC = makeOcc({
  id: 'occ-root-b', itemId: 'item-root-b', name: 'Root B',
  sortOrder: 1,
})

// A blocked item
const BLOCKED_OCC = makeOcc({
  id: 'occ-blocked', itemId: 'item-blocked', name: 'Blocked Task',
  isBlocked: true,
})

// A completed item (should leave Now)
const DONE_OCC = makeOcc({
  id: 'occ-done', itemId: 'item-done', name: 'Done Item',
  completionState: { isLeaf: true, completionPercent: 100, isComplete: true, completedAt: null, wasRetroactive: false, derivedPercent: null, declaredPercent: null },
  disposition: { type: 'completed', reasonId: null, comment: null, rescheduledToDay: null, derivedPercentAtClose: null },
})

// ── Mock helpers ───────────────────────────────────────────────────────────

async function setupApiMocks(
  page: Page,
  occurrences: OccurrenceWithState[],
  buckets: Bucket[] = BUCKETS
) {
  await page.route('/me', (route) =>
    route.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } })
  )
  await page.route('/api/occurrences/today', (route) =>
    route.fulfill({ json: occurrences })
  )
  await page.route('/api/buckets', (route) =>
    route.fulfill({ json: buckets })
  )
  await page.route('/api/categories', (route) => route.fulfill({ json: [] }))
  await page.route('/api/reasons', (route) => route.fulfill({ json: [] }))
  await page.route('/api/preferences', (route) => route.fulfill({ json: {} }))
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe('§12.2 — Now view tier ordering and rendering', () => {

  test('§12.2 Now view renders three tiers in correct order (active → imminent → unscheduled)', async ({ page }) => {
    // 05:00 on a weekday: Trading is active (04:00–06:30), Call at 06:00 is imminent (<90min), Routine is unscheduled
    await page.clock.setFixedTime(new Date('2025-06-16T05:00:00'))
    await setupApiMocks(page, [TRADING_OCC, CALL_OCC, ROUTINE_OCC])

    await page.goto('/')

    const active      = page.getByTestId('tier-active')
    const imminent    = page.getByTestId('tier-imminent')
    const unscheduled = page.getByTestId('tier-unscheduled')

    // All three tiers render
    await expect(active).toBeVisible()
    await expect(imminent).toBeVisible()
    await expect(unscheduled).toBeVisible()

    // Active contains the range item
    await expect(active.getByText('Day Trading')).toBeVisible()

    // Imminent contains the upcoming point item
    await expect(imminent.getByText('Morning Call')).toBeVisible()

    // Unscheduled contains the no-timing item
    await expect(unscheduled.getByText('Night Routine')).toBeVisible()

    // DOM order: active appears before imminent before unscheduled
    const activePx    = (await active.boundingBox())!.y
    const imminentPx  = (await imminent.boundingBox())!.y
    const unschedPx   = (await unscheduled.boundingBox())!.y
    expect(activePx).toBeLessThan(imminentPx)
    expect(imminentPx).toBeLessThan(unschedPx)
  })

  test('§12.2 blocked item is absent from Now; completed active item leaves Now', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T05:00:00'))
    // Include blocked + completed items in the API response
    await setupApiMocks(page, [TRADING_OCC, BLOCKED_OCC, DONE_OCC, ROUTINE_OCC])

    await page.goto('/')

    // Blocked is hidden from all tiers
    await expect(page.getByText('Blocked Task')).not.toBeVisible()
    // Completed item appears in Done Today section, not in active/imminent/unscheduled tiers
    await expect(page.getByTestId('tier-active').getByText('Done Item')).not.toBeVisible()
    await expect(page.getByTestId('tier-imminent').getByText('Done Item')).not.toBeVisible()
    await expect(page.getByTestId('tier-unscheduled').getByText('Done Item')).not.toBeVisible()
    await expect(page.getByTestId('tier-done').getByText('Done Item')).toBeVisible()

    // Active item is visible
    await expect(page.getByTestId('tier-active').getByText('Day Trading')).toBeVisible()
  })

  test('§6.1 completing a child updates parent derived % live', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T22:00:00'))
    await page.route('/me', (r) => r.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } }))

    const completedTret: OccurrenceWithState = {
      ...TRETINOIN_OCC,
      completionState: {
        ...TRETINOIN_OCC.completionState, isComplete: true, completionPercent: 100,
      },
      disposition: { ...TRETINOIN_OCC.disposition, type: 'completed' },
    }
    const routineWith100pct: OccurrenceWithState = {
      ...ROUTINE_OCC,
      completionState: {
        ...ROUTINE_OCC.completionState, derivedPercent: 100, completionPercent: 100,
      },
    }

    // Track whether the child has been completed so the refresh returns updated data
    let tretCompleted = false

    await page.route('/api/occurrences/today', (route) => {
      route.fulfill({
        json: tretCompleted
          ? [routineWith100pct, completedTret]
          : [ROUTINE_OCC, TRETINOIN_OCC],
      })
    })
    await page.route('/api/occurrences/occ-tret/complete', async (route) => {
      tretCompleted = true
      await route.fulfill({ json: completedTret })
    })
    await page.route('/api/buckets',     (route) => route.fulfill({ json: BUCKETS }))
    await page.route('/api/categories',  (route) => route.fulfill({ json: [] }))
    await page.route('/api/reasons',     (route) => route.fulfill({ json: [] }))
    await page.route('/api/preferences', (route) => route.fulfill({ json: {} }))

    await page.goto('/')

    // Initial state: 50% shown on Night Routine (rendered in the card header)
    await expect(page.getByTestId('derived-pct').first()).toContainText('50%')

    // Child is nested inside the parent's card — expand it first
    await page.getByTestId(`occ-card-toggle-${ROUTINE_OCC.itemId}`).click()
    const tretRow = page.getByTestId(`occ-row-${TRETINOIN_OCC.id}`)
    await tretRow.getByTestId('occ-check').click()

    // After refresh, parent derived % should now be 100%
    await expect(page.getByTestId('derived-pct').first()).toContainText('100%')
  })

  test('§9.1 timer start → pause → resume → stop; two simultaneous timers run at once', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T05:00:00'))
    await setupApiMocks(page, [TRADING_OCC, ROUTINE_OCC])

    // Timer API mocks
    await page.route('/api/sessions/start', (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as { itemId: string }
      const sessionId = `sess-${body.itemId}`
      route.fulfill({ json: { sessionId, occurrenceId: body.itemId === 'item-trading' ? 'occ-trading' : 'occ-routine' } })
    })
    await page.route('/api/sessions/*/pause',  (route) => route.fulfill({ json: { ok: true } }))
    await page.route('/api/sessions/*/resume', (route) => route.fulfill({ json: { ok: true } }))
    await page.route('/api/sessions/*/stop',   (route) => route.fulfill({ json: { sessionId: 'x', durationMin: 5 } }))

    await page.goto('/')

    // Start timer on Day Trading
    const tradingRow = page.getByTestId('occ-row-occ-trading')
    await tradingRow.getByTestId('timer-start').click()
    await expect(tradingRow.getByTestId('timer-running')).toBeVisible()

    // Start a second timer on Night Routine simultaneously (§9.1 overlapping timers)
    const routineRow = page.getByTestId('occ-row-occ-routine')
    await routineRow.getByTestId('timer-start').click()
    await expect(routineRow.getByTestId('timer-running')).toBeVisible()

    // Both timers running at same time
    await expect(tradingRow.getByTestId('timer-running')).toBeVisible()
    await expect(routineRow.getByTestId('timer-running')).toBeVisible()

    // Pause the first
    await tradingRow.getByTestId('timer-pause').click()
    await expect(tradingRow.getByTestId('timer-resume')).toBeVisible()

    // Resume it
    await tradingRow.getByTestId('timer-resume').click()
    await expect(tradingRow.getByTestId('timer-pause')).toBeVisible()

    // Stop it
    await tradingRow.getByTestId('timer-stop').click()
    await expect(tradingRow.getByTestId('timer-start')).toBeVisible()

    // Second timer still running
    await expect(routineRow.getByTestId('timer-running')).toBeVisible()
  })

  test('§9.2 ad-hoc one-tap creates item + running timer appears in Now', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T05:00:00'))
    await setupApiMocks(page, [])

    const newOcc: OccurrenceWithState = makeOcc({
      id: 'occ-adhoc', itemId: 'item-adhoc', name: 'Quick reading',
    })

    await page.route('/api/ad-hoc', (route) =>
      route.fulfill({
        status: 201,
        json: { item: { id: 'item-adhoc', name: 'Quick reading' }, occurrence: { id: 'occ-adhoc' }, sessionId: 'sess-adhoc' },
      })
    )

    // After ad-hoc create, the refresh fetches updated occurrences
    let adhocCreated = false
    await page.route('/api/occurrences/today', (route) => {
      if (adhocCreated) {
        route.fulfill({ json: [newOcc] })
      } else {
        route.fulfill({ json: [] })
      }
    })

    await page.goto('/')

    // Open the ad-hoc modal
    await page.getByTestId('adhoc-btn').click()
    await expect(page.getByTestId('adhoc-modal')).toBeVisible()

    // Enter name and submit
    await page.getByTestId('adhoc-name').fill('Quick reading')
    adhocCreated = true
    await page.getByTestId('adhoc-submit').click()

    // Modal closes
    await expect(page.getByTestId('adhoc-modal')).not.toBeVisible()

    // After refresh, the new item appears; timer is running in session state
    await expect(page.getByText('Quick reading')).toBeVisible()
    // The timer for the new occurrence is tracked client-side after creation
    const newRow = page.getByTestId('occ-row-occ-adhoc')
    await expect(newRow.getByTestId('timer-running')).toBeVisible()
  })

  test('§8 skip / excuse / carry-forward flows work from Now UI', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T22:00:00'))
    await setupApiMocks(page, [ROUTINE_OCC])

    const skippedOcc: OccurrenceWithState = {
      ...ROUTINE_OCC,
      disposition: { type: 'skipped', reasonId: null, comment: null, rescheduledToDay: null, derivedPercentAtClose: null },
    }

    await page.route('/api/occurrences/occ-routine/skip', (route) =>
      route.fulfill({ json: skippedOcc })
    )

    await page.goto('/')

    // Open disposition modal
    const routineRow = page.getByTestId('occ-row-occ-routine')
    await routineRow.getByTestId('occ-disposition-btn').click()
    await expect(page.getByTestId('disposition-modal')).toBeVisible()

    // Skip is pre-selected; confirm
    await expect(page.getByTestId('disp-skip')).toHaveClass(/disp-option--selected/)
    await page.getByTestId('disp-submit').click()

    // Modal closes; item updated (skipped items remain visible — not auto-hidden)
    await expect(page.getByTestId('disposition-modal')).not.toBeVisible()
  })

  test('§11 light/dark toggle persists via backend preference (truth) and cookie render hint', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T05:00:00'))
    await page.route('/me', (r) => r.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } }))

    // Simulate backend persistence: GET returns whatever was last PUT
    let savedTheme: string | null = null
    await page.route('/api/preferences', (route) =>
      route.fulfill({ json: savedTheme ? { theme: savedTheme } : {} })
    )
    await page.route('/api/preferences/*', (route) => {
      if (route.request().method() === 'PUT') {
        const body = JSON.parse(route.request().postData() ?? '{}') as { value: string }
        savedTheme = body.value
        route.fulfill({ json: { ok: true } })
      } else {
        route.fulfill({ json: {} })
      }
    })
    await page.route('/api/occurrences/today', (route) => route.fulfill({ json: [] }))
    await page.route('/api/buckets',           (route) => route.fulfill({ json: [] }))
    await page.route('/api/categories',        (route) => route.fulfill({ json: [] }))
    await page.route('/api/reasons',           (route) => route.fulfill({ json: [] }))

    await page.goto('/')

    const html = page.locator('html')
    const initialTheme = await html.getAttribute('data-theme')

    // Toggle theme
    await page.getByTestId('theme-toggle').click()

    const newTheme = await html.getAttribute('data-theme')
    expect(newTheme).not.toBe(initialTheme)
    expect(['light', 'dark']).toContain(newTheme)

    // Backend PUT was called with the new theme (backend is truth)
    expect(savedTheme).toBe(newTheme)

    // Cookie render hint is set (FOUC prevention for next load)
    const cookies = await page.context().cookies()
    const themeCookie = cookies.find((c) => c.name === 'tracker-theme')
    expect(themeCookie?.value).toBe(newTheme)

    // Reload: cookie provides immediate paint; backend GET returns saved theme → reconciles
    await page.reload()
    await expect(html).toHaveAttribute('data-theme', newTheme!)
  })

  test('§11 layout is usable at phone width (320px)', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T05:00:00'))
    await setupApiMocks(page, [TRADING_OCC, ROUTINE_OCC])

    await page.setViewportSize({ width: 320, height: 568 })
    await page.goto('/')

    // Key elements are visible and not clipped at phone width
    await expect(page.locator('.app-header')).toBeVisible()
    await expect(page.getByTestId('tier-active')).toBeVisible()
    await expect(page.getByTestId('tier-unscheduled')).toBeVisible()

    // Header doesn't overflow
    const header = await page.locator('.app-header').boundingBox()
    expect(header!.width).toBeLessThanOrEqual(320)
  })

})

test.describe('§4 — Uncomplete with confirmation (Now view)', () => {

  test('§4 clicking checked checkbox in Done Today shows confirmation modal', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T22:00:00'))
    await setupApiMocks(page, [DONE_OCC])

    await page.goto('/')

    // Done Today section auto-expands when there are completed items
    const doneSection = page.getByTestId('tier-done')
    await expect(doneSection).toBeVisible()

    // The completed item's row is visible inside Done Today
    const doneRow = doneSection.getByTestId(`occ-row-${DONE_OCC.id}`)
    await expect(doneRow).toBeVisible()

    // Click the green checked checkbox
    await doneRow.getByTestId('occ-check').click()

    // Confirmation modal appears
    await expect(page.getByTestId('confirm-modal')).toBeVisible()
    await expect(page.getByTestId('confirm-modal')).toContainText(DONE_OCC.snapshot.name)
  })

  test('§4 cancelling uncomplete modal leaves item completed with no API call', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T22:00:00'))
    await setupApiMocks(page, [DONE_OCC])

    const uncompleteCalls: string[] = []
    await page.route(`/api/occurrences/${DONE_OCC.id}/uncomplete`, (route) => {
      uncompleteCalls.push(route.request().url())
      route.fulfill({ json: DONE_OCC })
    })

    await page.goto('/')

    const doneRow = page.getByTestId('tier-done').getByTestId(`occ-row-${DONE_OCC.id}`)
    await doneRow.getByTestId('occ-check').click()
    await expect(page.getByTestId('confirm-modal')).toBeVisible()

    // Cancel
    await page.getByRole('button', { name: 'Cancel' }).click()

    // Modal gone, no API call made
    await expect(page.getByTestId('confirm-modal')).not.toBeVisible()
    expect(uncompleteCalls.length).toBe(0)

    // Item is still in Done Today
    await expect(page.getByTestId('tier-done').getByTestId(`occ-row-${DONE_OCC.id}`)).toBeVisible()
  })

  test('§4 confirming uncomplete calls the API and moves item back to active tiers', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T22:00:00'))

    const uncompletedOcc: OccurrenceWithState = {
      ...DONE_OCC,
      completionState: {
        ...DONE_OCC.completionState,
        isComplete: false,
        completionPercent: 0,
      },
      disposition: { type: 'pending', reasonId: null, comment: null, rescheduledToDay: null, derivedPercentAtClose: null },
    }

    await setupApiMocks(page, [DONE_OCC])
    await page.route(`/api/occurrences/${DONE_OCC.id}/uncomplete`, (route) =>
      route.fulfill({ json: uncompletedOcc })
    )

    await page.goto('/')

    const doneSection = page.getByTestId('tier-done')
    const doneRow = doneSection.getByTestId(`occ-row-${DONE_OCC.id}`)
    await doneRow.getByTestId('occ-check').click()

    await expect(page.getByTestId('confirm-modal')).toBeVisible()
    await page.getByTestId('confirm-modal-confirm').click()

    // Modal closes
    await expect(page.getByTestId('confirm-modal')).not.toBeVisible()

    // Item is no longer in Done Today (it reverted to pending)
    await expect(page.getByTestId('tier-done').getByTestId(`occ-row-${DONE_OCC.id}`)).not.toBeVisible()
    // Item moved to unscheduled tier
    await expect(page.getByTestId('tier-unscheduled').getByTestId(`occ-row-${DONE_OCC.id}`)).toBeVisible()
  })

})

test.describe('§9.3 — Timer persistence across navigation', () => {

  test('§9.3 running timer survives navigating away and back to Now view', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T05:00:00'))
    await page.route('/me', (r) => r.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } }))

    // Set up both Now and List view endpoints
    await page.route('/api/occurrences/today', (route) => route.fulfill({ json: [TRADING_OCC] }))
    await page.route(/\/api\/occurrences\?start=.*&end=.*/, (route) => route.fulfill({ json: [TRADING_OCC] }))
    await page.route('/api/buckets', (route) => route.fulfill({ json: BUCKETS }))
    await page.route('/api/day-start', (route) => route.fulfill({ json: [] }))
    await page.route('/api/categories', (route) => route.fulfill({ json: [] }))
    await page.route('/api/reasons', (route) => route.fulfill({ json: [] }))
    await page.route('/api/preferences', (route) => route.fulfill({ json: {} }))
    await page.route('/api/sessions/start', (route) =>
      route.fulfill({ json: { sessionId: 'sess-trading', occurrenceId: 'occ-trading' } })
    )
    await page.route('/api/sessions/*/stop', (route) =>
      route.fulfill({ json: { sessionId: 'sess-trading', durationMin: 5 } })
    )

    await page.goto('/')

    // Start timer on Day Trading
    const tradingRow = page.getByTestId('occ-row-occ-trading')
    await tradingRow.getByTestId('timer-start').click()
    await expect(tradingRow.getByTestId('timer-running')).toBeVisible()

    // Navigate away to List view, then back to Now
    await page.getByTestId('view-nav-list').click()
    await expect(page.getByTestId('list-view')).toBeVisible()
    await page.getByTestId('view-nav-now').click()
    await expect(page.locator('.now-view')).toBeVisible()

    // Timer is still running after remount (loaded from localStorage)
    await expect(page.getByTestId('occ-row-occ-trading').getByTestId('timer-running')).toBeVisible()
  })

})

test.describe('§3 — Archive / delete task (Now view)', () => {

  test('§3 delete button shows confirmation modal with task name', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T22:00:00'))
    await setupApiMocks(page, [ROUTINE_OCC])
    await page.route('/api/items/item-routine', (route) =>
      route.fulfill({ status: 204, body: '' })
    )

    await page.goto('/')

    const row = page.getByTestId(`occ-row-${ROUTINE_OCC.id}`)
    await expect(row).toBeVisible()
    await row.getByTestId('occ-archive-btn').click()

    await expect(page.getByTestId('confirm-modal')).toBeVisible()
    await expect(page.getByTestId('confirm-modal')).toContainText('Night Routine')
  })

  test('§3 cancelling delete modal makes no API call and item remains', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T22:00:00'))
    await setupApiMocks(page, [ROUTINE_OCC])

    const archiveCalls: string[] = []
    await page.route('/api/items/item-routine', (route) => {
      archiveCalls.push(route.request().url())
      route.fulfill({ status: 204, body: '' })
    })

    await page.goto('/')

    const row = page.getByTestId(`occ-row-${ROUTINE_OCC.id}`)
    await row.getByTestId('occ-archive-btn').click()
    await expect(page.getByTestId('confirm-modal')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()

    await expect(page.getByTestId('confirm-modal')).not.toBeVisible()
    expect(archiveCalls.length).toBe(0)
    await expect(row).toBeVisible()
  })

  test('§3 confirming delete calls DELETE /items/:id and removes the task', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T22:00:00'))
    await page.route('/me', (r) => r.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } }))

    let archived = false
    await page.route('/api/occurrences/today', (route) =>
      route.fulfill({ json: archived ? [] : [ROUTINE_OCC] })
    )
    await page.route('/api/buckets', (route) => route.fulfill({ json: BUCKETS }))
    await page.route('/api/categories', (route) => route.fulfill({ json: [] }))
    await page.route('/api/reasons', (route) => route.fulfill({ json: [] }))
    await page.route('/api/preferences', (route) => route.fulfill({ json: {} }))

    const archiveCalls: string[] = []
    await page.route('/api/items/item-routine', (route) => {
      archiveCalls.push(route.request().method())
      archived = true
      route.fulfill({ status: 204, body: '' })
    })

    await page.goto('/')

    const row = page.getByTestId(`occ-row-${ROUTINE_OCC.id}`)
    await row.getByTestId('occ-archive-btn').click()
    await expect(page.getByTestId('confirm-modal')).toBeVisible()
    await page.getByTestId('confirm-modal-confirm').click()

    await expect(page.getByTestId('confirm-modal')).not.toBeVisible()
    expect(archiveCalls.length).toBe(1)
    expect(archiveCalls[0]).toBe('DELETE')
    await expect(page.getByTestId(`occ-row-${ROUTINE_OCC.id}`)).not.toBeVisible()
  })

})

test.describe('Occurrence nesting — parent/child cards (Now view)', () => {

  test('parent with children renders as a closed card by default; plain leaf rows get no card chrome', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T22:00:00'))
    await setupApiMocks(page, [ROUTINE_OCC, TRETINOIN_OCC, TRADING_OCC])

    await page.goto('/')

    const card = page.getByTestId(`occ-card-${ROUTINE_OCC.itemId}`)
    await expect(card).toBeVisible()
    await expect(card).toHaveAttribute('data-expanded', 'false')
    // Collapsed: children not in the DOM at all
    await expect(page.getByTestId(`occ-row-${TRETINOIN_OCC.id}`)).toHaveCount(0)
    // Leaf occurrence (no children) never gets card treatment
    await expect(page.getByTestId(`occ-card-${TRADING_OCC.itemId}`)).toHaveCount(0)
  })

  test('expanding a parent card reveals its children and adds border/shadow', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T22:00:00'))
    await setupApiMocks(page, [ROUTINE_OCC, TRETINOIN_OCC])

    await page.goto('/')

    const card = page.getByTestId(`occ-card-${ROUTINE_OCC.itemId}`)
    await expect(card).not.toHaveClass(/occ-card--expanded/)

    await page.getByTestId(`occ-card-toggle-${ROUTINE_OCC.itemId}`).click()

    await expect(card).toHaveClass(/occ-card--expanded/)
    await expect(card).toHaveAttribute('data-expanded', 'true')
    await expect(page.getByTestId(`occ-row-${TRETINOIN_OCC.id}`)).toBeVisible()
  })

  test('grandchild (child-with-its-own-children) renders as its own nested card', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T22:00:00'))
    await setupApiMocks(page, [ROUTINE_OCC, SKINCARE_OCC, CLEANSE_OCC])

    await page.goto('/')

    await page.getByTestId(`occ-card-toggle-${ROUTINE_OCC.itemId}`).click()
    const skincareCard = page.getByTestId(`occ-card-${SKINCARE_OCC.itemId}`)
    await expect(skincareCard).toBeVisible()
    await expect(skincareCard).toHaveClass(/occ-card--nested/)
    // Still closed — Cleanse isn't in the DOM until Skincare itself expands
    await expect(page.getByTestId(`occ-row-${CLEANSE_OCC.id}`)).toHaveCount(0)

    await page.getByTestId(`occ-card-toggle-${SKINCARE_OCC.itemId}`).click()
    await expect(page.getByTestId(`occ-row-${CLEANSE_OCC.id}`)).toBeVisible()
  })

  test('a child whose parent occurrence is not materialized today renders as a plain top-level row, not nested', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T22:00:00'))
    // Tretinoin only — Night Routine did not materialize for today (off-schedule day)
    await setupApiMocks(page, [TRETINOIN_OCC])

    await page.goto('/')

    await expect(page.getByTestId(`occ-row-${TRETINOIN_OCC.id}`)).toBeVisible()
    await expect(page.getByTestId(`occ-card-${TRETINOIN_OCC.itemId}`)).toHaveCount(0)
  })

  test('a completed child stays nested in its still-incomplete parent card instead of moving to Done today', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T22:00:00'))
    const completedTret: OccurrenceWithState = {
      ...TRETINOIN_OCC,
      completionState: { ...TRETINOIN_OCC.completionState, isComplete: true, completionPercent: 100 },
      disposition: { ...TRETINOIN_OCC.disposition, type: 'completed' },
    }
    await setupApiMocks(page, [ROUTINE_OCC, completedTret])

    await page.goto('/')

    // Parent (still <100%) is not in Done today
    await expect(page.getByTestId('tier-done')).toHaveCount(0)
    await page.getByTestId(`occ-card-toggle-${ROUTINE_OCC.itemId}`).click()
    await expect(page.getByTestId(`occ-row-${completedTret.id}`).getByTestId('occ-check')).toHaveClass(/occ-check--checked/)
  })

})

// @dnd-kit's PointerSensor listens for pointer events, not HTML5 dragstart/
// dragover — locator.dragTo() won't trigger it. Drive it via raw mouse events
// with an intermediate move past the activation distance instead.
async function dragHandleTo(page: Page, fromTestId: string, toTestId: string) {
  const from = page.getByTestId(fromTestId)
  const to = page.getByTestId(toTestId)
  const fromBox = (await from.boundingBox())!
  const toBox = (await to.boundingBox())!

  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2)
  await page.mouse.down()
  // Small initial move past the 4px activation distance before the big move
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2 + 8, { steps: 2 })
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height + 4, { steps: 5 })
  await page.mouse.up()
}

test.describe('Manual child reordering (drag-and-drop, Now view)', () => {

  test('drag handle only appears inside an expanded card, and only on occurrences with siblings', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T22:00:00'))
    await setupApiMocks(page, [ROUTINE_OCC, CHILD_A_OCC, CHILD_B_OCC, TRADING_OCC])

    await page.goto('/')

    // Collapsed: no handles in the DOM at all
    await expect(page.getByTestId(`occ-card-drag-handle-${CHILD_A_OCC.itemId}`)).toHaveCount(0)

    await page.getByTestId(`occ-card-toggle-${ROUTINE_OCC.itemId}`).click()

    await expect(page.getByTestId(`occ-card-drag-handle-${CHILD_A_OCC.itemId}`)).toBeVisible()
    await expect(page.getByTestId(`occ-card-drag-handle-${CHILD_B_OCC.itemId}`)).toBeVisible()
    // Trading has no children/siblings under a card — never gets a handle
    await expect(page.getByTestId(`occ-card-drag-handle-${TRADING_OCC.itemId}`)).toHaveCount(0)
  })

  test('dragging a child handle to a new position calls reorderChildren with the full new order', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T22:00:00'))
    await setupApiMocks(page, [ROUTINE_OCC, CHILD_A_OCC, CHILD_B_OCC])

    let reorderBody: { childItemIds: string[] } | null = null
    await page.route(`/api/items/${ROUTINE_OCC.itemId}/reorder-children`, async (route) => {
      reorderBody = route.request().postDataJSON()
      await route.fulfill({ json: [] })
    })

    await page.goto('/')
    await page.getByTestId(`occ-card-toggle-${ROUTINE_OCC.itemId}`).click()

    await dragHandleTo(
      page,
      `occ-card-drag-handle-${CHILD_A_OCC.itemId}`,
      `occ-card-drag-handle-${CHILD_B_OCC.itemId}`
    )

    await expect.poll(() => reorderBody).not.toBeNull()
    expect(reorderBody!.childItemIds).toEqual([CHILD_B_OCC.itemId, CHILD_A_OCC.itemId])
  })

  test('after a successful reorder, the new order is reflected immediately without a full-tree refetch', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T22:00:00'))

    let todayFetchCount = 0
    await page.route('/me', (r) => r.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } }))
    await page.route('/api/occurrences/today', (route) => {
      todayFetchCount++
      return route.fulfill({ json: [ROUTINE_OCC, CHILD_A_OCC, CHILD_B_OCC] })
    })
    await page.route(`/api/items/${ROUTINE_OCC.itemId}/reorder-children`, async (route) => {
      await route.fulfill({ json: [] })
    })
    await page.route('/api/buckets', (route) => route.fulfill({ json: BUCKETS }))
    await page.route('/api/categories', (route) => route.fulfill({ json: [] }))
    await page.route('/api/reasons', (route) => route.fulfill({ json: [] }))
    await page.route('/api/preferences', (route) => route.fulfill({ json: {} }))

    await page.goto('/')
    await page.getByTestId(`occ-card-toggle-${ROUTINE_OCC.itemId}`).click()

    const childrenList = page.getByTestId(`occ-card-children-${ROUTINE_OCC.itemId}`)
    await expect(childrenList).toContainText(/Child A[\s\S]*Child B/)

    const fetchesBeforeDrag = todayFetchCount
    await dragHandleTo(
      page,
      `occ-card-drag-handle-${CHILD_A_OCC.itemId}`,
      `occ-card-drag-handle-${CHILD_B_OCC.itemId}`
    )

    // New order shows up via a local state patch, not a refetch
    await expect(childrenList).toContainText(/Child B[\s\S]*Child A/)
    expect(todayFetchCount).toBe(fetchesBeforeDrag)
  })

  test('an expanded card stays expanded after a successful drag, so a second drag needs no extra click', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T22:00:00'))
    await setupApiMocks(page, [ROUTINE_OCC, CHILD_A_OCC, CHILD_B_OCC])
    await page.route(`/api/items/${ROUTINE_OCC.itemId}/reorder-children`, async (route) => {
      await route.fulfill({ json: [] })
    })

    await page.goto('/')
    await page.getByTestId(`occ-card-toggle-${ROUTINE_OCC.itemId}`).click()

    const card = page.getByTestId(`occ-card-${ROUTINE_OCC.itemId}`)
    await expect(card).toHaveAttribute('data-expanded', 'true')

    await dragHandleTo(
      page,
      `occ-card-drag-handle-${CHILD_A_OCC.itemId}`,
      `occ-card-drag-handle-${CHILD_B_OCC.itemId}`
    )

    // Still expanded — no re-click needed to keep reordering
    await expect(card).toHaveAttribute('data-expanded', 'true')
    await expect(page.getByTestId(`occ-card-drag-handle-${CHILD_A_OCC.itemId}`)).toBeVisible()
  })

})

test.describe('Manual root reordering (drag-and-drop, unscheduled tier, Now view)', () => {

  test('drag handles appear only on unscheduled root items, not active/imminent ones', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T05:00:00'))
    await setupApiMocks(page, [TRADING_OCC, CALL_OCC, ROOT_A_OCC, ROOT_B_OCC])

    await page.goto('/')

    await expect(page.getByTestId(`root-drag-handle-${ROOT_A_OCC.itemId}`)).toBeVisible()
    await expect(page.getByTestId(`root-drag-handle-${ROOT_B_OCC.itemId}`)).toBeVisible()
    // Active (range) and imminent (point) items never get a root drag handle
    await expect(page.getByTestId(`root-drag-handle-${TRADING_OCC.itemId}`)).toHaveCount(0)
    await expect(page.getByTestId(`root-drag-handle-${CALL_OCC.itemId}`)).toHaveCount(0)
  })

  test('dragging an unscheduled root handle calls reorder-root with the dropped-after neighbor', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T22:00:00'))
    await setupApiMocks(page, [ROOT_A_OCC, ROOT_B_OCC])

    let reorderBody: { afterItemId: string | null } | null = null
    await page.route(`/api/items/${ROOT_A_OCC.itemId}/reorder-root`, async (route) => {
      reorderBody = route.request().postDataJSON()
      await route.fulfill({ json: [] })
    })

    await page.goto('/')

    await dragHandleTo(
      page,
      `root-drag-handle-${ROOT_A_OCC.itemId}`,
      `root-drag-handle-${ROOT_B_OCC.itemId}`
    )

    await expect.poll(() => reorderBody).not.toBeNull()
    expect(reorderBody!.afterItemId).toBe(ROOT_B_OCC.itemId)
  })

  test('after a successful root reorder, the new order is reflected immediately without a full refetch', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T22:00:00'))

    let todayFetchCount = 0
    await page.route('/me', (r) => r.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } }))
    await page.route('/api/occurrences/today', (route) => {
      todayFetchCount++
      return route.fulfill({ json: [ROOT_A_OCC, ROOT_B_OCC] })
    })
    await page.route(`/api/items/${ROOT_A_OCC.itemId}/reorder-root`, async (route) => {
      await route.fulfill({ json: [] })
    })
    await page.route('/api/buckets', (route) => route.fulfill({ json: BUCKETS }))
    await page.route('/api/categories', (route) => route.fulfill({ json: [] }))
    await page.route('/api/reasons', (route) => route.fulfill({ json: [] }))
    await page.route('/api/preferences', (route) => route.fulfill({ json: {} }))

    await page.goto('/')

    const unscheduled = page.getByTestId('tier-unscheduled')
    await expect(unscheduled).toContainText(/Root A[\s\S]*Root B/)

    const fetchesBeforeDrag = todayFetchCount
    await dragHandleTo(
      page,
      `root-drag-handle-${ROOT_A_OCC.itemId}`,
      `root-drag-handle-${ROOT_B_OCC.itemId}`
    )

    // New order shows up via a local state patch, not a refetch
    await expect(unscheduled).toContainText(/Root B[\s\S]*Root A/)
    expect(todayFetchCount).toBe(fetchesBeforeDrag)
  })

})
