// §9.1 — Session manager (add/edit/delete individual logged-time windows).
// Tests are named after the spec rules they verify (§CLAUDE.md).
//
// The API is mocked via page.route(); a mutable `sessions` array in each test
// closure stands in for the server's event-sourced session list so
// GET /occurrences/:id/sessions and GET /occurrences/today (loggedMinutes)
// stay consistent with each other across add/edit/delete, the same way the
// real backend derives both from the same event stream.

import { test, expect, type Page } from '@playwright/test'
import type { OccurrenceWithState, SessionSummary } from '@tracker/shared'
import type { Bucket } from '@tracker/shared'

type MakeOccOverrides = {
  id: string
  itemId: string
  name: string
  completionState?: Partial<OccurrenceWithState['completionState']>
  disposition?: Partial<OccurrenceWithState['disposition']>
}

function makeOcc(overrides: MakeOccOverrides): OccurrenceWithState {
  return {
    id: overrides.id,
    userId: 'u1',
    itemId: overrides.itemId,
    appliesToDay: '2025-06-16',
    materializedAt: '2025-06-16T04:00:00Z' as unknown as null,
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
    },
    isBlocked: false,
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
    sortOrder: 0,
    loggedMinutes: 0,
  } as OccurrenceWithState
}

const BUCKETS: Bucket[] = []

const OCC = makeOcc({ id: 'occ-piano', itemId: 'item-piano', name: 'Piano Practice' })

function sumMinutes(sessions: SessionSummary[]): number {
  return sessions.reduce((sum, s) => sum + s.durationMin, 0)
}

// Wires all routes for a single occurrence whose loggedMinutes and session
// list are always derived from the same mutable `sessions` array — mirrors
// how the real backend computes both from one event stream.
async function setupSessionMocks(page: Page, sessions: SessionSummary[]) {
  await page.route('/me', (route) =>
    route.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } })
  )
  await page.route('/api/occurrences/today', (route) =>
    route.fulfill({ json: [{ ...OCC, loggedMinutes: sumMinutes(sessions) }] })
  )
  await page.route('/api/buckets', (route) => route.fulfill({ json: BUCKETS }))
  await page.route('/api/categories', (route) => route.fulfill({ json: [] }))
  await page.route('/api/reasons', (route) => route.fulfill({ json: [] }))
  await page.route('/api/preferences', (route) => route.fulfill({ json: {} }))

  await page.route(`/api/occurrences/${OCC.id}/sessions`, (route) =>
    route.fulfill({ json: sessions })
  )

  let nextId = 1
  await page.route('/api/sessions/manual', async (route) => {
    const body = route.request().postDataJSON() as { startedAt: string; endedAt: string }
    const durationMin = Math.round((new Date(body.endedAt).getTime() - new Date(body.startedAt).getTime()) / 60000)
    const sessionId = `manual-${nextId++}`
    sessions.push({ sessionId, startedAt: body.startedAt, endedAt: body.endedAt, durationMin, source: 'manual' })
    await route.fulfill({ status: 201, json: { sessionId, occurrenceId: OCC.id, durationMin } })
  })

  // Excludes /api/sessions/manual (handled above) — this regex is only for
  // PATCH/DELETE /api/sessions/:sessionId.
  await page.route(/\/api\/sessions\/(?!manual$)[^/]+$/, async (route) => {
    const method = route.request().method()
    const sessionId = route.request().url().split('/').pop()!

    if (method === 'PATCH') {
      const body = route.request().postDataJSON() as { startedAt: string; endedAt: string }
      const durationMin = Math.round((new Date(body.endedAt).getTime() - new Date(body.startedAt).getTime()) / 60000)
      const s = sessions.find((x) => x.sessionId === sessionId)
      if (s) { s.startedAt = body.startedAt; s.endedAt = body.endedAt; s.durationMin = durationMin }
      await route.fulfill({ json: { sessionId, durationMin } })
    } else if (method === 'DELETE') {
      const idx = sessions.findIndex((x) => x.sessionId === sessionId)
      if (idx !== -1) sessions.splice(idx, 1)
      await route.fulfill({ json: { ok: true } })
    } else {
      await route.continue()
    }
  })
}

