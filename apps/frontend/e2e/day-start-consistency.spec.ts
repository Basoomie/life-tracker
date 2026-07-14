// §6.7 / §9.1 — Cross-view consistency: Now, List, and Calendar must agree on
// which day is "today" (day-start-bucketed, computed the same way in all three),
// and an action taken in one view (starting/stopping a timer) must be visible
// from another view for the same occurrence — they are reading and writing the
// same event-sourced data, not independently-derived copies of it.
//
// Regression coverage for the bug where Now computed "today" via its own
// server-side round trip while List/Calendar computed it client-side, so the
// three views could silently disagree about which occurrence — and which
// logged sessions — they were showing.

import { test, expect, type Page } from '@playwright/test'
import type { OccurrenceWithState, DayStartEntry } from '@tracker/shared'

function makeDayStartEntry(o: { id: string; value: string; startsOn: string }): DayStartEntry {
  return { id: o.id, userId: 'u1', value: o.value, startsOn: o.startsOn, recordedAt: new Date() }
}

function makeOcc(overrides: {
  id: string
  itemId: string
  name: string
  appliesToDay: string
  loggedMinutes?: number
}): OccurrenceWithState {
  return {
    id: overrides.id,
    userId: 'u1',
    itemId: overrides.itemId,
    appliesToDay: overrides.appliesToDay,
    materializedAt: `${overrides.appliesToDay}T04:00:00Z` as unknown as null,
    snapshot: {
      name: overrides.name, description: null, categoryId: null, valence: null, priority: null,
      recurrenceRule: { type: 'daily' }, quotaTarget: null, timingPrecision: 'none',
      timingBucketId: null, timingStartTime: null, timingEndTime: null, plannedDurationMin: null,
      dispositionPolicy: 'skip', parentId: null, prerequisiteIds: [],
    },
    isBlocked: false,
    incompletePrerequisiteIds: [],
    hasChildren: false,
    sortOrder: 0,
    loggedMinutes: overrides.loggedMinutes ?? 0,
    completionState: {
      isLeaf: true, completionPercent: 0, isComplete: false, completedAt: null,
      wasRetroactive: false, derivedPercent: null, declaredPercent: null,
    },
    disposition: { type: 'pending', reasonId: null, comment: null, rescheduledToDay: null, derivedPercentAtClose: null },
  } as OccurrenceWithState
}

async function mockCommon(page: Page) {
  await page.route('/me', (r) =>
    r.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } })
  )
  await page.route('/api/buckets',     (r) => r.fulfill({ json: [] }))
  await page.route('/api/categories',  (r) => r.fulfill({ json: [] }))
  await page.route('/api/reasons',     (r) => r.fulfill({ json: [] }))
  await page.route('/api/preferences', (r) => r.fulfill({ json: {} }))
}

test.describe('§6.7 — Now, List, and Calendar agree on which day is "today"', () => {
  test('all three views converge on and render the same day-start-bucketed occurrence', async ({ page }) => {
    // 4am day-start; "now" is 2am, so the logical day is still yesterday
    // (2025-06-15) even though the raw calendar date already rolled to 2025-06-16.
    await page.clock.setFixedTime(new Date('2025-06-16T02:00:00'))
    await mockCommon(page)
    await page.route('/api/day-start', (r) =>
      r.fulfill({ json: [makeDayStartEntry({ id: 'ds1', value: '04:00', startsOn: '2020-01-01' })] })
    )

    const occ = makeOcc({ id: 'occ-late-night', itemId: 'item-late-night', name: 'Late Night Reading', appliesToDay: '2025-06-15' })

    // Only the correctly-bucketed day (2025-06-15) returns the occurrence — the
    // raw, unbucketed calendar day (2025-06-16) returns nothing, so a row only
    // appears once each view's "today" has resolved to the right logical day.
    await page.route(/\/api\/occurrences\?start=.*&end=.*/, (route) => {
      const isCorrectDay = route.request().url().includes('start=2025-06-15&end=2025-06-15')
      route.fulfill({ json: isCorrectDay ? [occ] : [] })
    })

    await page.goto('/')

    // Now (default landing view)
    await expect(page.getByTestId('occ-row-occ-late-night')).toBeVisible()

    // List
    await page.getByTestId('view-nav-list').click()
    await expect(page.getByTestId('occ-row-occ-late-night')).toBeVisible()

    // Calendar (scope to the desktop grid — the same TimeGrid also renders
    // inside cal-mobile-only, so an unscoped locator hits both)
    await page.getByTestId('view-nav-calendar').click()
    await expect(page.getByTestId('cal-grid-desktop').getByTestId('occ-row-occ-late-night')).toBeVisible()
  })
})

test.describe('§9.1 — a session logged from one view is visible from another', () => {
  test('a timer started and stopped on Now is visible in List\'s session manager for the same occurrence', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await mockCommon(page)
    await page.route('/api/day-start', (r) => r.fulfill({ json: [] }))

    let loggedMinutes = 0
    await page.route(/\/api\/occurrences\?start=.*&end=.*/, (route) =>
      route.fulfill({
        json: [makeOcc({ id: 'occ-x', itemId: 'item-x', name: 'Deep Work', appliesToDay: '2025-06-16', loggedMinutes })],
      })
    )
    await page.route('/api/sessions/start', (route) =>
      route.fulfill({ json: { sessionId: 'sess-1', occurrenceId: 'occ-x' } })
    )
    await page.route('/api/sessions/*/stop', (route) => {
      loggedMinutes = 20
      route.fulfill({ json: { sessionId: 'sess-1', durationMin: 20 } })
    })
    await page.route('/api/occurrences/occ-x/sessions', (route) =>
      route.fulfill({
        json: loggedMinutes > 0
          ? [{ sessionId: 'sess-1', startedAt: '2025-06-16T09:00:00.000Z', endedAt: '2025-06-16T09:20:00.000Z', durationMin: 20, source: 'live' }]
          : [],
      })
    )

    await page.goto('/')

    // Start and stop the timer from the Now tab
    const nowRow = page.getByTestId('occ-row-occ-x')
    await nowRow.getByTestId('timer-start').click()
    await expect(nowRow.getByTestId('timer-running')).toBeVisible()
    await nowRow.getByTestId('timer-stop').click()
    await expect(nowRow.getByTestId('timer-logged')).toHaveText('20:00')

    // Switch to List — same occurrence, same total, and its session manager
    // shows the exact session that was just logged from Now
    await page.getByTestId('view-nav-list').click()
    const listRow = page.getByTestId('occ-row-occ-x')
    await expect(listRow.getByTestId('timer-logged')).toHaveText('20:00')

    await listRow.getByTestId('occ-manage-time-btn').click()
    const modal = page.getByTestId('session-manager-modal')
    await expect(modal).toBeVisible()
    await expect(modal.getByTestId('session-list')).toContainText('20m')
  })
})
