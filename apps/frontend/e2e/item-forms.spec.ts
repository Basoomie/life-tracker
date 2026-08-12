// §4c-ii — Item create/edit form Playwright tests.
// Tests are named after the spec rules they verify (§CLAUDE.md).
//
// Two doorways: quick-add (§4c-ii quick-add) and full-edit (§4c-ii full-edit).
// Ad-hoc capture (§9.2) is already tested in now-view.spec.ts — not duplicated here.

import { test, expect, type Page } from '@playwright/test'
import type {
  OccurrenceWithState, Item, ItemSchedule, ItemWithSchedules, Bucket, Category,
} from '@tracker/shared'

// ── Fixture builders ──────────────────────────────────────────────────────────

function makeOcc(overrides: {
  id: string
  itemId: string
  name: string
  snapshot?: Partial<OccurrenceWithState['snapshot']>
  parentName?: string | null   // §4.1 — only needed by detached-child fixtures
}): OccurrenceWithState {
  return {
    id: overrides.id,
    userId: 'u1',
    itemId: overrides.itemId,
    // §5.5 — matches the schedule id makeItem gives the same item's first slot.
    scheduleId: `${overrides.itemId}-s0`,
    appliesToDay: '2026-07-07',
    materializedAt: '2026-07-07T04:00:00Z' as unknown as null,
    snapshot: {
      name: overrides.name,
      description: null,
      categoryId: null,
      valence: null,
      priority: null,
      recurrenceRule: null,
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
    },
    disposition: {
      type: 'pending',
      reasonId: null,
      comment: null,
      rescheduledToDay: null,
      derivedPercentAtClose: null,
    },
    hasChildren: false,
    // §4.1 — live containment. Mirrors the fixture's snapshot.parentId, which is
    // what these fixtures already express nesting with.
    parentItemId: overrides.snapshot?.parentId ?? null,
    parentName: overrides.parentName ?? null,
    sortOrder: 0,
    loggedMinutes: 0,
  } as OccurrenceWithState
}

// §5.5 — an item travels with its schedules. Callers still pass the slot's fields
// flat (recurrenceRule, timing*, …) because that is how the create API and the form
// think about a new item; this assembles the one-slot shape the API actually returns.
type ItemOverrides = Partial<Item> & {
  id: string
  name: string
  recurrenceRule?: ItemSchedule['recurrenceRule']
  anchorDay?: string | null
  timingPrecision?: ItemSchedule['timingPrecision']
  timingBucketId?: string | null
  timingStartTime?: string | null
  timingEndTime?: string | null
  plannedDurationMin?: number | null
}

function makeItem(overrides: ItemOverrides): ItemWithSchedules {
  const {
    recurrenceRule = null,
    anchorDay = null,
    timingPrecision = 'none',
    timingBucketId = null,
    timingStartTime = null,
    timingEndTime = null,
    plannedDurationMin = null,
    ...itemFields
  } = overrides

  return {
    userId: 'u1',
    description: null,
    categoryId: null,
    valence: null,
    priority: null,
    quotaTarget: null,
    parentId: null,
    sortOrder: 0,
    dispositionPolicy: 'skip',
    creationSource: 'planned',
    archivedAt: null,
    createdAt: new Date() as unknown as Date,
    ...itemFields,
    schedules: [
      {
        id: `${overrides.id}-s0`,
        userId: 'u1',
        itemId: overrides.id,
        label: null,
        recurrenceRule,
        anchorDay,
        timingPrecision,
        timingBucketId,
        timingStartTime,
        timingEndTime,
        plannedDurationMin,
        sortOrder: 0,
        archivedAt: null,
        createdAt: new Date() as unknown as Date,
      },
    ],
  } as ItemWithSchedules
}

// §5.5 — saving a full edit syncs the item's slots through the schedule routes as
// well as PATCHing the item, so every full-edit test needs those routes answered.
// Returns a getter for the schedule bodies sent, for tests that assert on them.
async function routeScheduleSync(page: Page, item: ItemWithSchedules) {
  const bodies: Record<string, unknown>[] = []
  await page.route(`/api/items/${item.id}/schedules`, async (route) => {
    bodies.push(JSON.parse(route.request().postData() ?? '{}'))
    await route.fulfill({ json: item.schedules[0] })
  })
  await page.route(new RegExp(`/api/items/${item.id}/schedules/[^/]+$`), async (route) => {
    if (route.request().method() !== 'DELETE') {
      bodies.push(JSON.parse(route.request().postData() ?? '{}'))
    }
    await route.fulfill({ json: item.schedules[0] })
  })
  return () => bodies
}

// Open the full-edit form via the edit button on an occurrence row.
async function openFullEditForItem(page: Page, item: ItemWithSchedules) {
  const occ = makeOcc({ id: `occ-${item.id}`, itemId: item.id, name: item.name })
  await page.route('/me', (r) => r.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } }))
  await page.route(/\/api\/occurrences\?start=.*&end=.*/, (r) => r.fulfill({ json: [occ] }))
  await page.route('/api/buckets',           (r) => r.fulfill({ json: BUCKETS }))
  await page.route('/api/categories',        (r) => r.fulfill({ json: CATEGORIES }))
  await page.route('/api/reasons',           (r) => r.fulfill({ json: [] }))
  await page.route('/api/preferences',       (r) => r.fulfill({ json: {} }))
  await page.route('/api/items',             (r) => r.fulfill({ json: [item] }))
  await page.route(`/api/items/${item.id}`,  (r) =>
    r.fulfill({ json: { ...item, children: [], prerequisites: [] } })
  )
  await routeScheduleSync(page, item)
  await page.goto('/')
  // Click the edit button on the occurrence row
  await page.getByTestId(`occ-row-${occ.id}`).getByTestId('occ-edit-btn').click()
  await expect(page.getByTestId('item-form-modal')).toBeVisible()
  // Wait for async data load to complete before tests interact with form fields
  await expect(page.getByTestId('if-name')).toBeVisible()
}

const BUCKETS: Bucket[] = [
  {
    id: 'b-morn', userId: 'u1', name: 'Morning',
    startTime: '06:00', endTime: '12:00', sortOrder: 1,
    createdAt: new Date() as unknown as Date,
  },
  {
    id: 'b-eve', userId: 'u1', name: 'Evening',
    startTime: '18:00', endTime: '22:00', sortOrder: 2,
    createdAt: new Date() as unknown as Date,
  },
]

