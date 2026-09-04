// §5.6 — Active / inactive items: Playwright tests.
// Named after spec rules. Time is injected; API is mocked.
//
// The two things this UI must get right, and both are about honesty rather than
// mechanics: pausing must never present itself as deleting, and a cascade over a
// parent's sub-tasks must be disclosed before it happens, not discovered afterwards.

import { test, expect, type Page } from '@playwright/test'
import type { OccurrenceWithState, ItemWithSchedules } from '@tracker/shared'

// v2 §3.2.5 — the List view fetches ambient streak badges on load; stubbed empty so
// none of these depend on a live stats backend.
test.beforeEach(async ({ page }) => {
  await page.route(/\/api\/stats\/streaks$/, (route) =>
    route.fulfill({ json: { type: 'streak_summary', userId: 'u1', asOfDay: '2025-06-16', items: [] } })
  )
})

// ── Fixture builders ───────────────────────────────────────────────────────

function makeOcc(o: {
  id: string
  itemId: string
  name: string
  hasChildren?: boolean
  parentId?: string | null
}): OccurrenceWithState {
  const day = '2025-06-16'
  return {
    id: o.id,
    userId: 'u1',
    itemId: o.itemId,
    scheduleId: `${o.itemId}-s0`,
    appliesToDay: day,
    materializedAt: `${day}T04:00:00Z` as unknown as null,
    snapshot: {
      name: o.name,
      description: null, categoryId: null, valence: null, priority: null,
      recurrenceRule: { type: 'daily' }, quotaTarget: null,
      timingPrecision: 'none', timingBucketId: null,
      timingStartTime: null, timingEndTime: null, plannedDurationMin: null,
      dispositionPolicy: 'skip', parentId: o.parentId ?? null, prerequisiteIds: [],
    },
    isBlocked: false,
    incompletePrerequisiteIds: [],
    completionState: {
      isLeaf: !o.hasChildren, completionPercent: 0, isComplete: false,
      completedAt: null, wasRetroactive: false, derivedPercent: null, declaredPercent: null,
    },
    disposition: {
      type: 'pending', reasonId: null, comment: null,
      rescheduledToDay: null, derivedPercentAtClose: null,
    },
    hasChildren: o.hasChildren ?? false,
    parentItemId: o.parentId ?? null,
    parentName: null,
    sortOrder: 0,
    loggedMinutes: 0,
  } as OccurrenceWithState
}

function makeInactiveItem(o: {
  id: string
  name: string
  startTime?: string
  deactivatedAt?: string
}): ItemWithSchedules {
  return {
    id: o.id, userId: 'u1', name: o.name,
    description: null, categoryId: null, valence: null, priority: null,
    quotaTarget: null, parentId: null, sortOrder: 0,
    dispositionPolicy: 'skip', creationSource: 'planned',
    deactivatedAt: (o.deactivatedAt ?? '2025-06-10T12:00:00Z') as unknown as Date,
    archivedAt: null,
    createdAt: '2025-01-01T12:00:00Z' as unknown as Date,
    schedules: [{
      id: `${o.id}-s0`, userId: 'u1', itemId: o.id, label: null,
      recurrenceRule: { type: 'daily' }, anchorDay: '2025-01-01',
      timingPrecision: o.startTime ? 'point' : 'none',
      timingBucketId: null,
      timingStartTime: o.startTime ?? null,
      timingEndTime: null, plannedDurationMin: null, sortOrder: 0,
      archivedAt: null, createdAt: '2025-01-01T12:00:00Z' as unknown as Date,
    }],
  } as ItemWithSchedules
}

const GUITAR = makeOcc({ id: 'occ-guitar', itemId: 'item-guitar', name: 'Guitar practice' })
const ROUTINE = makeOcc({
  id: 'occ-routine', itemId: 'item-routine', name: 'Morning routine', hasChildren: true,
})

async function setupApiMocks(
  page: Page,
  opts: { occs: OccurrenceWithState[]; inactive?: ItemWithSchedules[] } = { occs: [] }
) {
  await page.route('/me', (route) =>
    route.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } })
  )
  await page.route(/\/api\/occurrences\?start=.*&end=.*/, (route) =>
    route.fulfill({ json: opts.occs })
  )
  // §5.6 — the inactive slice is a distinct query. Matched before the bare /api/items
  // route below so the two can't collide.
  await page.route(/\/api\/items\?status=inactive/, (route) =>
    route.fulfill({ json: opts.inactive ?? [] })
  )
  await page.route(/\/api\/items$/,   (route) => route.fulfill({ json: [] }))
  await page.route('/api/buckets',     (route) => route.fulfill({ json: [] }))
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

// ── Pausing is not deleting ──────────────────────────────────────────────────

