// §4 Data Quality / Logging Health — integration tests.
// Named after the spec's stated rules.  All tests hit a real database.
//
// Layer 1.5: always shown; never gated.  Interpretive lens for Layer 2.
//
// Covers:
//   backfill lateness distribution
//   disposition coverage (explicit vs. auto-closed vs. missing)
//   parent-override frequency (declared vs. derived)
//   time-tracking coverage (user-wide)
//   gap days (due days with no materialized occurrence)
//   always shown without gating

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from '../helpers/test-db'
import * as repos from '../../db/repos/index'
import { ensureOccurrenceMaterialized } from '../../domain/materialization'
import { getItemDataQuality, getUserDataQuality } from '../../stats/index'
import type { Item } from '@tracker/shared'
import type { DateWindow } from '@tracker/shared'
import { randomUUID } from 'crypto'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

const MON = '2025-03-03'
const TUE = '2025-03-04'
const WED = '2025-03-05'
const THU = '2025-03-06'
const FRI = '2025-03-07'

const WEEK: DateWindow = { startDay: MON, endDay: FRI }

async function makeUser(suffix: string) {
  return repos.insertUser(getTestPool(), { email: `dq-${suffix}@test.com` })
}

async function makeDaily(userId: string, name = 'Daily', opts = {}) {
  return repos.insertItem(getTestPool(), {
    userId, name, recurrenceRule: { type: 'daily' }, creationSource: 'planned',
    ...opts,
  })
}

async function complete(item: Item, day: string, userId: string) {
  const occ = await ensureOccurrenceMaterialized(getTestPool(), item, day, userId)
  await repos.insertEvent(getTestPool(), {
    userId, eventType: 'item_completed',
    occurrenceId: occ.id, itemId: item.id, appliesToDay: day,
    payload: { completionPercent: 100, completionKind: 'declared' },
  })
}

async function skip(item: Item, day: string, userId: string) {
  const occ = await ensureOccurrenceMaterialized(getTestPool(), item, day, userId)
  await repos.insertEvent(getTestPool(), {
    userId, eventType: 'skipped',
    occurrenceId: occ.id, itemId: item.id, appliesToDay: day,
    payload: { reasonId: null, comment: null },
  })
}

async function retroactiveComplete(
  item: Item, day: string, userId: string, recordedAt: Date
) {
  const occ = await ensureOccurrenceMaterialized(getTestPool(), item, day, userId)
  await repos.insertEvent(getTestPool(), {
    userId, eventType: 'retroactive_completion',
    occurrenceId: occ.id, itemId: item.id, appliesToDay: day,
    recordedAt,
    payload: { completionPercent: 100, completionKind: 'retroactive' },
  })
}

// ── §4 Always shown without gating ───────────────────────────────────────────

describe('§4 data quality is always shown — never gated', () => {
  it('§4 data quality finding is returned even with no events in the window', async () => {
    const u = await makeUser('always-shown')
    const h = await makeDaily(u.id)

    const finding = await getItemDataQuality(getTestPool(), u.id, h.id, WEEK)
    expect(finding.type).toBe('data_quality')
    // No gating: finding is always returned
    expect(finding).toBeDefined()
  })

  it('§4 data quality finding always includes rawCounts with all required fields', async () => {
    const u = await makeUser('dq-always-raw')
    const h = await makeDaily(u.id)

    const finding = await getItemDataQuality(getTestPool(), u.id, h.id, WEEK)
    expect(finding.rawCounts).toMatchObject({
      dueCount: expect.any(Number),
      materializedCount: expect.any(Number),
      explicitDispositionCount: expect.any(Number),
      autoClosedCount: expect.any(Number),
      missingCount: expect.any(Number),
      backfilledCompletionCount: expect.any(Number),
    })
  })
})

// ── §4 Backfill lateness distribution ────────────────────────────────────────