const CATEGORIES: Category[] = [
  { id: 'cat-fit', userId: 'u1', name: 'Fitness', archivedAt: null, createdAt: new Date() as unknown as Date },
]

// A one-time task occurrence
const OCC_TASK = makeOcc({ id: 'occ-task', itemId: 'item-task', name: 'Morning Run' })

// The item behind OCC_TASK
const ITEM_TASK = makeItem({ id: 'item-task', name: 'Morning Run' })

// A habit (recurring) — should be EXCLUDED from prereq picker
const ITEM_HABIT = makeItem({
  id: 'item-habit', name: 'Daily Meditation',
  recurrenceRule: { type: 'daily' },
})

// ── Common mock setup ─────────────────────────────────────────────────────────

async function setupBase(page: Page, occurrences: OccurrenceWithState[] = []) {
  await page.route('/me', (r) =>
    r.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } })
  )
  await page.route(/\/api\/occurrences\?start=.*&end=.*/, (r) => r.fulfill({ json: occurrences }))
  await page.route('/api/buckets',           (r) => r.fulfill({ json: BUCKETS }))
  await page.route('/api/categories',        (r) => r.fulfill({ json: CATEGORIES }))
  await page.route('/api/reasons',           (r) => r.fulfill({ json: [] }))
  await page.route('/api/preferences',       (r) => r.fulfill({ json: {} }))
  await page.route('/api/items',             (r) => r.fulfill({ json: [] }))
}

// ─────────────────────────────────────────────────────────────────────────────
// §4c-ii — Quick-add
// ─────────────────────────────────────────────────────────────────────────────
test.describe('§4c-ii — Quick-add doorway', () => {

  test('§4c-ii quick-add: name-only creates a valid planned one-time item with no timer running', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await setupBase(page)

    const createdItem = makeItem({ id: 'new-item', name: 'Read chapter 5', creationSource: 'planned' })

    let capturedBody: Record<string, unknown> | null = null
    await page.route('/api/items', async (route) => {
      if (route.request().method() === 'POST') {
        capturedBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
        await route.fulfill({ status: 201, json: createdItem })
      } else {
        await route.fulfill({ json: [] })
      }
    })

    await page.goto('/')
    await page.getByTestId('quick-add-btn').click()
    await expect(page.getByTestId('quick-add-modal')).toBeVisible()

    await page.getByTestId('qa-name').fill('Read chapter 5')
    await page.getByTestId('qa-submit').click()

    // Success state shown
    await expect(page.getByTestId('qa-created-name')).toContainText('Read chapter 5')

    // Verify API called with correct body
    expect(capturedBody).not.toBeNull()
    expect(capturedBody!['name']).toBe('Read chapter 5')
    expect(capturedBody!['creationSource']).toBe('planned')

    // Modal closed means no timer — assert the timer element does NOT appear in the now view
    await page.getByTestId('qa-done').click()
    await expect(page.getByTestId('quick-add-modal')).not.toBeVisible()
    // No timer-running element anywhere on page (contrast with ad-hoc)
    await expect(page.getByTestId('timer-running')).not.toBeVisible()
  })

  test('§4c-ii quick-add ≠ §9.2 ad-hoc: quick-add does not start a timer; ad-hoc (existing) does', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))

    const quickItem = makeItem({ id: 'qi', name: 'Quick task', creationSource: 'planned' })
    const adhocOcc = makeOcc({ id: 'adhoc-occ', itemId: 'adhoc-item', name: 'Ad-hoc thing' })

    await setupBase(page)

    await page.route('/api/items', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ status: 201, json: quickItem })
      } else {
        await route.fulfill({ json: [] })
      }
    })
    await page.route('/api/ad-hoc', (r) =>
      r.fulfill({ status: 201, json: { item: { id: 'adhoc-item' }, occurrence: { id: 'adhoc-occ' }, sessionId: 'sess-1' } })
    )

    // Track whether ad-hoc was created so refresh returns updated occurrences
    let adhocCreated = false
    await page.route(/\/api\/occurrences\?start=.*&end=.*/, (route) => {
      route.fulfill({ json: adhocCreated ? [adhocOcc] : [] })
    })

    await page.goto('/')

    // Quick-add path
    await page.getByTestId('quick-add-btn').click()
    await page.getByTestId('qa-name').fill('Quick task')
    await page.getByTestId('qa-submit').click()
    await expect(page.getByTestId('qa-created-name')).toBeVisible()
    await page.getByTestId('qa-done').click()
    // No timer started
    await expect(page.getByTestId('timer-running')).not.toBeVisible()

    // Ad-hoc path — timer IS started immediately
    adhocCreated = true
    await page.getByTestId('adhoc-btn').click()
    await page.getByTestId('adhoc-name').fill('Ad-hoc thing')
    await page.getByTestId('adhoc-submit').click()
    await expect(page.getByTestId('adhoc-modal')).not.toBeVisible()
    await expect(page.getByTestId('timer-running')).toBeVisible()
  })

  test('§4c-ii quick-add: optional "tomorrow" day sets day correctly in POST body', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await setupBase(page)

    const createdItem = makeItem({ id: 'qi2', name: 'Tomorrow task' })
    let capturedBody: Record<string, unknown> | null = null
    await page.route('/api/items', async (route) => {
      if (route.request().method() === 'POST') {
        capturedBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
        await route.fulfill({ status: 201, json: createdItem })
      } else {
        await route.fulfill({ json: [] })
      }
    })

    await page.goto('/')
    await page.getByTestId('quick-add-btn').click()
    await page.getByTestId('qa-name').fill('Tomorrow task')

    // Select "Tomorrow"
    await page.getByTestId('qa-day-tomorrow').click()
    await page.getByTestId('qa-submit').click()

    await expect(page.getByTestId('qa-created-name')).toBeVisible()
    expect(capturedBody!['day']).toBe('2026-07-08')
  })

  test('§4c-ii quick-add: optional bucket time sets timingPrecision and timingBucketId in POST body', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await setupBase(page)

    const createdItem = makeItem({ id: 'qi3', name: 'Bucket task', timingPrecision: 'bucket', timingBucketId: 'b-morn' })
    let capturedBody: Record<string, unknown> | null = null
    await page.route('/api/items', async (route) => {
      if (route.request().method() === 'POST') {
        capturedBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
        await route.fulfill({ status: 201, json: createdItem })
      } else {
        await route.fulfill({ json: [] })
      }
    })

    await page.goto('/')
    await page.getByTestId('quick-add-btn').click()
    await page.getByTestId('qa-name').fill('Bucket task')

    // Select "Bucket" time option
    await page.getByTestId('qa-time-bucket').click()
    // Bucket select should appear with Morning as first option
    await expect(page.getByTestId('qa-bucket-select')).toBeVisible()

    await page.getByTestId('qa-submit').click()
    await expect(page.getByTestId('qa-created-name')).toBeVisible()
    expect(capturedBody!['timingPrecision']).toBe('bucket')
    expect(capturedBody!['timingBucketId']).toBe('b-morn')
  })

  test('§4c-ii quick-add: optional planned duration sets plannedDurationMin in POST body', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await setupBase(page)

    const createdItem = makeItem({ id: 'qi4', name: 'Timed task', plannedDurationMin: 45 })
    let capturedBody: Record<string, unknown> | null = null
    await page.route('/api/items', async (route) => {
      if (route.request().method() === 'POST') {
        capturedBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
        await route.fulfill({ status: 201, json: createdItem })
      } else {
        await route.fulfill({ json: [] })
      }
    })

    await page.goto('/')
    await page.getByTestId('quick-add-btn').click()
    await page.getByTestId('qa-name').fill('Timed task')
    await page.getByTestId('qa-duration').fill('45')
    await page.getByTestId('qa-submit').click()

    await expect(page.getByTestId('qa-created-name')).toBeVisible()
    expect(capturedBody!['plannedDurationMin']).toBe(45)
  })

  test('§4c-ii quick-add: no recurrence, prerequisite, or nesting fields are exposed', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await setupBase(page)
    await page.goto('/')
    await page.getByTestId('quick-add-btn').click()
    await expect(page.getByTestId('quick-add-modal')).toBeVisible()

    // These fields must NOT be present in quick-add
    await expect(page.getByTestId('if-type-recurring')).not.toBeVisible()
    await expect(page.getByTestId('if-recurrence-section')).not.toBeVisible()
    await expect(page.getByTestId('if-prereq-list')).not.toBeVisible()
    await expect(page.getByTestId('if-parent')).not.toBeVisible()
  })

  test('§4c-ii quick-add: success state offers "Open full edit" for elaboration', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await setupBase(page)

    const createdItem = makeItem({ id: 'qi5', name: 'Elaborate me' })
    await page.route('/api/items', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ status: 201, json: createdItem })
      } else {
        await route.fulfill({ json: [] })
      }
    })
    // Mock for when ItemFormModal loads the item
    await page.route('/api/items/qi5', (r) =>
      r.fulfill({ json: { ...createdItem, children: [], prerequisites: [] } })
    )

    await page.goto('/')
    await page.getByTestId('quick-add-btn').click()
    await page.getByTestId('qa-name').fill('Elaborate me')
    await page.getByTestId('qa-submit').click()

    // Success state shown with "Open full edit" button
    await expect(page.getByTestId('qa-open-full-edit')).toBeVisible()

    // Click it — ItemFormModal opens in edit mode
    await page.getByTestId('qa-open-full-edit').click()
    await expect(page.getByTestId('item-form-modal')).toBeVisible()
    // QuickAddModal is gone
    await expect(page.getByTestId('quick-add-modal')).not.toBeVisible()
  })

})

