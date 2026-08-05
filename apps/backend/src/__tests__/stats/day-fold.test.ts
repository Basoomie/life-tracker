// v2 §9.1.1.a — the day-fold: a day is ONE observation whatever its slot count.
//
// This is the seam doing the job it exists for. A multi-slot item is collapsed on the
// domain side, before the observation array exists, so every calculator downstream
// still receives one scalar per day and cannot tell the difference. These tests assert
// the fold's rules directly on the arrays, plus the one downstream consequence that
// matters most (a streak day is a hit only when the whole day was done).

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from '../helpers/test-db'
import * as repos from '../../db/repos/index'
import { createItem } from '../../domain/items'
import { addSchedule } from '../../domain/schedules'
import { ensureOccurrenceMaterialized } from '../../domain/materialization'
import { completeLeaf } from '../../domain/completion'
import { excuseOccurrenceByUser, skipOccurrenceByUser } from '../../domain/dispositions'
import { buildLeafDayObservations } from '../../stats/domain/observations'
import { computeLeafAdherence } from '../../stats/calculators/adherence'
import { computeStreak } from '../../stats/calculators/streaks'
import type { DateWindow, Item, ItemSchedule, Occurrence } from '@tracker/shared'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

const MON = '2025-01-06'
const TUE = '2025-01-07'
const WINDOW: DateWindow = { startDay: MON, endDay: TUE }

let seq = 0
async function makeUser() {
  return repos.insertUser(getTestPool(), { email: `fold-${seq++}-${Date.now()}@test.com` })
}

/** A daily item with two daily slots — so every day in the window carries two. */
async function twoSlotDailyItem(userId: string) {
  const pool = getTestPool()
  const item = await createItem(pool, {
    userId, name: 'Twice daily', recurrenceRule: { type: 'daily' },
  })
  const [slotA] = await repos.findSchedulesByItem(pool, item.id, userId)
  const added = await addSchedule(pool, item, userId, { recurrenceRule: { type: 'daily' } }, MON)
  if (!added.ok) throw new Error(added.error)
  return { item, slotA, slotB: added.value }
}

function materialize(item: Item, schedule: ItemSchedule, day: string, userId: string) {
  return ensureOccurrenceMaterialized(getTestPool(), item, schedule, day, userId)
}

const complete = (occ: Occurrence, userId: string) => completeLeaf(getTestPool(), occ, userId)
const excuse   = (occ: Occurrence, userId: string) => excuseOccurrenceByUser(getTestPool(), occ, userId)
const skip     = (occ: Occurrence, userId: string) => skipOccurrenceByUser(getTestPool(), occ, userId)

// ── The fold's shape ─────────────────────────────────────────────────────────

describe('v2 §9.1.1.a a day is one observation whatever its slot count', () => {
  it('§9.1.1 a multi-slot day folds to exactly one DayObservation', async () => {
    const u = await makeUser()
    const { item, slotA, slotB } = await twoSlotDailyItem(u.id)
    await materialize(item, slotA, MON, u.id)
    await materialize(item, slotB, MON, u.id)

    const obs = await buildLeafDayObservations(getTestPool(), u.id, item, { startDay: MON, endDay: MON })
    expect(obs).toHaveLength(1)
    expect(obs[0].day).toBe(MON)
  })

  it('§9.1.1 the calculators receive the same input shape for one-slot and two-slot items', async () => {
    const pool = getTestPool()
    const u = await makeUser()
    const oneSlot = await createItem(pool, {
      userId: u.id, name: 'Once daily', recurrenceRule: { type: 'daily' },
    })
    const { item: twoSlot } = await twoSlotDailyItem(u.id)

    const a = await buildLeafDayObservations(pool, u.id, oneSlot, WINDOW)
    const b = await buildLeafDayObservations(pool, u.id, twoSlot, WINDOW)

    // Same length (one per due day) and the same key set — no slot dimension leaks out.
    expect(b.map((o) => o.day)).toEqual(a.map((o) => o.day))
    expect(Object.keys(b[0]).sort()).toEqual(Object.keys(a[0]).sort())
  })
})

// ── The fold's arithmetic ────────────────────────────────────────────────────