test.describe('§5.6 — pausing a task is offered separately from deleting it', () => {
  test('§5.6 a task row carries its own make-inactive button alongside delete', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, { occs: [GUITAR] })
    await goToListView(page)

    await expect(page.getByTestId('occ-deactivate-btn')).toBeVisible()
    await expect(page.getByTestId('occ-archive-btn')).toBeVisible()
  })

  test('§5.6 confirming calls the deactivate endpoint, never DELETE', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, { occs: [GUITAR] })

    const calls: string[] = []
    await page.route(/\/api\/items\/item-guitar\/deactivate$/, (route) => {
      calls.push(`${route.request().method()} deactivate`)
      return route.fulfill({
        json: { item: { id: 'item-guitar' }, affected: [{ id: 'item-guitar', name: 'Guitar practice' }], clearedFutureOccurrences: 3 },
      })
    })
    await page.route(/\/api\/items\/item-guitar$/, (route) => {
      calls.push(`${route.request().method()} item`)
      return route.fulfill({ status: 204, body: '' })
    })

    await goToListView(page)
    await page.getByTestId('occ-deactivate-btn').click()
    await page.getByTestId('confirm-modal-confirm').click()

    await expect.poll(() => calls).toEqual(['POST deactivate'])
  })

  test("§5.6 the confirmation says what is kept, and does not use the word delete", async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, { occs: [GUITAR] })
    await goToListView(page)

    await page.getByTestId('occ-deactivate-btn').click()
    const modal = page.getByTestId('confirm-modal')
    await expect(modal).toContainText('Guitar practice')
    await expect(modal).toContainText('Everything is kept')
    await expect(modal).not.toContainText('Delete')
    await expect(modal).not.toContainText('delete')
  })

  test('§5.4 a pause reads as reversible, not destructive: its button is not the danger button', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, { occs: [GUITAR] })
    await goToListView(page)

    await page.getByTestId('occ-deactivate-btn').click()
    await expect(page.getByTestId('confirm-modal-confirm')).not.toHaveClass(/btn--danger/)

    // The delete confirmation, by contrast, still is the danger button.
    await page.getByTestId('confirm-modal').getByRole('button', { name: 'Cancel' }).click()
    await page.getByTestId('occ-archive-btn').click()
    await expect(page.getByTestId('confirm-modal-confirm')).toHaveClass(/btn--danger/)
  })

  test('§5.6 cancelling changes nothing', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, { occs: [GUITAR] })

    let called = false
    await page.route(/\/api\/items\/.*\/deactivate$/, (route) => {
      called = true
      return route.fulfill({ json: { item: {}, affected: [], clearedFutureOccurrences: 0 } })
    })

    await goToListView(page)
    await page.getByTestId('occ-deactivate-btn').click()
    await page.getByTestId('confirm-modal').getByRole('button', { name: 'Cancel' }).click()

    await expect(page.getByTestId('confirm-modal')).toHaveCount(0)
    expect(called).toBe(false)
  })
})

// ── §4.1 — the cascade is disclosed before it happens ────────────────────────

test.describe('§5.6 / §4.1 — a cascade over sub-tasks is disclosed up front', () => {
  test('§5.6 pausing a parent warns that its sub-tasks go with it', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, { occs: [ROUTINE] })
    await goToListView(page)

    await page.getByTestId('occ-deactivate-btn').first().click()
    await expect(page.getByTestId('confirm-modal')).toContainText('and its sub-tasks')
  })

  test('§5.6 pausing a leaf makes no claim about sub-tasks it does not have', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, { occs: [GUITAR] })
    await goToListView(page)

    await page.getByTestId('occ-deactivate-btn').click()
    await expect(page.getByTestId('confirm-modal')).not.toContainText('sub-tasks')
  })
})

// ── The inactive list ────────────────────────────────────────────────────────

