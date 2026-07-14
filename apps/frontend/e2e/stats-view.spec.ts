// v2 §9.5.1 — Stats views (Global triage + Per-item diagnostic) Playwright tests.
// Named after the spec rules they verify (§CLAUDE.md). API is mocked via
// page.route(); no live backend needed.

import { test, expect, type Page } from '@playwright/test'
import type {
  Item,
  DateWindow,
  LeafAdherenceFinding,
  ParentAdherenceFinding,
  ChildAdherenceFinding,
  StreakFinding,
  TimeStatsFinding,
  ProcrastinationFinding,
  DataQualityFinding,
  ContextStabilityFinding,
  AutocorrelationFinding,
  TrajectoryFinding,
  DayOfWeekFinding,
  TwoConditionFinding,
  AdHocShareFinding,
} from '@tracker/shared'

const WINDOW: DateWindow = { startDay: '2026-01-01', endDay: '2026-07-10' }

// ── Fixture factories ────────────────────────────────────────────────────────

function makeItem(o: Partial<Item> & { id: string; name: string }): Item {
  return {
    userId: 'u1', description: null, categoryId: null, valence: null, priority: null,
    recurrenceRule: { type: 'daily' }, quotaTarget: null, timingPrecision: 'none',
    timingBucketId: null, timingStartTime: null, timingEndTime: null, plannedDurationMin: null,
    parentId: null, dispositionPolicy: 'skip', creationSource: 'planned',
    archivedAt: null, createdAt: new Date(),
    ...o,
  }
}

function makeLeafAdherence(itemId: string, o: Partial<LeafAdherenceFinding> = {}): LeafAdherenceFinding {
  return {
    type: 'leaf_adherence', userId: 'u1', itemId, window: WINDOW,
    rawCounts: { dueCount: 20, completedCount: 16, excusedCount: 2, skippedCount: 2, autoCloseCount: 0, missingCount: 0 },
    rawAdherence: 0.8, adherenceExclExcused: 0.89, excuseRate: 0.5,
    ...o,
  }
}

function makeChildAdherence(itemId: string, o: Partial<ChildAdherenceFinding> = {}): ChildAdherenceFinding {
  return {
    type: 'child_adherence', userId: 'u1', itemId, window: WINDOW,
    rawCounts: { dueCount: 20, completedCount: 10, excusedCount: 0, skippedCount: 10, autoCloseCount: 0, missingCount: 0 },
    rawAdherence: 0.5, adherenceExclExcused: 0.5, excuseRate: 0,
    ...o,
  }
}

function makeParentAdherence(itemId: string, children: ChildAdherenceFinding[], o: Partial<ParentAdherenceFinding> = {}): ParentAdherenceFinding {
  return {
    type: 'parent_adherence', userId: 'u1', itemId, window: WINDOW,
    rawCounts: { dueCount: 20, excusedCount: 1, missingCount: 0, declaredOverrideCount: 0 },
    meanDerivedPercent: 0.84, meanDerivedExclExcused: 0.88, excuseRate: 0.2,
    children,
    ...o,
  }
}

function makeStreak(itemId: string, o: Partial<StreakFinding> = {}): StreakFinding {
  return {
    type: 'streak', userId: 'u1', itemId, window: WINDOW, streakType: 'daily',
    rawCounts: { dueCount: 20, completedCount: 16, excusedCount: 2 },
    currentStreak: 5, longestStreak: 12,
    ...o,
  }
}

function makeTimeStats(itemId: string, o: Partial<TimeStatsFinding> = {}): TimeStatsFinding {
  return {
    type: 'time_stats', userId: 'u1', itemId, window: WINDOW,
    rawCounts: { sessionCount: 10, liveSessions: 8, manualSessions: 2 },
    totalMin: 300, plannedDurationMin: 30, plannedVsActualDeltaMin: -30,
    sessionStartDistribution: [{ hour: 7, count: 6, totalMin: 180 }, { hour: 20, count: 4, totalMin: 120 }],
    ...o,
  }
}