// ─────────────────────────────────────────────────────────────────────────────
// §4c-ii — Full-edit progressive disclosure
// ─────────────────────────────────────────────────────────────────────────────
test.describe('§4c-ii — Full-edit progressive disclosure', () => {

  test('§5.1 / §4c-ii full-edit progressive disclosure: one-time hides recurrence and quota', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await openFullEditForItem(page, ITEM_TASK)

    // One-time is selected (item has no recurrenceRule)
    await expect(page.getByTestId('if-type-onetime')).toHaveClass(/qa-radio--active/)

    // Recurrence section and quota section must be hidden
    await expect(page.getByTestId('if-recurrence-section')).not.toBeVisible()
    await expect(page.getByTestId('if-quota-section')).not.toBeVisible()
  })

  test('§5.1 / §4c-ii full-edit progressive disclosure: recurring reveals recurrence builder and quota', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await openFullEditForItem(page, ITEM_TASK)

    // Switch to recurring
    await page.getByTestId('if-type-recurring').click()

    // Recurrence section now visible
    await expect(page.getByTestId('if-recurrence-section')).toBeVisible()
    // Quota section visible inside recurrence section
    await expect(page.getByTestId('if-quota-section')).toBeVisible()
  })

  test('§6.8 / §4c-ii full-edit progressive disclosure: range timing hides standalone planned-duration', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await openFullEditForItem(page, ITEM_TASK)

    // Select "range" timing
    await page.getByTestId('if-timing-range').click()

    // Planned-duration section must be hidden (§6.8 — range implies duration)
    await expect(page.getByTestId('if-duration-section')).not.toBeVisible()
  })

  test('§6.8 / §4c-ii full-edit progressive disclosure: none/bucket/point show optional planned-duration', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await openFullEditForItem(page, ITEM_TASK)

    // none → duration visible (default)
    await page.getByTestId('if-timing-none').click()
    await expect(page.getByTestId('if-duration-section')).toBeVisible()

    // bucket → duration visible
    await page.getByTestId('if-timing-bucket').click()
    await expect(page.getByTestId('if-duration-section')).toBeVisible()

    // point → duration visible
    await page.getByTestId('if-timing-point').click()
    await expect(page.getByTestId('if-duration-section')).toBeVisible()

    // range → duration hidden
    await page.getByTestId('if-timing-range').click()
    await expect(page.getByTestId('if-duration-section')).not.toBeVisible()
  })

  test('§5.1 / §4c-ii full-edit recurrence builder: each rule shape renders correct sub-inputs', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await openFullEditForItem(page, ITEM_TASK)
    await page.getByTestId('if-type-recurring').click()

    // daily: no sub-inputs beyond type selector
    await page.getByTestId('if-rec-daily').click()
    await expect(page.getByTestId('if-days-of-week')).not.toBeVisible()
    await expect(page.getByTestId('if-rec-every')).not.toBeVisible()

    // days_of_week: shows day checkboxes
    await page.getByTestId('if-rec-days_of_week').click()
    await expect(page.getByTestId('if-days-of-week')).toBeVisible()
    await expect(page.getByTestId('if-rec-every')).not.toBeVisible()

    // interval_day: shows N input
    await page.getByTestId('if-rec-interval_day').click()
    await expect(page.getByTestId('if-rec-every')).toBeVisible()
    await expect(page.getByTestId('if-days-of-week')).not.toBeVisible()

    // interval_week: shows N input
    await page.getByTestId('if-rec-interval_week').click()
    await expect(page.getByTestId('if-rec-every')).toBeVisible()

    // monthly: no N input, no day checkboxes
    await page.getByTestId('if-rec-monthly').click()
    await expect(page.getByTestId('if-rec-every')).not.toBeVisible()
    await expect(page.getByTestId('if-days-of-week')).not.toBeVisible()
  })

  test('§5.1 / §4c-ii recurrence rule round-trips correctly through API body (daily)', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))

    const habitItem = makeItem({ id: 'item-habit-2', name: 'New Habit', recurrenceRule: { type: 'daily' } })
    await openFullEditForItem(page, habitItem)

    // §5.5 — the rule belongs to the item's SCHEDULE, so an edit sends it to the
    // schedule route, not to PATCH /items/:id.
    const scheduleBodies = await routeScheduleSync(page, habitItem)

    // Form pre-populated as recurring with daily rule
    await expect(page.getByTestId('if-type-recurring')).toHaveClass(/qa-radio--active/)
    await expect(page.getByTestId('if-rec-daily')).toHaveClass(/qa-radio--active/)

    // Submit without changing anything
    await page.getByTestId('if-submit').click()
    await expect(page.getByTestId('item-form-modal')).not.toBeVisible()

    const sent = scheduleBodies()
    expect(sent).toHaveLength(1)
    expect((sent[0]['recurrenceRule'] as { type: string })?.type).toBe('daily')
  })

  test('§5.1 / §4c-ii recurrence rule round-trips correctly through API body (days_of_week MWF)', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))

    const mwfItem = makeItem({
      id: 'item-mwf', name: 'MWF Habit',
      recurrenceRule: { type: 'days_of_week', days: [1, 3, 5] },
    })
    await openFullEditForItem(page, mwfItem)

    // §5.5 — the rule is sent to the schedule route (see the daily case above).
    const scheduleBodies = await routeScheduleSync(page, mwfItem)

    // Pre-populated: days_of_week selected, Mon/Wed/Fri checked
    await expect(page.getByTestId('if-rec-days_of_week')).toHaveClass(/qa-radio--active/)
    await expect(page.getByTestId('if-day-mon')).toHaveClass(/day-chip--active/)
    await expect(page.getByTestId('if-day-wed')).toHaveClass(/day-chip--active/)
    await expect(page.getByTestId('if-day-fri')).toHaveClass(/day-chip--active/)
    await expect(page.getByTestId('if-day-sun')).not.toHaveClass(/day-chip--active/)

    await page.getByTestId('if-submit').click()
    await expect(page.getByTestId('item-form-modal')).not.toBeVisible()

    const rule = scheduleBodies()[0]['recurrenceRule'] as { type: string; days: number[] }
    expect(rule.type).toBe('days_of_week')
    expect(rule.days.sort()).toEqual([1, 3, 5])
  })

  test('§5.1 new recurring item: "Starts on" defaults to today and is sent as anchorDay', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await setupBase(page)

    const createdItem = makeItem({ id: 'new-habit', name: 'New Habit', recurrenceRule: { type: 'daily' } })
    let capturedBody: Record<string, unknown> | null = null
    await page.route('/api/items', async (route) => {
      if (route.request().method() === 'POST') {
        capturedBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
        await route.fulfill({ status: 201, json: createdItem })
      } else {
        await route.fulfill({ json: [] })
      }
    })

    await page.goto('/')
    await page.getByTestId('new-item-btn').click()
    await expect(page.getByTestId('item-form-modal')).toBeVisible()
    await page.getByTestId('if-name').fill('New Habit')
    await page.getByTestId('if-type-recurring').click()

    // Defaults to today, with no user interaction
    await expect(page.getByTestId('if-anchor-day')).toHaveValue('2026-07-07')

    await page.getByTestId('if-submit').click()
    await expect(page.getByTestId('item-form-modal')).not.toBeVisible()
    expect(capturedBody!['anchorDay']).toBe('2026-07-07')
  })

  test('§5.1 new recurring item: a custom "Starts on" date is sent as anchorDay', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await setupBase(page)

    const createdItem = makeItem({ id: 'new-habit-2', name: 'Future Habit', recurrenceRule: { type: 'interval', unit: 'week', every: 2 } })
    let capturedBody: Record<string, unknown> | null = null
    await page.route('/api/items', async (route) => {
      if (route.request().method() === 'POST') {
        capturedBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
        await route.fulfill({ status: 201, json: createdItem })
      } else {
        await route.fulfill({ json: [] })
      }
    })

    await page.goto('/')
    await page.getByTestId('new-item-btn').click()
    await expect(page.getByTestId('item-form-modal')).toBeVisible()
    await page.getByTestId('if-name').fill('Future Habit')
    await page.getByTestId('if-type-recurring').click()
    await page.getByTestId('if-rec-interval_week').click()

    await page.getByTestId('if-anchor-day').fill('2026-08-15')
    await page.getByTestId('if-submit').click()

    await expect(page.getByTestId('item-form-modal')).not.toBeVisible()
    expect(capturedBody!['anchorDay']).toBe('2026-08-15')
  })

  test('§5.1 one-time task: no "Starts on" field, and anchorDay is omitted from the POST body', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await setupBase(page)

    const createdItem = makeItem({ id: 'new-task', name: 'One-off task' })
    let capturedBody: Record<string, unknown> | null = null
    await page.route('/api/items', async (route) => {
      if (route.request().method() === 'POST') {
        capturedBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
        await route.fulfill({ status: 201, json: createdItem })
      } else {
        await route.fulfill({ json: [] })
      }
    })

    await page.goto('/')
    await page.getByTestId('new-item-btn').click()
    await expect(page.getByTestId('item-form-modal')).toBeVisible()
    await page.getByTestId('if-name').fill('One-off task')

    // One-time is the default type — no anchor-day field should be shown
    await expect(page.getByTestId('if-anchor-day')).not.toBeVisible()

    await page.getByTestId('if-submit').click()
    await expect(page.getByTestId('item-form-modal')).not.toBeVisible()
    expect(capturedBody).not.toHaveProperty('anchorDay')
  })

})

