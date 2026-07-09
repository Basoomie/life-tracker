// §3.4 Procrastination — integration tests.
// Named after the spec's stated rules.  All tests hit a real database.
//
// Covers:
//   reschedule count in window
//   longest reschedule chain (following originalDay→newDay links)
//   backfill lateness (retroactive_completion lag days)
//   raw counts on every finding

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from '../helpers/test-db'
import * as repos from '../../db/repos/index'
import { ensureOccurrenceMaterialized } from '../../domain/materialization'
import { getItemProcrastination } from '../../stats/index'
import type { Item } from '@tracker/shared'
import type { DateWindow } from '@tracker/shared'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

const JAN_01 = '2025-01-01'
const JAN_02 = '2025-01-02'
const JAN_03 = '2025-01-03'
const JAN_04 = '2025-01-04'
const JAN_05 = '2025-01-05'
const JAN_06 = '2025-01-06'
const JAN_07 = '2025-01-07'

const WEEK: DateWindow = { startDay: JAN_01, endDay: JAN_07 }

async function makeUser(suffix: string) {
  return repos.insertUser(getTestPool(), { email: `procrast-${suffix}@test.com` })
}

async function makeTask(userId: string, name = 'Task') {
  return repos.insertItem(getTestPool(), {
    userId, name, recurrenceRule: null, creationSource: 'planned',
  })
}

async function makeDailyHabit(userId: string, name = 'Habit') {
  return repos.insertItem(getTestPool(), {
    userId, name, recurrenceRule: { type: 'daily' }, creationSource: 'planned',
  })
}

// Insert a rescheduled event for an item on originalDay, moving to newDay
async function reschedule(item: Item, originalDay: string, newDay: string, userId: string) {
  const occ = await ensureOccurrenceMaterialized(getTestPool(), item, originalDay, userId)
  await repos.insertEvent(getTestPool(), {
    userId, eventType: 'rescheduled',
    occurrenceId: occ.id, itemId: item.id, appliesToDay: originalDay,
    payload: { newDay, reasonId: null },
  })
}

// Insert a retroactive_completion with controlled recordedAt to simulate lag
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

// ── §3.4 Reschedule count ─────────────────────────────────────────────────────

describe('§3.4 rescheduleCount is total reschedule events for the item in the window', () => {
  it('§3.4 rescheduleCount = 0 when no reschedule events', async () => {
    const u = await makeUser('resched-zero')
    const h = await makeDailyHabit(u.id)

    const finding = await getItemProcrastination(getTestPool(), u.id, h.id, WEEK)
    expect(finding.rescheduleCount).toBe(0)
    expect(finding.rawCounts.rescheduleCount).toBe(0)
  })

  it('§3.4 rescheduleCount counts each reschedule event', async () => {
    const u = await makeUser('resched-count')
    const h = await makeDailyHabit(u.id)

    await reschedule(h, JAN_01, JAN_02, u.id)
    await reschedule(h, JAN_03, JAN_04, u.id)
    await reschedule(h, JAN_05, JAN_06, u.id)

    const finding = await getItemProcrastination(getTestPool(), u.id, h.id, WEEK)
    expect(finding.rescheduleCount).toBe(3)
    expect(finding.rawCounts.rescheduleCount).toBe(3)
  })

  it('§3.4 reschedule events outside the window are excluded', async () => {
    const u = await makeUser('resched-outside')
    const h = await makeDailyHabit(u.id)

    // In window
    await reschedule(h, JAN_02, JAN_03, u.id)
    // Outside window (before startDay)
    const before = await ensureOccurrenceMaterialized(getTestPool(), h, '2024-12-31', u.id)
    await repos.insertEvent(getTestPool(), {
      userId: u.id, eventType: 'rescheduled',
      occurrenceId: before.id, itemId: h.id, appliesToDay: '2024-12-31',
      payload: { newDay: JAN_01, reasonId: null },
    })

    const finding = await getItemProcrastination(getTestPool(), u.id, h.id, WEEK)
    expect(finding.rescheduleCount).toBe(1)
  })
})

// ── §3.4 Longest reschedule chain ─────────────────────────────────────────────