function makeProcrastination(itemId: string, o: Partial<ProcrastinationFinding> = {}): ProcrastinationFinding {
  return {
    type: 'procrastination', userId: 'u1', itemId, window: WINDOW,
    rawCounts: { rescheduleCount: 2, backfilledCompletions: 3, totalCompletions: 16 },
    rescheduleCount: 2, longestRescheduleChain: 1,
    backfillStats: { count: 3, medianLagDays: 1, maxLagDays: 3 },
    ...o,
  }
}

function makeQuality(itemId: string | null, o: Partial<DataQualityFinding> = {}): DataQualityFinding {
  return {
    type: 'data_quality', userId: 'u1', itemId, window: WINDOW,
    rawCounts: { dueCount: 20, materializedCount: 20, explicitDispositionCount: 19, autoClosedCount: 1, missingCount: 0, backfilledCompletionCount: 3 },
    dispositionCoverage: { rate: 0.95, missingRate: 0 },
    backfillLateness: { count: 3, medianLagDays: 1, p75LagDays: 2, proportionOver1Day: 0.2, proportionOver3Days: 0 },
    declaredOverrideFrequency: null,
    timeTrackingGap: null,
    gapDays: [],
    ...o,
  }
}

function makeContextStability(itemId: string, o: Partial<ContextStabilityFinding> = {}): ContextStabilityFinding {
  return {
    type: 'context_stability', estimator: 'variance', userId: 'u1', itemId, window: WINDOW,
    circularMeanHour: 7.5, circularVariance: 0.3, effectSize: 0.3, power: 0.6, minimumDetectableEffect: 0.2,
    rawCounts: { nSessions: 30, nDays: 25 },
    dataQuality: makeQuality(itemId),
    sufficiency: { status: 'computable' },
    ...o,
  }
}

function makeAutocorrelation(itemId: string, o: Partial<AutocorrelationFinding> = {}): AutocorrelationFinding {
  return {
    type: 'autocorrelation', estimator: 'lag1_correlation', userId: 'u1', itemId, window: WINDOW,
    lag1: 0.35, standardError: 0.15, pValue: 0.02, effectSize: 0.35, power: 0.55, minimumDetectableEffect: 0.28,
    rawCounts: { nObservations: 20, nDueDays: 20 },
    dataQuality: makeQuality(itemId),
    sufficiency: { status: 'computable' },
    ...o,
  }
}

function makeTrajectory(itemId: string, o: Partial<TrajectoryFinding> = {}): TrajectoryFinding {
  return {
    type: 'trajectory', estimator: 'regression', userId: 'u1', itemId, window: WINDOW,
    slope: 0.02, intercept: 0.6, rSquared: 0.3, pValue: 0.03, effectSize: 0.4, power: 0.5, minimumDetectableEffect: 0.015,
    rawCounts: { nMonths: 6, nDueDaysTotal: 180 },
    dataQuality: makeQuality(itemId),
    sufficiency: { status: 'computable' },
    ...o,
  }
}

function makeDayOfWeek(itemId: string, o: Partial<DayOfWeekFinding> = {}): DayOfWeekFinding {
  return {
    type: 'day_of_week', estimator: 'permutation_k7', userId: 'u1', itemId, window: WINDOW,
    scopeStatus: 'applicable', estimatedRho: 0.2,
    pValue: 0.03, effectSize: 1.1, observedStatistic: 0.4,
    dayMeans: [
      { dayOfWeek: 0, label: 'Sun', mean: 0.6, n: 12 },
      { dayOfWeek: 1, label: 'Mon', mean: 0.9, n: 12 },
      { dayOfWeek: 2, label: 'Tue', mean: 0.85, n: 12 },
      { dayOfWeek: 3, label: 'Wed', mean: 0.5, n: 12 },
      { dayOfWeek: 4, label: 'Thu', mean: 0.7, n: 12 },
      { dayOfWeek: 5, label: 'Fri', mean: 0.4, n: 12 },
      { dayOfWeek: 6, label: 'Sat', mean: 0.3, n: 12 },
    ],
    power: 0.5,
    minimumDetectableEffect: 1.0,
    rawCounts: { nWeeks: 26, nDueDays: 182, nConditions: 7 },
    dataQuality: makeQuality(itemId),
    sufficiency: { status: 'computable' },
    ...o,
  }
}