// ─────────────────────────────────────────────────────────────────────────────
// §4.2 / §4c-ii — Prerequisite picker
// ─────────────────────────────────────────────────────────────────────────────
test.describe('§4.2 / §4c-ii — Prerequisites in full-edit', () => {

  test('§4.2 / §4c-ii prereq picker excludes habits; includes only tasks', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await page.route('/me', (r) => r.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } }))

    const occ = makeOcc({ id: 'occ-t', itemId: 'item-task', name: 'Morning Run' })
    await page.route(/\/api\/occurrences\?start=.*&end=.*/, (r) => r.fulfill({ json: [occ] }))
    await page.route('/api/buckets',     (r) => r.fulfill({ json: BUCKETS }))
    await page.route('/api/categories',  (r) => r.fulfill({ json: CATEGORIES }))
    await page.route('/api/reasons',     (r) => r.fulfill({ json: [] }))
    await page.route('/api/preferences', (r) => r.fulfill({ json: {} }))

    // Two other items: one task, one habit
    const otherTask  = makeItem({ id: 'other-task',  name: 'Other Task',  recurrenceRule: null })
    const otherHabit = makeItem({ id: 'other-habit', name: 'Daily habit', recurrenceRule: { type: 'daily' } })

    await page.route('/api/items', (r) =>
      r.fulfill({ json: [ITEM_TASK, otherTask, otherHabit] })
    )
    await page.route('/api/items/item-task', (r) =>
      r.fulfill({ json: { ...ITEM_TASK, children: [], prerequisites: [] } })
    )

    await page.goto('/')
    await page.getByTestId('occ-row-occ-t').getByTestId('occ-edit-btn').click()
    await expect(page.getByTestId('item-form-modal')).toBeVisible()
    await expect(page.getByTestId('if-name')).toBeVisible()

    // Open advanced section
    await page.getByTestId('if-advanced-toggle').click()

    // Prereq list visible
    await expect(page.getByTestId('if-prereq-list')).toBeVisible()

    // Task IS in the list; habit is NOT
    await expect(page.getByTestId(`prereq-${otherTask.id}`)).toBeVisible()
    await expect(page.getByTestId(`prereq-${otherHabit.id}`)).not.toBeVisible()

    // Self (item-task) is also excluded
    await expect(page.getByTestId(`prereq-${ITEM_TASK.id}`)).not.toBeVisible()
  })

  test('§4.2 / §4c-ii cycle-forming edge is rejected and error shown clearly', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await page.route('/me', (r) => r.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } }))

    const occ = makeOcc({ id: 'occ-t2', itemId: 'item-task', name: 'Morning Run' })
    await page.route(/\/api\/occurrences\?start=.*&end=.*/, (r) => r.fulfill({ json: [occ] }))
    await page.route('/api/buckets',     (r) => r.fulfill({ json: BUCKETS }))
    await page.route('/api/categories',  (r) => r.fulfill({ json: CATEGORIES }))
    await page.route('/api/reasons',     (r) => r.fulfill({ json: [] }))
    await page.route('/api/preferences', (r) => r.fulfill({ json: {} }))

    const otherTask = makeItem({ id: 'other-task', name: 'Other Task', recurrenceRule: null })
    await page.route('/api/items', (r) =>
      r.fulfill({ json: [ITEM_TASK, otherTask] })
    )
    await page.route('/api/items/item-task', (r) =>
      r.fulfill({ json: { ...ITEM_TASK, children: [], prerequisites: [] } })
    )
    await page.route('/api/items/item-task/prerequisites', async (route) => {
      // Simulate cycle rejection
      await route.fulfill({
        status: 400,
        json: { error: 'cycle_rejected', message: 'Adding this prerequisite would form a cycle' },
      })
    })
    await page.route('/api/items/item-task', async (route) => {
      if (route.request().method() === 'PATCH') {
        await route.fulfill({ json: ITEM_TASK })
      } else {
        await route.fulfill({ json: { ...ITEM_TASK, children: [], prerequisites: [] } })
      }
    })
    // §5.5 — saving also syncs the item's slots through the schedule routes.
    await routeScheduleSync(page, ITEM_TASK)

    await page.goto('/')
    await page.getByTestId('occ-row-occ-t2').getByTestId('occ-edit-btn').click()
    await expect(page.getByTestId('item-form-modal')).toBeVisible()
    await expect(page.getByTestId('if-name')).toBeVisible()

    // Open advanced, select prereq that would form a cycle
    await page.getByTestId('if-advanced-toggle').click()
    await page.getByTestId(`prereq-${otherTask.id}`).check()

    // Submit the form
    await page.getByTestId('if-submit').click()

    // Cycle error must be shown clearly
    await expect(page.getByTestId('prereq-error')).toBeVisible()
    await expect(page.getByTestId('prereq-error')).toContainText('cycle')

    // Modal stays open so user can fix the issue
    await expect(page.getByTestId('item-form-modal')).toBeVisible()
  })

})