describe('§3.4 longestRescheduleChain follows originalDay→newDay links', () => {
  it('§3.4 single reschedule → chain = 1', async () => {
    const u = await makeUser('chain-1')
    const h = await makeDailyHabit(u.id)

    await reschedule(h, JAN_01, JAN_02, u.id)

    const finding = await getItemProcrastination(getTestPool(), u.id, h.id, WEEK)
    expect(finding.longestRescheduleChain).toBe(1)
  })

  it('§3.4 chain of A→B→C = 2 (two pushes)', async () => {
    const u = await makeUser('chain-2')
    const h = await makeDailyHabit(u.id)

    // Jan 1 → Jan 2, then Jan 2 → Jan 3 (chained push)
    await reschedule(h, JAN_01, JAN_02, u.id)
    // Now also reschedule the occurrence on Jan 2
    const h2 = h  // same item, occurrence on Jan 2
    await reschedule(h2, JAN_02, JAN_03, u.id)

    const finding = await getItemProcrastination(getTestPool(), u.id, h.id, WEEK)
    // Chain: Jan1→Jan2→Jan3 = length 2
    expect(finding.longestRescheduleChain).toBe(2)
  })

  it('§3.4 independent reschedules → chain = 1 (no link between them)', async () => {
    const u = await makeUser('chain-independent')
    const h = await makeDailyHabit(u.id)

    // Two independent: Jan1→Jan3, Jan4→Jan5 (no chain link)
    await reschedule(h, JAN_01, JAN_03, u.id)
    await reschedule(h, JAN_04, JAN_05, u.id)

    const finding = await getItemProcrastination(getTestPool(), u.id, h.id, WEEK)
    expect(finding.longestRescheduleChain).toBe(1)
  })
})

// ── §3.4 Backfill lateness ────────────────────────────────────────────────────

describe('§3.4 backfill stats measure retroactive completion lag', () => {
  it('§3.4 backfillStats.count = 0 when no retroactive completions', async () => {
    const u = await makeUser('backfill-zero')
    const h = await makeDailyHabit(u.id)

    const finding = await getItemProcrastination(getTestPool(), u.id, h.id, WEEK)
    expect(finding.backfillStats.count).toBe(0)
    expect(finding.backfillStats.medianLagDays).toBe(0)
    expect(finding.backfillStats.maxLagDays).toBe(0)
  })

  it('§3.4 backfillStats.medianLagDays = days between appliesToDay and recordedAt', async () => {
    const u = await makeUser('backfill-lag')
    const h = await makeDailyHabit(u.id)

    // Jan 1 completed at Jan 4 01:00 → lag = Math.round(3.04) = 3 days
    const jan4 = new Date('2025-01-04T01:00:00.000Z')
    await retroactiveComplete(h, JAN_01, u.id, jan4)

    // Jan 2 completed at Jan 3 01:00 → lag = Math.round(1.04) = 1 day
    const jan3 = new Date('2025-01-03T01:00:00.000Z')
    await retroactiveComplete(h, JAN_02, u.id, jan3)

    const finding = await getItemProcrastination(getTestPool(), u.id, h.id, WEEK)
    expect(finding.backfillStats.count).toBe(2)
    // lags = [1, 3], median = 2
    expect(finding.backfillStats.medianLagDays).toBe(2)
    expect(finding.backfillStats.maxLagDays).toBe(3)
    expect(finding.rawCounts.backfilledCompletions).toBe(2)
  })

  it('§3.4 retroactive_completion is excluded outside the window', async () => {
    const u = await makeUser('backfill-window')
    const h = await makeDailyHabit(u.id)

    // In window: Jan 3
    const jan4 = new Date('2025-01-04T00:00:00.000Z')
    await retroactiveComplete(h, JAN_03, u.id, jan4)

    // Outside window: Dec 31 → Jan 1 (applies_to_day 2024-12-31 outside WEEK)
    const dec31item = await ensureOccurrenceMaterialized(
      getTestPool(), h, '2024-12-31', u.id
    )
    await repos.insertEvent(getTestPool(), {
      userId: u.id, eventType: 'retroactive_completion',
      occurrenceId: dec31item.id, itemId: h.id, appliesToDay: '2024-12-31',
      recordedAt: new Date('2025-01-01T00:00:00.000Z'),
      payload: { completionPercent: 100, completionKind: 'retroactive' },
    })

    const finding = await getItemProcrastination(getTestPool(), u.id, h.id, WEEK)
    expect(finding.backfillStats.count).toBe(1)  // only the in-window one
  })
})

// ── §3.4 Raw counts on every finding ──────────────────────────────────────────

describe('§3.4 every procrastination finding includes rawCounts', () => {
  it('§3.4 rawCounts has rescheduleCount, backfilledCompletions, totalCompletions', async () => {
    const u = await makeUser('procrast-raw')
    const h = await makeDailyHabit(u.id)

    const finding = await getItemProcrastination(getTestPool(), u.id, h.id, WEEK)
    expect(finding.rawCounts).toMatchObject({
      rescheduleCount: expect.any(Number),
      backfilledCompletions: expect.any(Number),
      totalCompletions: expect.any(Number),
    })
  })
})