// The four windows from the feature request: 10:00-10:30, 14:00-15:00,
// 16:30-16:45, 18:15-18:45 — removing the third must leave the other three
// (and their combined total) untouched.
function fourWindows(): SessionSummary[] {
  return [
    { sessionId: 'w1', startedAt: '2025-06-16T10:00:00.000Z', endedAt: '2025-06-16T10:30:00.000Z', durationMin: 30, source: 'manual' },
    { sessionId: 'w2', startedAt: '2025-06-16T14:00:00.000Z', endedAt: '2025-06-16T15:00:00.000Z', durationMin: 60, source: 'live' },
    { sessionId: 'w3', startedAt: '2025-06-16T16:30:00.000Z', endedAt: '2025-06-16T16:45:00.000Z', durationMin: 15, source: 'manual' },
    { sessionId: 'w4', startedAt: '2025-06-16T18:15:00.000Z', endedAt: '2025-06-16T18:45:00.000Z', durationMin: 30, source: 'manual' },
  ]
}

test.describe('§9.1 — Session manager: list, add, edit, delete individual logged windows', () => {

  test('§9.1 opening the manager lists existing sessions with correct durations and live/manual badges', async ({ page }) => {
    const sessions = fourWindows()
    await setupSessionMocks(page, sessions)
    await page.goto('/')

    await page.getByTestId('occ-row-occ-piano').getByTestId('occ-manage-time-btn').click()
    const modal = page.getByTestId('session-manager-modal')
    await expect(modal).toBeVisible()

    const rows = modal.getByTestId('session-list').locator('li')
    await expect(rows).toHaveCount(4)

    await expect(page.getByTestId('session-row-w1')).toContainText('30m')
    await expect(page.getByTestId('session-row-w2')).toContainText('1h 0m')
    await expect(page.getByTestId('session-row-w2')).toContainText('live')
    await expect(page.getByTestId('session-row-w3')).toContainText('15m')
    await expect(page.getByTestId('session-row-w3')).toContainText('manual')
    await expect(page.getByTestId('session-row-w4')).toContainText('30m')
  })

  test('§9.1 adding a manual session appends it to the list and increases the logged-time total, no reload needed', async ({ page }) => {
    const sessions: SessionSummary[] = [
      { sessionId: 'w1', startedAt: '2025-06-16T10:00:00.000Z', endedAt: '2025-06-16T10:20:00.000Z', durationMin: 20, source: 'manual' },
    ]
    await setupSessionMocks(page, sessions)
    await page.goto('/')

    const row = page.getByTestId('occ-row-occ-piano')
    // Existing 20 minutes are already visible before opening the manager
    await expect(row.getByTestId('timer-logged')).toHaveText('20:00')

    await row.getByTestId('occ-manage-time-btn').click()
    const modal = page.getByTestId('session-manager-modal')
    await modal.getByTestId('session-add-btn').click()

    await modal.getByTestId('session-form-date').fill('2025-06-16')
    await modal.getByTestId('session-form-start').fill('11:00')
    await modal.getByTestId('session-form-end').fill('11:20')
    await modal.getByTestId('session-form-submit').click()

    // New row appears in the list
    await expect(modal.getByTestId('session-list').locator('li')).toHaveCount(2)

    // The row underneath the modal overlay reflects the new total (40 min) —
    // onChanged() refreshed the occurrence without needing a page reload.
    await expect(row.getByTestId('timer-logged')).toHaveText('40:00')
  })

  test('§9.1 deleting one session removes only that entry and reduces the total by exactly its duration, leaving the others unchanged', async ({ page }) => {
    const sessions = fourWindows()
    await setupSessionMocks(page, sessions)
    await page.goto('/')

    const row = page.getByTestId('occ-row-occ-piano')
    // 30 + 60 + 15 + 30 = 135 min = 2:15:00
    await expect(row.getByTestId('timer-logged')).toHaveText('2:15:00')

    await row.getByTestId('occ-manage-time-btn').click()
    const modal = page.getByTestId('session-manager-modal')

    // Remove the 16:30-16:45 (15 min) window
    await modal.getByTestId('session-delete-w3').click()
    await expect(page.getByTestId('confirm-modal')).toBeVisible()
    await page.getByTestId('confirm-modal-confirm').click()

    // Only w3 is gone; the other three remain
    await expect(page.getByTestId('session-row-w3')).toHaveCount(0)
    await expect(page.getByTestId('session-row-w1')).toBeVisible()
    await expect(page.getByTestId('session-row-w2')).toBeVisible()
    await expect(page.getByTestId('session-row-w4')).toBeVisible()

    // Total dropped by exactly 15 minutes: 135 - 15 = 120 = 2:00:00
    await expect(row.getByTestId('timer-logged')).toHaveText('2:00:00')
  })

  test('§9.1 editing a session\'s start/end updates its displayed duration and the total', async ({ page }) => {
    const sessions: SessionSummary[] = [
      { sessionId: 'w1', startedAt: '2025-06-16T10:00:00.000Z', endedAt: '2025-06-16T10:20:00.000Z', durationMin: 20, source: 'manual' },
    ]
    await setupSessionMocks(page, sessions)
    await page.goto('/')

    const row = page.getByTestId('occ-row-occ-piano')
    await expect(row.getByTestId('timer-logged')).toHaveText('20:00')

    await row.getByTestId('occ-manage-time-btn').click()
    const modal = page.getByTestId('session-manager-modal')
    await modal.getByTestId('session-edit-w1').click()

    // Extend the end time to 30 minutes after the (locale-rendered) start
    // time — read the prefilled start value rather than assuming the
    // browser's timezone, since the form displays local wall-clock time.
    const startValue = await modal.getByTestId('session-form-start').inputValue()
    const [h, m] = startValue.split(':').map(Number)
    const newEndMinutes = h * 60 + m + 30
    const newEnd = `${String(Math.floor(newEndMinutes / 60) % 24).padStart(2, '0')}:${String(newEndMinutes % 60).padStart(2, '0')}`
    await modal.getByTestId('session-form-end').fill(newEnd)
    await modal.getByTestId('session-form-submit').click()

    await expect(page.getByTestId('session-row-w1')).toContainText('30m')
    await expect(row.getByTestId('timer-logged')).toHaveText('30:00')
  })

  test('§9.1 the manage-time button is available on a completed occurrence, unlike the live timer', async ({ page }) => {
    const completedOcc = makeOcc({
      id: 'occ-done', itemId: 'item-done', name: 'Done Habit',
      completionState: { isLeaf: true, completionPercent: 100, isComplete: true },
      disposition: { type: 'completed' },
    })
    const sessions: SessionSummary[] = [
      { sessionId: 'w1', startedAt: '2025-06-16T10:00:00.000Z', endedAt: '2025-06-16T10:20:00.000Z', durationMin: 20, source: 'manual' },
    ]

    await page.route('/me', (route) =>
      route.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } })
    )
    await page.route('/api/occurrences/today', (route) =>
      route.fulfill({ json: [{ ...completedOcc, loggedMinutes: sumMinutes(sessions) }] })
    )
    await page.route('/api/buckets', (route) => route.fulfill({ json: BUCKETS }))
    await page.route('/api/categories', (route) => route.fulfill({ json: [] }))
    await page.route('/api/reasons', (route) => route.fulfill({ json: [] }))
    await page.route('/api/preferences', (route) => route.fulfill({ json: {} }))
    await page.route(`/api/occurrences/${completedOcc.id}/sessions`, (route) =>
      route.fulfill({ json: sessions })
    )

    await page.goto('/')

    const doneRow = page.getByTestId('tier-done').getByTestId(`occ-row-${completedOcc.id}`)
    await expect(doneRow).toBeVisible()

    // No live timer controls on a completed occurrence...
    await expect(doneRow.getByTestId('timer-start')).toHaveCount(0)
    // ...but the manage-time entry point is still there
    await expect(doneRow.getByTestId('occ-manage-time-btn')).toBeVisible()

    await doneRow.getByTestId('occ-manage-time-btn').click()
    await expect(page.getByTestId('session-manager-modal')).toBeVisible()
    await expect(page.getByTestId('session-row-w1')).toContainText('20m')
  })

})