// ─────────────────────────────────────────────────────────────────────────────
// §4.1 / §8.1 / §5.3 / §4c-ii — Other full-edit fields
// ─────────────────────────────────────────────────────────────────────────────
test.describe('§4c-ii — Full-edit: parent nesting, disposition, edit mode', () => {

  async function openEditForm(
    page: Page,
    item: ItemWithSchedules,
    allItems: ItemWithSchedules[] = [item]
  ) {
    const occ = makeOcc({ id: `occ-${item.id}`, itemId: item.id, name: item.name })
    await page.route('/me', (r) => r.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } }))
    await page.route(/\/api\/occurrences\?start=.*&end=.*/, (r) => r.fulfill({ json: [occ] }))
    await page.route('/api/buckets',     (r) => r.fulfill({ json: BUCKETS }))
    await page.route('/api/categories',  (r) => r.fulfill({ json: CATEGORIES }))
    await page.route('/api/reasons',     (r) => r.fulfill({ json: [] }))
    await page.route('/api/preferences', (r) => r.fulfill({ json: {} }))
    await page.route('/api/items',       (r) => r.fulfill({ json: allItems }))
    await page.route(`/api/items/${item.id}`, async (route) => {
      if (route.request().method() === 'PATCH') {
        const body = JSON.parse(route.request().postData() ?? '{}') as Partial<Item>
        await route.fulfill({ json: { ...item, ...body } })
      } else {
        await route.fulfill({ json: { ...item, children: [], prerequisites: [] } })
      }
    })
    // §5.5 — saving also syncs the item's slots through the schedule routes.
    await routeScheduleSync(page, item)
    await page.goto('/')
    await page.getByTestId(`occ-row-occ-${item.id}`).getByTestId('occ-edit-btn').click()
    await expect(page.getByTestId('item-form-modal')).toBeVisible()
    await expect(page.getByTestId('if-name')).toBeVisible()
  }

  test('§4.1 / §4c-ii parent nesting: selecting a parent includes parentId in PATCH body', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))

    const parentItem = makeItem({ id: 'parent-item', name: 'Night Routine' })
    await openEditForm(page, ITEM_TASK, [ITEM_TASK, parentItem])

    let capturedBody: Record<string, unknown> | null = null
    await page.route('/api/items/item-task', async (route) => {
      if (route.request().method() === 'PATCH') {
        capturedBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
        await route.fulfill({ json: ITEM_TASK })
      } else {
        await route.fulfill({ json: { ...ITEM_TASK, children: [], prerequisites: [] } })
      }
    })

    await page.getByTestId('if-advanced-toggle').click()
    await page.getByTestId('if-parent').selectOption('parent-item')
    await page.getByTestId('if-submit').click()

    await expect(page.getByTestId('item-form-modal')).not.toBeVisible()
    expect(capturedBody!['parentId']).toBe('parent-item')
  })

  test('§8.1 / §4c-ii disposition policy: each of four values is settable', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await openEditForm(page, ITEM_TASK)

    await page.getByTestId('if-advanced-toggle').click()

    // Default: skip
    await expect(page.getByTestId('if-disp-skip')).toHaveClass(/disp-option--selected/)

    // Switch to excuse
    await page.getByTestId('if-disp-excuse').click()
    await expect(page.getByTestId('if-disp-excuse')).toHaveClass(/disp-option--selected/)
    await expect(page.getByTestId('if-disp-skip')).not.toHaveClass(/disp-option--selected/)

    // Switch to auto_close
    await page.getByTestId('if-disp-auto_close').click()
    await expect(page.getByTestId('if-disp-auto_close')).toHaveClass(/disp-option--selected/)

    // Switch to require_manual
    await page.getByTestId('if-disp-require_manual').click()
    await expect(page.getByTestId('if-disp-require_manual')).toHaveClass(/disp-option--selected/)
  })

  test('§5.3 / §4c-ii edit mode: form pre-populates from item data and shows forward-only note', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))

    const detailedItem = makeItem({
      id: 'detailed', name: 'Japanese Immersion',
      categoryId: 'cat-fit',
      priority: 'high',
      valence: 'productive',
      timingPrecision: 'point',
      timingStartTime: '09:00',
      plannedDurationMin: 120,
      dispositionPolicy: 'excuse',
    })
    await openEditForm(page, detailedItem)

    // All fields pre-populated
    await expect(page.getByTestId('if-name')).toHaveValue('Japanese Immersion')
    await expect(page.getByTestId('if-priority')).toHaveValue('high')
    await expect(page.getByTestId('if-valence')).toHaveValue('productive')
    await expect(page.getByTestId('if-timing-point')).toHaveClass(/qa-radio--active/)
    await expect(page.getByTestId('if-start-time')).toHaveValue('09:00')
    await expect(page.getByTestId('if-duration')).toHaveValue('120')

    // Forward-only note visible in edit mode (§5.3)
    await expect(page.getByTestId('forward-only-note')).toBeVisible()

    // disposition pre-populated as 'excuse'
    await page.getByTestId('if-advanced-toggle').click()
    await expect(page.getByTestId('if-disp-excuse')).toHaveClass(/disp-option--selected/)
  })

  test('§11 / §4c-ii full-edit form is navigable at phone width (320px)', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await page.setViewportSize({ width: 320, height: 568 })
    await openEditForm(page, ITEM_TASK)

    // Key form elements visible at 320px
    await expect(page.getByTestId('if-name')).toBeVisible()
    await expect(page.getByTestId('if-type-onetime')).toBeVisible()
    await expect(page.getByTestId('if-timing-none')).toBeVisible()
    await expect(page.getByTestId('if-submit')).toBeVisible()

    // Form does not overflow the screen
    const modal = await page.locator('.modal--wide').boundingBox()
    expect(modal!.width).toBeLessThanOrEqual(320)
  })

})