describe('§4 backfill lateness distribution', () => {
  it('§4 backfillLateness is null when no retroactive completions', async () => {
    const u = await makeUser('bl-null')
    const h = await makeDaily(u.id)
    await complete(h, MON, u.id)

    const finding = await getItemDataQuality(getTestPool(), u.id, h.id, WEEK)
    expect(finding.backfillLateness).toBeNull()
  })

  it('§4 backfillLateness.medianLagDays is median of recorded-at vs applies-to gaps', async () => {
    const u = await makeUser('bl-median')
    const h = await makeDaily(u.id)

    // Mon completed 2 days late (recorded Wed)
    await retroactiveComplete(h, MON, u.id, new Date('2025-03-05T12:00:00.000Z'))
    // Tue completed 4 days late (recorded Sat)
    await retroactiveComplete(h, TUE, u.id, new Date('2025-03-08T12:00:00.000Z'))

    const finding = await getItemDataQuality(getTestPool(), u.id, h.id, WEEK)
    expect(finding.backfillLateness).not.toBeNull()
    expect(finding.backfillLateness!.count).toBe(2)
    // Median of [2, 4] = 3
    expect(finding.backfillLateness!.medianLagDays).toBe(3)
  })

  it('§4 backfillLateness.proportionOver1Day is fraction late by more than 1 day', async () => {
    const u = await makeUser('bl-over1')
    const h = await makeDaily(u.id)

    // Same-day completion (lag=0)
    await retroactiveComplete(h, MON, u.id, new Date('2025-03-03T12:00:00.000Z'))
    // 3 days late
    await retroactiveComplete(h, TUE, u.id, new Date('2025-03-07T12:00:00.000Z'))
    // 5 days late
    await retroactiveComplete(h, WED, u.id, new Date('2025-03-10T12:00:00.000Z'))

    const finding = await getItemDataQuality(getTestPool(), u.id, h.id, WEEK)
    expect(finding.backfillLateness).not.toBeNull()
    // 2 of 3 are > 1 day late
    expect(finding.backfillLateness!.proportionOver1Day).toBeCloseTo(2 / 3)
  })
})

// ── §4 Disposition coverage ────────────────────────────────────────────────────

describe('§4 disposition coverage — proportion of due items with explicit disposition', () => {
  it('§4 dispositionCoverage.rate = 1 when all due days have an explicit disposition', async () => {
    const u = await makeUser('disp-full')
    const h = await makeDaily(u.id)

    // Complete Mon-Fri
    for (const day of [MON, TUE, WED, THU, FRI]) {
      await complete(h, day, u.id)
    }

    const finding = await getItemDataQuality(getTestPool(), u.id, h.id, WEEK)
    expect(finding.dispositionCoverage.rate).toBe(1)
    expect(finding.dispositionCoverage.missingRate).toBe(0)
  })

  it('§4 missingRate is fraction of due days with no materialized occurrence', async () => {
    const u = await makeUser('disp-missing')
    const h = await makeDaily(u.id)

    // Only materialize Mon and Tue (rest are missing)
    await complete(h, MON, u.id)
    await skip(h, TUE, u.id)
    // Wed–Fri: no occurrence materialized → missing

    const finding = await getItemDataQuality(getTestPool(), u.id, h.id, WEEK)
    // 5 due days; 3 missing
    expect(finding.rawCounts.missingCount).toBe(3)
    expect(finding.dispositionCoverage.missingRate).toBeCloseTo(3 / 5)
  })

  it('§4 gapDays contains the YYYY-MM-DD strings for each missing day', async () => {
    const u = await makeUser('disp-gap-days')
    const h = await makeDaily(u.id)

    await complete(h, MON, u.id)
    await complete(h, WED, u.id)
    // Tue, Thu, Fri: missing

    const finding = await getItemDataQuality(getTestPool(), u.id, h.id, WEEK)
    expect(finding.gapDays).toHaveLength(3)
    expect(finding.gapDays).toContain(TUE)
    expect(finding.gapDays).toContain(THU)
    expect(finding.gapDays).toContain(FRI)
  })
})