function makeTwoCondition(itemId: string, o: Partial<TwoConditionFinding> = {}): TwoConditionFinding {
  return {
    type: 'two_condition', estimator: 'permutation_k2', userId: 'u1', itemId, window: WINDOW,
    conditionA: 'weekday', conditionB: 'weekend',
    estimatedRho: 0.3, pValue: 0.4, effectSize: 0.2, observedStatistic: 0.1, meanA: 0.75, meanB: 0.65,
    power: 0.1, minimumDetectableEffect: 1.3,
    rawCounts: { nPeriodsA: 20, nPeriodsB: 20, nDueDays: 140 },
    dataQuality: makeQuality(itemId),
    sufficiency: { status: 'computable' },
    ...o,
  }
}

function makeAdHocShare(o: Partial<AdHocShareFinding> = {}): AdHocShareFinding {
  return {
    type: 'adhoc_share', userId: 'u1', window: WINDOW,
    rawCounts: { totalSessions: 50, plannedSessions: 31, adHocSessions: 19 },
    totalTrackedMin: 1000, plannedMin: 620, adHocMin: 380, adHocShare: 0.38,
    adHocByValence: { productive: 114, unproductive: 266, neutral: 0, unclassified: 0 },
    ...o,
  }
}

type PerItemFixture = {
  adherence: LeafAdherenceFinding | ParentAdherenceFinding
  streaks: StreakFinding
  time: TimeStatsFinding
  procrastination: ProcrastinationFinding
  quality: DataQualityFinding
  contextStability: ContextStabilityFinding
  autocorrelation: AutocorrelationFinding
  trajectory: TrajectoryFinding
  dayOfWeek: DayOfWeekFinding
  weekdayVsWeekend: TwoConditionFinding
}

function fullItemFixture(itemId: string, o: Partial<PerItemFixture> = {}): PerItemFixture {
  return {
    adherence: o.adherence ?? makeLeafAdherence(itemId),
    streaks: o.streaks ?? makeStreak(itemId),
    time: o.time ?? makeTimeStats(itemId),
    procrastination: o.procrastination ?? makeProcrastination(itemId),
    quality: o.quality ?? makeQuality(itemId),
    contextStability: o.contextStability ?? makeContextStability(itemId),
    autocorrelation: o.autocorrelation ?? makeAutocorrelation(itemId),
    trajectory: o.trajectory ?? makeTrajectory(itemId),
    dayOfWeek: o.dayOfWeek ?? makeDayOfWeek(itemId),
    weekdayVsWeekend: o.weekdayVsWeekend ?? makeTwoCondition(itemId),
  }
}

const ENDPOINT_KEY: Record<string, keyof PerItemFixture> = {
  adherence: 'adherence',
  streaks: 'streaks',
  time: 'time',
  procrastination: 'procrastination',
  quality: 'quality',
  'context-stability': 'contextStability',
  autocorrelation: 'autocorrelation',
  trajectory: 'trajectory',
  'day-of-week': 'dayOfWeek',
  'weekday-vs-weekend': 'weekdayVsWeekend',
}