// ─────────────────────────────────────────────────────────────────────────────
// §8.1 amendment — one-time tasks default to 'require_manual', not 'skip'
// ─────────────────────────────────────────────────────────────────────────────
// Not part of the original §8.1 spec text — added on direct user request: a
// missed one-off is far more often "haven't gotten to it yet" than a deliberate
// skip, so defaulting a fresh one-time task to auto-skip at end-of-day is the
// wrong default. Recurring habits keep the spec's stated 'skip' default.
test.describe('§8.1 amendment — create-mode disposition-policy default', () => {

  async function openCreateForm(page: Page) {
    await setupBase(page)
    await page.goto('/')
    await page.getByTestId('new-item-btn').click()
    await expect(page.getByTestId('item-form-modal')).toBeVisible()
    await expect(page.getByTestId('if-name')).toBeVisible()
  }

  test('§8.1 a brand-new item form defaults to one-time + require_manual', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await openCreateForm(page)

    await expect(page.getByTestId('if-type-onetime')).toHaveClass(/qa-radio--active/)

    await page.getByTestId('if-advanced-toggle').click()
    await expect(page.getByTestId('if-disp-require_manual')).toHaveClass(/disp-option--selected/)
  })

  test('§8.1 switching Type to Recurring re-defaults disposition to skip; switching back re-defaults to require_manual', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await openCreateForm(page)
    await page.getByTestId('if-advanced-toggle').click()

    await expect(page.getByTestId('if-disp-require_manual')).toHaveClass(/disp-option--selected/)

    await page.getByTestId('if-type-recurring').click()
    await expect(page.getByTestId('if-disp-skip')).toHaveClass(/disp-option--selected/)

    await page.getByTestId('if-type-onetime').click()
    await expect(page.getByTestId('if-disp-require_manual')).toHaveClass(/disp-option--selected/)
  })

  test('§8.1 an explicit disposition choice survives toggling Type (auto-default never clobbers a manual pick)', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await openCreateForm(page)
    await page.getByTestId('if-advanced-toggle').click()

    // User explicitly picks 'excuse' for this one-time task
    await page.getByTestId('if-disp-excuse').click()
    await expect(page.getByTestId('if-disp-excuse')).toHaveClass(/disp-option--selected/)

    // Toggling Type back and forth must not silently override the explicit choice
    await page.getByTestId('if-type-recurring').click()
    await page.getByTestId('if-type-onetime').click()
    await expect(page.getByTestId('if-disp-excuse')).toHaveClass(/disp-option--selected/)
  })

  test('§8.1 submitting a new one-time item without touching disposition sends require_manual', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await openCreateForm(page)

    let capturedBody: Record<string, unknown> | null = null
    await page.route('/api/items', async (route) => {
      if (route.request().method() === 'POST') {
        capturedBody = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>
        await route.fulfill({ status: 201, json: makeItem({ id: 'new-one-time', name: 'Renew passport' }) })
      } else {
        await route.fulfill({ json: [] })
      }
    })

    await page.getByTestId('if-name').fill('Renew passport')
    await page.getByTestId('if-submit').click()

    await expect(page.getByTestId('item-form-modal')).not.toBeVisible()
    expect(capturedBody!['dispositionPolicy']).toBe('require_manual')
  })

})