// ── §4 Parent-override frequency ─────────────────────────────────────────────

describe('§4 parent-override frequency — declared vs. derived percent', () => {
  it('§4 declaredOverrideFrequency is null for leaf items', async () => {
    const u = await makeUser('override-leaf')
    const h = await makeDaily(u.id)
    await complete(h, MON, u.id)

    const finding = await getItemDataQuality(getTestPool(), u.id, h.id, WEEK)
    // Leaf items: override frequency is null (declared % is a parent concept)
    expect(finding.declaredOverrideFrequency).toBeNull()
  })

  it('§4 declaredOverrideFrequency = 0 when parent never uses declared percent', async () => {
    const u = await makeUser('override-zero')
    const parent = await makeDaily(u.id, 'Parent')
    const child  = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Child', parentId: parent.id,
      recurrenceRule: { type: 'daily' }, creationSource: 'planned',
    })
    // Materialize parent occurrences so they have explicit dispositions (not 'missing')
    for (const day of [MON, TUE, WED, THU, FRI]) {
      await ensureOccurrenceMaterialized(getTestPool(), parent, day, u.id)
    }
    await complete(child, MON, u.id)

    const finding = await getItemDataQuality(getTestPool(), u.id, parent.id, WEEK)
    // Parent item with materialized occurrences, no declared override events → 0
    expect(finding.declaredOverrideFrequency).toBe(0)
  })
})

// ── §4 Time-tracking coverage (user-wide) ─────────────────────────────────────

describe('§4 time-tracking coverage against planned durations (user-wide)', () => {
  it('§4 timeTrackingGap shows itemsWithPlannedDuration vs itemsWithSessions', async () => {
    const u = await makeUser('tt-coverage')

    // Item with planned duration + sessions
    const withPlan = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Workout',
      recurrenceRule: { type: 'daily' }, creationSource: 'planned',
      plannedDurationMin: 30,
    })
    const sessionId = randomUUID()
    await repos.insertEvent(getTestPool(), {
      userId: u.id, eventType: 'session_created',
      itemId: withPlan.id, appliesToDay: MON,
      payload: { sessionId, startedAt: `${MON}T09:00:00.000Z`, durationMin: 30 },
    })

    // Item with planned duration but NO sessions
    await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Stretching',
      recurrenceRule: { type: 'daily' }, creationSource: 'planned',
      plannedDurationMin: 10,
    })

    const finding = await getUserDataQuality(getTestPool(), u.id, WEEK)
    expect(finding.timeTrackingGap).not.toBeNull()
    // 2 items with planned duration; 1 has sessions
    expect(finding.timeTrackingGap!.itemsWithPlannedDuration).toBe(2)
    expect(finding.timeTrackingGap!.itemsWithSessions).toBe(1)
    expect(finding.timeTrackingGap!.coverageRate).toBeCloseTo(0.5)
  })

  it('§4 timeTrackingGap is null for per-item quality queries', async () => {
    const u = await makeUser('tt-item')
    const h = await makeDaily(u.id)

    const finding = await getItemDataQuality(getTestPool(), u.id, h.id, WEEK)
    expect(finding.timeTrackingGap).toBeNull()
  })
})

// ── §13.4 user_id scoping ─────────────────────────────────────────────────────

describe('§13.4 data quality is user_id scoped', () => {
  it('§13.4 data quality for user A cannot be retrieved with user B credentials', async () => {
    const ua = await makeUser('dq-scope-a')
    const ub = await makeUser('dq-scope-b')
    const habitA = await makeDaily(ua.id, 'Habit A')

    await expect(
      getItemDataQuality(getTestPool(), ub.id, habitA.id, WEEK)
    ).rejects.toThrow()
  })
})