describe('§3.1 + §5.5 a day\'s value is the mean of its slots', () => {
  it('§3.1 + §5.5 one of two slots done reads 50% for the day, not two separate days', async () => {
    const u = await makeUser()
    const { item, slotA, slotB } = await twoSlotDailyItem(u.id)
    const occA = await materialize(item, slotA, MON, u.id)
    await materialize(item, slotB, MON, u.id)

    await complete(occA, u.id)

    const obs = await buildLeafDayObservations(getTestPool(), u.id, item, { startDay: MON, endDay: MON })
    expect(obs).toHaveLength(1)
    expect(obs[0].completionPercent).toBe(50)
  })

  it('§3.1 + §5.5 both slots done reads 100%; neither reads 0%', async () => {
    const u = await makeUser()
    const { item, slotA, slotB } = await twoSlotDailyItem(u.id)
    const occA = await materialize(item, slotA, MON, u.id)
    const occB = await materialize(item, slotB, MON, u.id)

    const none = await buildLeafDayObservations(getTestPool(), u.id, item, { startDay: MON, endDay: MON })
    expect(none[0].completionPercent).toBe(0)

    await complete(occA, u.id)
    await complete(occB, u.id)

    const all = await buildLeafDayObservations(getTestPool(), u.id, item, { startDay: MON, endDay: MON })
    expect(all[0].completionPercent).toBe(100)
  })

  it('§3.1 + §5.5 leaf adherence counts DAYS, so a two-slot item is not double-counted', async () => {
    const u = await makeUser()
    const { item, slotA, slotB } = await twoSlotDailyItem(u.id)
    for (const day of [MON, TUE]) {
      await materialize(item, slotA, day, u.id)
      await materialize(item, slotB, day, u.id)
    }

    const obs = await buildLeafDayObservations(getTestPool(), u.id, item, WINDOW)
    const finding = computeLeafAdherence(item.id, u.id, WINDOW, obs)

    // Two days in the window, four slots — the denominator is days.
    expect(finding.rawCounts.dueCount).toBe(2)
    // …and the raw slot counts say what those days actually contained (§5.5).
    expect(finding.rawCounts.slotsDue).toBe(4)
  })

  it('§5.5 raw slot counts distinguish "1 of 2 done" from "0 of 2", which the rate cannot', async () => {
    const u = await makeUser()
    const { item, slotA, slotB } = await twoSlotDailyItem(u.id)
    const occA = await materialize(item, slotA, MON, u.id)
    await materialize(item, slotB, MON, u.id)
    await complete(occA, u.id)

    const window = { startDay: MON, endDay: MON }
    const obs = await buildLeafDayObservations(getTestPool(), u.id, item, window)
    const finding = computeLeafAdherence(item.id, u.id, window, obs)

    // The day-level rate reads 0: a leaf day is a hit only when fully done (§3.1).
    expect(finding.rawAdherence).toBe(0)
    // The raw counts are what keep Layer 1 honest about the half that WAS done.
    expect(finding.rawCounts.slotsDue).toBe(2)
    expect(finding.rawCounts.slotsCompleted).toBe(1)
  })

  it('§5.5 a single-slot item reports slot counts identical to its day counts', async () => {
    const pool = getTestPool()
    const u = await makeUser()
    const item = await createItem(pool, {
      userId: u.id, name: 'Once daily', recurrenceRule: { type: 'daily' },
    })
    const [only] = await repos.findSchedulesByItem(pool, item.id, u.id)
    const occ = await materialize(item, only, MON, u.id)
    await complete(occ, u.id)

    const window = { startDay: MON, endDay: MON }
    const obs = await buildLeafDayObservations(pool, u.id, item, window)
    const finding = computeLeafAdherence(item.id, u.id, window, obs)

    expect(finding.rawCounts.slotsDue).toBe(finding.rawCounts.dueCount)
    expect(finding.rawCounts.slotsCompleted).toBe(finding.rawCounts.completedCount)
  })
})

// ── §8.1 Excused slots leave the denominator ─────────────────────────────────