// ─────────────────────────────────────────────────────────────────────────────
// §5.5 — Multiple schedules per item
// ─────────────────────────────────────────────────────────────────────────────
// One task, several times of day. The single-slot case must look exactly as it
// always has; the extra slots appear only when asked for.
test.describe('§5.5 — multiple schedules per item', () => {

  async function openCreateForm(page: Page) {
    await setupBase(page)
    await page.goto('/')
    await page.getByTestId('new-item-btn').click()
    await expect(page.getByTestId('item-form-modal')).toBeVisible()
    await expect(page.getByTestId('if-name')).toBeVisible()
  }

  test('§5.5 a one-time task cannot carry several times — the add control is absent', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await openCreateForm(page)

    // Default is one-time; a task that happens once has exactly one "when".
    await expect(page.getByTestId('if-type-onetime')).toHaveClass(/qa-radio--active/)
    await expect(page.getByTestId('if-add-schedule')).not.toBeVisible()
  })

  test('§5.5 a recurring item offers "+ Add another time" and reveals a second slot', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await openCreateForm(page)
    await page.getByTestId('if-type-recurring').click()

    // One slot to start with — the common case is unchanged.
    await expect(page.getByTestId('if-slot-0')).toBeVisible()
    await expect(page.getByTestId('if-slot-1')).not.toBeVisible()

    await page.getByTestId('if-add-schedule').click()
    await expect(page.getByTestId('if-slot-1')).toBeVisible()
    // The second slot has its own independent rule and timing controls.
    await expect(page.getByTestId('if-slot-1-rec-days_of_week')).toBeVisible()
    await expect(page.getByTestId('if-slot-1-timing-range')).toBeVisible()
  })

  test('§5.5 a removed slot disappears from the form', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await openCreateForm(page)
    await page.getByTestId('if-type-recurring').click()

    await page.getByTestId('if-add-schedule').click()
    await expect(page.getByTestId('if-slot-1')).toBeVisible()

    await page.getByTestId('if-remove-schedule-1').click()
    await expect(page.getByTestId('if-slot-1')).not.toBeVisible()
    // The first slot is not removable — an item's last slot has to stay (§5.5).
    await expect(page.getByTestId('if-remove-schedule-0')).not.toBeVisible()
  })

  test('§5.5 creating a two-slot item posts the first slot with the item and the second to /schedules', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))
    await openCreateForm(page)

    const created = makeItem({ id: 'multi', name: 'Task A', recurrenceRule: { type: 'daily' } })
    let itemBody: Record<string, unknown> | null = null
    const scheduleBodies: Record<string, unknown>[] = []

    await page.route('/api/items', async (route) => {
      if (route.request().method() === 'POST') {
        itemBody = JSON.parse(route.request().postData() ?? '{}')
        await route.fulfill({ status: 201, json: created })
      } else {
        await route.fulfill({ json: [] })
      }
    })
    await page.route('/api/items/multi/schedules', async (route) => {
      scheduleBodies.push(JSON.parse(route.request().postData() ?? '{}'))
      await route.fulfill({ status: 201, json: created.schedules[0] })
    })

    await page.getByTestId('if-name').fill('Task A')
    await page.getByTestId('if-type-recurring').click()

    // Slot 0: Tue/Thu/Fri 08:30–09:30
    await page.getByTestId('if-rec-days_of_week').click()
    for (const d of ['tue', 'thu', 'fri']) await page.getByTestId(`if-day-${d}`).click()
    await page.getByTestId('if-timing-range').click()
    await page.getByTestId('if-start-time').fill('08:30')
    await page.getByTestId('if-end-time').fill('09:30')

    // Slot 1: every day at 13:00
    await page.getByTestId('if-add-schedule').click()
    await page.getByTestId('if-slot-1-label').fill('Afternoon')
    await page.getByTestId('if-slot-1-timing-point').click()
    await page.getByTestId('if-slot-1-start-time').fill('13:00')

    await page.getByTestId('if-submit').click()
    await expect(page.getByTestId('item-form-modal')).not.toBeVisible()

    // The item carries its FIRST slot's fields; the second went to /schedules.
    const rule = itemBody!['recurrenceRule'] as { type: string; days: number[] }
    expect(rule.type).toBe('days_of_week')
    expect(rule.days.sort()).toEqual([2, 4, 5])
    expect(itemBody!['timingStartTime']).toBe('08:30')

    expect(scheduleBodies).toHaveLength(1)
    expect(scheduleBodies[0]['label']).toBe('Afternoon')
    expect(scheduleBodies[0]['timingStartTime']).toBe('13:00')
    expect((scheduleBodies[0]['recurrenceRule'] as { type: string }).type).toBe('daily')
  })

  test('§5.5 editing a two-slot item pre-populates both slots and PATCHes each', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))

    const twoSlot = makeItem({
      id: 'two-slot', name: 'Task A', recurrenceRule: { type: 'days_of_week', days: [2, 4, 5] },
      timingPrecision: 'range', timingStartTime: '08:30:00', timingEndTime: '09:30:00',
    })
    twoSlot.schedules.push({
      ...twoSlot.schedules[0],
      id: 'two-slot-s1',
      label: 'Afternoon',
      recurrenceRule: { type: 'daily' },
      timingPrecision: 'point',
      timingStartTime: '13:00:00',
      timingEndTime: null,
      sortOrder: 1,
    })

    await openFullEditForItem(page, twoSlot)

    // Both slots pre-populate, each with its own rule and timing.
    await expect(page.getByTestId('if-rec-days_of_week')).toHaveClass(/qa-radio--active/)
    await expect(page.getByTestId('if-start-time')).toHaveValue('08:30')
    await expect(page.getByTestId('if-slot-1-label')).toHaveValue('Afternoon')
    await expect(page.getByTestId('if-slot-1-rec-daily')).toHaveClass(/qa-radio--active/)
    await expect(page.getByTestId('if-slot-1-start-time')).toHaveValue('13:00')

    // §5.5 — both slots are PATCHed through the schedule routes on save.
    const scheduleBodies = await routeScheduleSync(page, twoSlot)
    await page.getByTestId('if-submit').click()
    await expect(page.getByTestId('item-form-modal')).not.toBeVisible()
    expect(scheduleBodies()).toHaveLength(2)
  })

  test('§5.5 an item with sub-items cannot add a second time, and says why', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-07-07T08:00:00'))

    const parent = makeItem({ id: 'parent-x', name: 'Night Routine', recurrenceRule: { type: 'daily' } })
    const child = makeItem({ id: 'child-x', name: 'Skincare', recurrenceRule: { type: 'daily' } })

    const occ = makeOcc({ id: 'occ-parent-x', itemId: parent.id, name: parent.name })
    await page.route('/me', (r) => r.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } }))
    await page.route(/\/api\/occurrences\?start=.*&end=.*/, (r) => r.fulfill({ json: [occ] }))
    await page.route('/api/buckets',     (r) => r.fulfill({ json: BUCKETS }))
    await page.route('/api/categories',  (r) => r.fulfill({ json: CATEGORIES }))
    await page.route('/api/reasons',     (r) => r.fulfill({ json: [] }))
    await page.route('/api/preferences', (r) => r.fulfill({ json: {} }))
    await page.route('/api/items',       (r) => r.fulfill({ json: [parent, child] }))
    await page.route(`/api/items/${parent.id}`, (r) =>
      r.fulfill({ json: { ...parent, children: [child], prerequisites: [] } })
    )

    await page.goto('/')
    await page.getByTestId(`occ-row-${occ.id}`).getByTestId('occ-edit-btn').click()
    await expect(page.getByTestId('item-form-modal')).toBeVisible()
    await expect(page.getByTestId('if-name')).toBeVisible()

    await expect(page.getByTestId('if-add-schedule')).not.toBeVisible()
    await expect(page.getByTestId('if-add-schedule-blocked')).toBeVisible()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §4.1 — the parent picker reports the parent's own schedule