test.describe('§5.6 — the inactive list is where paused tasks are found', () => {
  test('§5.6 the toolbar offers the inactive list with a count', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, {
      occs: [GUITAR],
      inactive: [
        makeInactiveItem({ id: 'item-anki', name: 'Japanese Anki', startTime: '21:00' }),
        makeInactiveItem({ id: 'item-run', name: 'Long run', startTime: '07:00' }),
      ],
    })
    await goToListView(page)

    await page.getByTestId('toggle-inactive').click()
    await expect(page.getByTestId('inactive-panel')).toBeVisible()
    await expect(page.getByTestId('toggle-inactive')).toContainText('(2)')
  })

  test('§5.6 each row shows the schedule that survived the pause', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, {
      occs: [],
      inactive: [makeInactiveItem({ id: 'item-anki', name: 'Japanese Anki', startTime: '21:00' })],
    })
    await goToListView(page)
    await page.getByTestId('toggle-inactive').click()

    const row = page.getByTestId('inactive-row-item-anki')
    await expect(row).toContainText('Japanese Anki')
    // The configuration is intact and shown — the entire reason to pause not delete.
    await expect(row).toContainText('every day')
    await expect(row).toContainText('inactive since')
  })

  test('§5.6 the inactive list replaces the occurrence list rather than filtering it', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, {
      occs: [GUITAR],
      inactive: [makeInactiveItem({ id: 'item-anki', name: 'Japanese Anki' })],
    })
    await goToListView(page)

    await expect(page.getByText('Guitar practice')).toBeVisible()
    await page.getByTestId('toggle-inactive').click()

    // An inactive item has no occurrences, so this cannot be a filter over the
    // occurrence list — today's tasks are gone while the panel is open.
    await expect(page.getByText('Guitar practice')).toHaveCount(0)
    await expect(page.getByText('Japanese Anki')).toBeVisible()

    await page.getByTestId('toggle-inactive').click()
    await expect(page.getByText('Guitar practice')).toBeVisible()
  })

  test('§5.6 the empty state explains how something gets here', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, { occs: [GUITAR], inactive: [] })
    await goToListView(page)

    await page.getByTestId('toggle-inactive').click()
    await expect(page.getByTestId('inactive-empty')).toBeVisible()
    // Findable before you have any: the toggle is the only route to this panel.
    await expect(page.getByTestId('toggle-inactive')).toBeVisible()
  })

  test('§5.6 an inactive task can be edited from the list', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, {
      occs: [],
      inactive: [makeInactiveItem({ id: 'item-anki', name: 'Japanese Anki' })],
    })
    await page.route(/\/api\/items\/item-anki$/, (route) =>
      route.fulfill({
        json: {
          ...makeInactiveItem({ id: 'item-anki', name: 'Japanese Anki' }),
          children: [], prerequisites: [],
        },
      })
    )
    await goToListView(page)
    await page.getByTestId('toggle-inactive').click()
    await page.getByTestId('inactive-edit-item-anki').click()

    await expect(page.getByTestId('item-form-modal')).toBeVisible()
  })
})

// ── Reactivation ─────────────────────────────────────────────────────────────

test.describe('§5.6 — reactivating from the inactive list', () => {
  test('§5.6 reactivating calls the endpoint and drops the row', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, {
      occs: [],
      inactive: [
        makeInactiveItem({ id: 'item-anki', name: 'Japanese Anki' }),
        makeInactiveItem({ id: 'item-run', name: 'Long run' }),
      ],
    })
    await page.route(/\/api\/items\/item-anki\/reactivate$/, (route) =>
      route.fulfill({
        json: {
          item: { id: 'item-anki' },
          affected: [{ id: 'item-anki', name: 'Japanese Anki' }],
          clearedFutureOccurrences: 0,
        },
      })
    )

    await goToListView(page)
    await page.getByTestId('toggle-inactive').click()
    await page.getByTestId('inactive-reactivate-item-anki').click()

    await expect(page.getByTestId('inactive-row-item-anki')).toHaveCount(0)
    await expect(page.getByTestId('inactive-row-item-run')).toBeVisible()
    await expect(page.getByTestId('toggle-inactive')).toContainText('(1)')
  })

  test('§5.6 reactivating a parent removes the children it brings back with it', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, {
      occs: [],
      inactive: [
        makeInactiveItem({ id: 'item-routine', name: 'Morning routine' }),
        makeInactiveItem({ id: 'item-stretch', name: 'Stretch' }),
      ],
    })
    await page.route(/\/api\/items\/item-routine\/reactivate$/, (route) =>
      route.fulfill({
        json: {
          item: { id: 'item-routine' },
          affected: [
            { id: 'item-routine', name: 'Morning routine' },
            { id: 'item-stretch', name: 'Stretch' },
          ],
          clearedFutureOccurrences: 0,
        },
      })
    )

    await goToListView(page)
    await page.getByTestId('toggle-inactive').click()
    await page.getByTestId('inactive-reactivate-item-routine').click()

    // Both rows go: the cascade brought the child back too, and leaving it listed
    // as inactive would be a lie about the state it is now in.
    await expect(page.getByTestId('inactive-row-item-routine')).toHaveCount(0)
    await expect(page.getByTestId('inactive-row-item-stretch')).toHaveCount(0)
    await expect(page.getByTestId('inactive-empty')).toBeVisible()
  })

  test("§5.6 a refusal is shown with the server's reason, and the row stays", async ({ page }) => {
    await page.clock.setFixedTime(new Date('2025-06-16T09:00:00'))
    await setupApiMocks(page, {
      occs: [],
      inactive: [makeInactiveItem({ id: 'item-stretch', name: 'Stretch' })],
    })
    await page.route(/\/api\/items\/item-stretch\/reactivate$/, (route) =>
      route.fulfill({
        status: 409,
        json: {
          error: 'ancestor_inactive',
          message: '"Morning routine" is inactive, and this is part of it (§5.6). Reactivate "Morning routine" first — that will bring this back with it.',
        },
      })
    )

    await goToListView(page)
    await page.getByTestId('toggle-inactive').click()
    await page.getByTestId('inactive-reactivate-item-stretch').click()

    // Verbatim: the refusal already names the blocker and the fix, and a generic
    // "something went wrong" would throw both away.
    await expect(page.getByTestId('inactive-error')).toContainText('Morning routine')
    await expect(page.getByTestId('inactive-error')).toContainText('Reactivate')
    await expect(page.getByTestId('inactive-row-item-stretch')).toBeVisible()
  })
})