describe('§8.1 + §5.5 an excused slot leaves the day\'s denominator', () => {
  it('§8.1 + §5.5 one slot excused, the other done → the day is 100%, not 50%', async () => {
    const u = await makeUser()
    const { item, slotA, slotB } = await twoSlotDailyItem(u.id)
    const occA = await materialize(item, slotA, MON, u.id)
    const occB = await materialize(item, slotB, MON, u.id)

    await excuse(occB, u.id)
    await complete(occA, u.id)

    const obs = await buildLeafDayObservations(getTestPool(), u.id, item, { startDay: MON, endDay: MON })
    expect(obs[0].completionPercent).toBe(100)
  })

  it('§8.1 + §5.5 one slot excused, the other missed → the day is 0%, and not excused', async () => {
    const u = await makeUser()
    const { item, slotA, slotB } = await twoSlotDailyItem(u.id)
    await materialize(item, slotA, MON, u.id)
    const occB = await materialize(item, slotB, MON, u.id)

    await excuse(occB, u.id)

    const obs = await buildLeafDayObservations(getTestPool(), u.id, item, { startDay: MON, endDay: MON })
    expect(obs[0].completionPercent).toBe(0)
    expect(obs[0].disposition).not.toBe('excused')
  })

  it('§8.1 + §5.5 EVERY slot excused → the day itself is excused and leaves the denominator', async () => {
    const u = await makeUser()
    const { item, slotA, slotB } = await twoSlotDailyItem(u.id)
    const occA = await materialize(item, slotA, MON, u.id)
    const occB = await materialize(item, slotB, MON, u.id)

    await excuse(occA, u.id)
    await excuse(occB, u.id)

    const obs = await buildLeafDayObservations(getTestPool(), u.id, item, { startDay: MON, endDay: MON })
    expect(obs[0].disposition).toBe('excused')
  })
})

// ── Disposition precedence ───────────────────────────────────────────────────

describe('§5.5 a day where any slot was engaged is not a missed day', () => {
  it("§5.5 one slot completed and one skipped reads as the more-engaged disposition", async () => {
    const u = await makeUser()
    const { item, slotA, slotB } = await twoSlotDailyItem(u.id)
    const occA = await materialize(item, slotA, MON, u.id)
    const occB = await materialize(item, slotB, MON, u.id)

    await complete(occA, u.id)
    await skip(occB, u.id)

    const obs = await buildLeafDayObservations(getTestPool(), u.id, item, { startDay: MON, endDay: MON })
    expect(obs[0].disposition).toBe('completed')
    expect(obs[0].completionPercent).toBe(50)
  })

  it("§5.5 a day with one untouched slot and one unmaterialized slot reads 'pending', not 'missing'", async () => {
    const u = await makeUser()
    const { item, slotB } = await twoSlotDailyItem(u.id)
    // addSchedule tops up slotB's horizon, so TUE has slotB stored-but-untouched and
    // slotA not yet materialized at all.
    await materialize(item, slotB, TUE, u.id)

    const obs = await buildLeafDayObservations(getTestPool(), u.id, item, { startDay: TUE, endDay: TUE })
    expect(obs).toHaveLength(1)
    expect(obs[0].disposition).toBe('pending')
  })

  it("§5.5 a day beyond every slot's horizon reads as one 'missing' observation", async () => {
    const u = await makeUser()
    const { item } = await twoSlotDailyItem(u.id)
    const FAR = '2025-03-01'   // well past the 7-day daily horizon: nothing materialized

    const obs = await buildLeafDayObservations(getTestPool(), u.id, item, { startDay: FAR, endDay: FAR })
    expect(obs).toHaveLength(1)
    expect(obs[0].disposition).toBe('missing')
  })
})

// ── The downstream consequence that matters ──────────────────────────────────

describe('§3.2 + §5.5 streaks read the folded day', () => {
  it('§3.2 + §5.5 a streak day is a hit only when every non-excused slot on it is complete', async () => {
    const u = await makeUser()
    const { item, slotA, slotB } = await twoSlotDailyItem(u.id)

    // Monday: both slots done. Tuesday: only one.
    const monA = await materialize(item, slotA, MON, u.id)
    const monB = await materialize(item, slotB, MON, u.id)
    const tueA = await materialize(item, slotA, TUE, u.id)
    await materialize(item, slotB, TUE, u.id)

    await complete(monA, u.id)
    await complete(monB, u.id)
    await complete(tueA, u.id)

    const obs = await buildLeafDayObservations(getTestPool(), u.id, item, WINDOW)
    const byDay = new Map(obs.map((o) => [o.day, o.completionPercent]))
    expect(byDay.get(MON)).toBe(100)
    expect(byDay.get(TUE)).toBe(50)

    // The streak walk runs on the folded days: Monday counts, Tuesday does not.
    const streak = computeStreak(item.id, u.id, WINDOW, obs, '2025-01-08', null)
    expect(streak.rawCounts.completedCount).toBe(1)
  })
})