async function setupStatsMocks(
  page: Page,
  opts: { items: Item[]; perItem: Record<string, PerItemFixture>; crossItemTime?: AdHocShareFinding }
) {
  const { items, perItem, crossItemTime = makeAdHocShare() } = opts

  await page.route('/me', (route) =>
    route.fulfill({ json: { id: 'u1', email: 'test@tracker.local', createdAt: new Date().toISOString() } })
  )
  await page.route(/\/api\/occurrences\?start=.*&end=.*/, (route) => route.fulfill({ json: [] }))
  await page.route('/api/preferences', (route) => route.fulfill({ json: {} }))
  await page.route(/\/api\/preferences\/theme$/, (route) => route.fulfill({ json: { ok: true } }))
  await page.route('/api/categories', (route) => route.fulfill({ json: [] }))
  await page.route('/api/buckets', (route) => route.fulfill({ json: [] }))

  await page.route('/api/items', (route) => route.fulfill({ json: items }))

  await page.route(/\/api\/items\/([^/]+)$/, (route) => {
    const id = route.request().url().match(/\/api\/items\/([^/]+)$/)?.[1]
    const item = items.find((i) => i.id === id)
    if (!item) { route.fulfill({ status: 404, json: { error: 'not_found' } }); return }
    const children = items.filter((i) => i.parentId === id)
    route.fulfill({ json: { ...item, children, prerequisites: [] } })
  })

  await page.route(/\/api\/stats\/items\/([^/]+)\/([a-z-]+)(\?.*)?$/, (route) => {
    const m = route.request().url().match(/\/api\/stats\/items\/([^/]+)\/([a-z-]+)/)
    const itemId = m?.[1]
    const endpoint = m?.[2]
    const key = endpoint ? ENDPOINT_KEY[endpoint] : undefined
    const fixture = itemId ? perItem[itemId] : undefined
    if (!fixture || !key) { route.fulfill({ status: 404, json: { error: 'not_found' } }); return }
    route.fulfill({ json: fixture[key] })
  })

  await page.route(/\/api\/stats\/time(\?.*)?$/, (route) => route.fulfill({ json: crossItemTime }))
}

async function gotoStats(page: Page) {
  await page.goto('/')
  await page.getByTestId('view-nav-stats').click()
  await expect(page.getByTestId('stats-view')).toBeVisible()
}