// ─────────────────────────────────────────────────────────────────────────────
test.describe('§4.1 — a child can see its parent\'s schedule without opening the parent', () => {

  test('§4.1 the parent picker reports the parent\'s recurrence and start day, not the child\'s', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-08-12T08:00:00'))

    // Same recurrence, different anchor day — the mismatch that makes a child
    // fall due on a day its parent doesn't, and the one that is invisible while
    // you're looking at the child alone.
    const parent = makeItem({
      id: 'item-parent', name: 'Monthly Deep Clean',
      recurrenceRule: { type: 'monthly' }, anchorDay: '2026-08-03',
    })
    const child = makeItem({
      id: 'item-child', name: 'Vacuum', parentId: 'item-parent',
      recurrenceRule: { type: 'monthly' }, anchorDay: '2026-08-17',
    })

    const occ = makeOcc({ id: 'occ-child', itemId: child.id, name: child.name })
    await page.route('/me', (r) => r.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } }))
    await page.route(/\/api\/occurrences\?start=.*&end=.*/, (r) => r.fulfill({ json: [occ] }))
    await page.route('/api/buckets',      (r) => r.fulfill({ json: BUCKETS }))
    await page.route('/api/categories',   (r) => r.fulfill({ json: CATEGORIES }))
    await page.route('/api/reasons',      (r) => r.fulfill({ json: [] }))
    await page.route('/api/preferences',  (r) => r.fulfill({ json: {} }))
    await page.route('/api/items',        (r) => r.fulfill({ json: [parent, child] }))
    await page.route(`/api/items/${child.id}`, (r) =>
      r.fulfill({ json: { ...child, children: [], prerequisites: [] } })
    )
    await routeScheduleSync(page, child)

    await page.goto('/')
    await page.getByTestId(`occ-row-${occ.id}`).getByTestId('occ-edit-btn').click()
    await expect(page.getByTestId('item-form-modal')).toBeVisible()
    await page.getByTestId('if-advanced-toggle').click()

    const caption = page.getByTestId('if-parent-schedule')
    await expect(caption).toBeVisible()
    // Names the parent and how it recurs...
    await expect(caption).toContainText('Monthly Deep Clean · monthly, from')
    // ...and the PARENT's start day (the 3rd), not the child's (the 17th) —
    // reading the child's own anchor back at you would answer nothing.
    await expect(caption).toContainText('3')
    await expect(caption).not.toContainText('17')
  })

  test('§4.1 a top-level item has no parent schedule to report', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-08-12T08:00:00'))
    const item = makeItem({ id: 'item-solo', name: 'Read', recurrenceRule: { type: 'daily' } })
    await openFullEditForItem(page, item)
    await page.getByTestId('if-advanced-toggle').click()

    await expect(page.getByTestId('if-parent')).toBeVisible()
    await expect(page.getByTestId('if-parent-schedule')).toHaveCount(0)
  })

})