test.describe('v2 §9.5.1 Stats views', () => {

  test('§9.5 power is visible on every reported finding (not hover-only), and a low-power finding is visually de-emphasized', async ({ page }) => {
    const item = makeItem({ id: 'daily-item', name: 'Meditation' })
    const fixture = fullItemFixture('daily-item', {
      dayOfWeek: makeDayOfWeek('daily-item', { power: 0.18 }),
      contextStability: makeContextStability('daily-item', { power: 0.72 }),
    })
    await setupStatsMocks(page, { items: [item], perItem: { 'daily-item': fixture } })
    await gotoStats(page)
    await page.getByTestId('global-stats-row-daily-item').click()
    await expect(page.getByTestId('item-stats-view')).toBeVisible()

    const dow = page.getByTestId('finding-day-of-week')
    await expect(dow).toHaveAttribute('data-power-tier', 'weak')
    await expect(dow).toHaveClass(/finding-card--weak/)
    await expect(dow.getByTestId('power-meter')).toContainText('18% power')
    await expect(dow.getByTestId('power-meter')).toContainText('weak signal')

    const ctx = page.getByTestId('finding-context-stability')
    await expect(ctx).toHaveAttribute('data-power-tier', 'strong')
    await expect(ctx).not.toHaveClass(/finding-card--weak/)
  })

  test('§4.1 a null result renders with its MDE and data-quality context — a bare null cannot render', async ({ page }) => {
    const item = makeItem({ id: 'daily-item', name: 'Meditation' })
    const fixture = fullItemFixture('daily-item', {
      autocorrelation: makeAutocorrelation('daily-item', { pValue: 0.4, minimumDetectableEffect: 0.42 }),
    })
    await setupStatsMocks(page, { items: [item], perItem: { 'daily-item': fixture } })
    await gotoStats(page)
    await page.getByTestId('global-stats-row-daily-item').click()

    const card = page.getByTestId('finding-autocorrelation')
    await expect(card.getByTestId('finding-autocorrelation-null')).toBeVisible()
    await expect(card.getByTestId('finding-autocorrelation-null')).toContainText('0.42')
    await expect(card.getByTestId('data-quality-strip')).toBeVisible()
  })

  test('§5.3.1/§9.5.1 three sufficiency states render distinctly; day-of-week on a non-daily habit is a permanent "not detectable" state, never "accumulating"', async ({ page }) => {
    const pageErrors: Error[] = []
    page.on('pageerror', (err) => pageErrors.push(err))

    const daily = makeItem({ id: 'daily-item', name: 'Meditation', recurrenceRule: { type: 'daily' } })
    const quota = makeItem({ id: 'quota-item', name: 'Workout', recurrenceRule: { type: 'days_of_week', days: [1, 3, 5, 6] } })

    const dailyFixture = fullItemFixture('daily-item', {
      contextStability: makeContextStability('daily-item', { sufficiency: { status: 'computable' } }),
      autocorrelation: makeAutocorrelation('daily-item', {
        // standardError: Infinity mirrors the real below-floor (n<2) calculator
        // output — route.fulfill's JSON encoding turns it into `null` on the
        // wire, same as a real fetch response would. Regression coverage for a
        // real crash: the card must never format this field when not 'reported'.
        standardError: Infinity,
        sufficiency: { status: 'below_floor', reason: 'need at least 7 weeks of daily data', nObserved: 5, nNeeded: 14 },
      }),
    })
    const quotaFixture = fullItemFixture('quota-item', {
      dayOfWeek: makeDayOfWeek('quota-item', {
        scopeStatus: 'not_detectable',
        pValue: null, effectSize: null, observedStatistic: null, dayMeans: null, minimumDetectableEffect: null,
        power: 0,
        sufficiency: { status: 'below_floor', reason: 'not applicable to this recurrence', nObserved: 0, nNeeded: 0 },
      }),
    })

    await setupStatsMocks(page, {
      items: [daily, quota],
      perItem: { 'daily-item': dailyFixture, 'quota-item': quotaFixture },
    })
    await gotoStats(page)

    await page.getByTestId('global-stats-row-daily-item').click()
    await expect(page.getByTestId('finding-context-stability').getByTestId('sufficiency-reported')).toBeVisible()

    const notYet = page.getByTestId('finding-autocorrelation').getByTestId('sufficiency-not-yet')
    await expect(notYet).toBeVisible()
    await expect(notYet).toContainText('Needs 9 more')
    await expect(notYet).toContainText('5 of 14')

    await page.getByTestId('stats-subnav-global').click()
    await page.getByTestId('global-stats-row-quota-item').click()
    const notApplicable = page.getByTestId('finding-day-of-week').getByTestId('sufficiency-not-applicable')
    await expect(notApplicable).toBeVisible()
    await expect(notApplicable).toContainText('Not detectable for this recurrence')
    await expect(page.getByTestId('finding-day-of-week').getByTestId('sufficiency-not-yet')).toHaveCount(0)

    expect(pageErrors).toEqual([])
  })

  test('§3.1 parent adherence ships with a per-child breakdown BY DEFAULT — no interaction required', async ({ page }) => {
    const parent = makeItem({ id: 'parent-item', name: 'Night Routine', recurrenceRule: { type: 'daily' } })
    const child = makeItem({ id: 'child-item', name: 'Meditate', parentId: 'parent-item', recurrenceRule: { type: 'daily' } })
    const childFinding = makeChildAdherence('child-item', { rawAdherence: 0.3, adherenceExclExcused: 0.3 })
    const fixture = fullItemFixture('parent-item', {
      adherence: makeParentAdherence('parent-item', [childFinding]),
    })
    await setupStatsMocks(page, { items: [parent, child], perItem: { 'parent-item': fixture } })
    await gotoStats(page)
    await page.getByTestId('global-stats-row-parent-item').click()

    await expect(page.getByTestId('adherence-children')).toBeVisible()
    await expect(page.getByTestId('adherence-child-child-item')).toBeVisible()
    await expect(page.getByTestId('adherence-child-child-item')).toContainText('Meditate')
    await expect(page.getByTestId('adherence-child-child-item')).toContainText('30%')
  })

  test('§3.1 raw-including-excused adherence is the headline; excuse rate is shown alongside it', async ({ page }) => {
    const item = makeItem({ id: 'daily-item', name: 'Workout' })
    const adherence = makeLeafAdherence('daily-item', {
      rawCounts: { dueCount: 13, completedCount: 7, excusedCount: 5, skippedCount: 1, autoCloseCount: 0, missingCount: 0 },
      rawAdherence: 7 / 13, adherenceExclExcused: 7 / 8, excuseRate: 5 / 6,
    })
    const fixture = fullItemFixture('daily-item', { adherence })
    await setupStatsMocks(page, { items: [item], perItem: { 'daily-item': fixture } })
    await gotoStats(page)
    await page.getByTestId('global-stats-row-daily-item').click()

    await expect(page.getByTestId('adherence-headline')).toHaveText('54%')
    await expect(page.getByTestId('adherence-secondary')).toContainText('88%')
    await expect(page.getByTestId('adherence-secondary')).toContainText('excused 5 of 6 misses')
  })

  test('§9.5.1/§10 the global view never fabricates a meaningless aggregate (e.g. average context stability across items)', async ({ page }) => {
    const a = makeItem({ id: 'item-a', name: 'Japanese' })
    const b = makeItem({ id: 'item-b', name: 'Workout' })
    await setupStatsMocks(page, {
      items: [a, b],
      perItem: { 'item-a': fullItemFixture('item-a'), 'item-b': fullItemFixture('item-b') },
    })
    await gotoStats(page)
    await expect(page.getByTestId('global-stats-table')).toBeVisible()

    const bodyText = await page.locator('body').innerText()
    expect(bodyText).not.toMatch(/average.{0,20}context stability/i)
    expect(bodyText).not.toMatch(/context stability.{0,20}across/i)

    // The legitimate cross-item fact IS present, for contrast.
    await expect(page.getByTestId('cross-item-adhoc-share')).toBeVisible()
    await expect(page.getByTestId('cross-item-adhoc-share')).toContainText('62%')
    await expect(page.getByTestId('cross-item-adhoc-share')).toContainText('70%')
  })

  test('§5.4/CLAUDE.md rule 6 — no rendered string ever references a broken streak or a single missed day', async ({ page }) => {
    const item = makeItem({ id: 'daily-item', name: 'Meditation' })
    const fixture = fullItemFixture('daily-item', {
      streaks: makeStreak('daily-item', { currentStreak: 0, longestStreak: 12 }),
    })
    await setupStatsMocks(page, { items: [item], perItem: { 'daily-item': fixture } })
    await gotoStats(page)
    await page.getByTestId('global-stats-row-daily-item').click()
    await expect(page.getByTestId('item-stats-view')).toBeVisible()

    const bodyText = await page.locator('body').innerText()
    const forbidden = [
      /broke.{0,20}streak/i,
      /broken.{0,20}streak/i,
      /don.?t break the chain/i,
      /you missed yesterday/i,
      /missed.{0,15}day/i,
    ]
    for (const pattern of forbidden) {
      expect(bodyText).not.toMatch(pattern)
    }
  })

  test('§9 Stats view state (window, sub-view, selected item) persists after navigating away and back', async ({ page }) => {
    const item = makeItem({ id: 'daily-item', name: 'Meditation' })
    await setupStatsMocks(page, { items: [item], perItem: { 'daily-item': fullItemFixture('daily-item') } })
    await gotoStats(page)

    await page.getByTestId('stats-window-select').selectOption('this-year')
    await expect(page.getByTestId('stats-window-select')).toHaveValue('this-year')

    await page.getByTestId('global-stats-row-daily-item').click()
    await expect(page.getByTestId('item-stats-view')).toBeVisible()

    // Navigate away to another tab, then back to Stats
    await page.getByTestId('view-nav-now').click()
    await page.getByTestId('view-nav-stats').click()

    // Window selection AND the per-item drill-down should both be restored —
    // not reset back to the Global default.
    await expect(page.getByTestId('stats-window-select')).toHaveValue('this-year')
    await expect(page.getByTestId('item-stats-view')).toBeVisible()
    await expect(page.getByTestId('stats-subnav-item')).toHaveClass(/stats-subnav__tab--active/)
  })

  test('light/dark and mobile-width usability', async ({ page }) => {
    const item = makeItem({ id: 'daily-item', name: 'Meditation' })
    await setupStatsMocks(page, { items: [item], perItem: { 'daily-item': fullItemFixture('daily-item') } })
    await page.setViewportSize({ width: 375, height: 812 })
    await gotoStats(page)
    await expect(page.getByTestId('stats-view')).toBeVisible()

    await page.getByTestId('theme-toggle').click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByTestId('stats-view')).toBeVisible()

    await page.getByTestId('global-stats-row-daily-item').click()
    await expect(page.getByTestId('item-stats-view')).toBeVisible()
  })
})
