// v2 §9.1.1.b / v1 §5.6 — Paused intervals leave the window.
//
// Tests are named after the spec's stated rules. All hit a real database.
//
// Why this file matters more than its size suggests: due days come from the RECURRENCE
// RULES, not from stored rows. Without the exclusion, a six-week pause arrives as six
// weeks of `missing` observations and reads as six weeks of failure — a confidently
// computed claim the record does not support, poisoning adherence, both streak
// measures, day-of-week, trajectory and autocorrelation at once, with Layer 3 then
// narrating the poison fluently. Every assertion here is guarding that.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from '../helpers/test-db'
import * as repos from '../../db/repos/index'
import { createItem } from '../../domain/items'
import { deactivateItemTree, reactivateItemTree } from '../../domain/deactivation'
import { ensureOccurrenceForItemDay } from '../../domain/materialization'
import { completeLeaf } from '../../domain/completion'
import { buildLeafDayObservations, buildParentDayObservations } from '../../stats/domain/observations'
import { getItemAdherence } from '../../stats/index'
import type { DateWindow, Item } from '@tracker/shared'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

// A ten-day window: Mon 6 Jan 2025 through Wed 15 Jan 2025.
const D = (n: number) => `2025-01-${String(n).padStart(2, '0')}`
const WINDOW: DateWindow = { startDay: D(6), endDay: D(15) }

let userSeq = 0
async function makeUser() {
  return repos.insertUser(getTestPool(), { email: `paused-${userSeq++}-${Date.now()}@test.com` })
}

async function makeDailyHabit(userId: string, name = 'Daily', parentId?: string): Promise<Item> {
  return createItem(getTestPool(), {
    userId, name, parentId: parentId ?? null,
    recurrenceRule: { type: 'daily' }, anchorDay: D(6),
  })
}

// Complete the habit on `day`, materializing its occurrence first.
async function completeOn(item: Item, userId: string, day: string) {
  const pool = getTestPool()
  const occ = await ensureOccurrenceForItemDay(pool, item, day, userId)
  await completeLeaf(pool, occ, userId)
}

async function reload(item: Item, userId: string): Promise<Item> {
  const fresh = await repos.findItemById(getTestPool(), item.id, userId)
  if (!fresh) throw new Error('item vanished')
  return fresh
}

async function pause(item: Item, userId: string, day: string) {
  const result = await deactivateItemTree(getTestPool(), item, userId, day)
  if (!result.ok) throw new Error(`deactivate failed: ${result.code}`)
}

async function resume(item: Item, userId: string, day: string) {
  const result = await reactivateItemTree(getTestPool(), await reload(item, userId), userId, day)
  if (!result.ok) throw new Error(`reactivate failed: ${result.code}`)
}

const observedDays = (obs: { day: string }[]) => obs.map((o) => o.day).sort()

// ── The exclusion itself ─────────────────────────────────────────────────────

describe('v2 §9.1.1.b — a rule-derived due day inside a paused interval is not an observation', () => {
  it('a habit due every day yields one observation per day when never paused', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const item = await makeDailyHabit(user.id)

    const obs = await buildLeafDayObservations(pool, user.id, item, WINDOW)
    expect(observedDays(obs)).toEqual([...Array(10)].map((_, i) => D(6 + i)))
  })

  it('the paused days are absent from the observation array entirely', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const item = await makeDailyHabit(user.id)

    await pause(item, user.id, D(9))      // paused 9th
    await resume(item, user.id, D(13))    // back on the 13th

    const obs = await buildLeafDayObservations(pool, user.id, item, WINDOW)
    // 6,7,8 active — 9,10,11,12 paused — 13,14,15 active again
    expect(observedDays(obs)).toEqual([D(6), D(7), D(8), D(13), D(14), D(15)])
  })

  it('a paused day is an absence, not a zero and not an excused day', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const item = await makeDailyHabit(user.id)

    await pause(item, user.id, D(9))
    await resume(item, user.id, D(13))

    const obs = await buildLeafDayObservations(pool, user.id, item, WINDOW)
    expect(obs.find((o) => o.day === D(10))).toBeUndefined()
    // Nothing was invented in its place: no zero-scored day, no excused day.
    expect(obs.some((o) => o.day === D(10) && o.completionPercent === 0)).toBe(false)
    expect(obs.some((o) => o.disposition === 'excused')).toBe(false)
  })

  it('an open-ended pause excludes every day from its start to the window end', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const item = await makeDailyHabit(user.id)

    await pause(item, user.id, D(9))

    const obs = await buildLeafDayObservations(pool, user.id, item, WINDOW)
    expect(observedDays(obs)).toEqual([D(6), D(7), D(8)])
  })

  it('a window entirely inside a pause yields no observations at all', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const item = await makeDailyHabit(user.id)

    await pause(item, user.id, D(1))

    const obs = await buildLeafDayObservations(pool, user.id, item, WINDOW)
    expect(obs).toEqual([])
  })
})

// ── The record still wins ────────────────────────────────────────────────────

describe('v2 §9.1.1.b — a paused day that the record actually holds still counts', () => {
  it('a day completed before pausing that afternoon keeps its observation', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const item = await makeDailyHabit(user.id)

    await completeOn(item, user.id, D(9))   // done in the morning
    await pause(item, user.id, D(9))        // paused that afternoon

    const obs = await buildLeafDayObservations(pool, user.id, item, WINDOW)
    const ninth = obs.find((o) => o.day === D(9))
    expect(ninth).toBeDefined()
    expect(ninth!.completionPercent).toBe(100)
    // The days after it are still excluded — only the recorded one survives.
    expect(observedDays(obs)).toEqual([D(6), D(7), D(8), D(9)])
  })

  it('pausing does not un-happen what happened before the pause', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const item = await makeDailyHabit(user.id)

    await completeOn(item, user.id, D(6))
    await completeOn(item, user.id, D(7))
    await pause(item, user.id, D(8))

    const obs = await buildLeafDayObservations(pool, user.id, item, WINDOW)
    expect(obs.filter((o) => o.completionPercent === 100).map((o) => o.day)).toEqual([D(6), D(7)])
  })
})

// ── What the calculators see ─────────────────────────────────────────────────

describe('v2 §9.1.1.b — adherence denominators shrink by exactly the paused days', () => {
  it('a perfect run followed by a pause reads 100%, not a collapse', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const item = await makeDailyHabit(user.id)

    for (const d of [D(6), D(7), D(8)]) await completeOn(item, user.id, d)
    await pause(item, user.id, D(9))

    const finding = await getItemAdherence(pool, user.id, item.id, WINDOW)
    if (finding.type === 'parent_adherence') throw new Error('expected a leaf finding')

    expect(finding.rawCounts.dueCount).toBe(3)          // NOT 10
    expect(finding.rawCounts.completedCount).toBe(3)
    expect(finding.rawCounts.missingCount).toBe(0)      // no invented gaps
    expect(finding.rawAdherence).toBe(1)                // 3/3, not 3/10
  })

  it('sufficiency counts real due days only, so a heavily-paused item does not clear a gate on days it was off', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const item = await makeDailyHabit(user.id)

    await completeOn(item, user.id, D(6))
    await pause(item, user.id, D(7))

    const finding = await getItemAdherence(pool, user.id, item.id, WINDOW)
    if (finding.type === 'parent_adherence') throw new Error('expected a leaf finding')

    // One real due day out of a ten-day window: n is 1, and nothing pads it.
    expect(finding.rawCounts.dueCount).toBe(1)
  })

  it('reactivating does not retroactively fill the gap with misses', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const item = await makeDailyHabit(user.id)

    await completeOn(item, user.id, D(6))
    await pause(item, user.id, D(7))
    await resume(item, user.id, D(14))
    await completeOn(item, user.id, D(14))

    const obs = await buildLeafDayObservations(pool, user.id, item, WINDOW)
    // The 7th–13th are gone. The 14th and 15th ARE due: the item is genuinely active
    // again from the 14th, and resuming materializes forward from there, as it should.
    expect(observedDays(obs)).toEqual([D(6), D(14), D(15)])

    const finding = await getItemAdherence(pool, user.id, item.id, WINDOW)
    if (finding.type === 'parent_adherence') throw new Error('expected a leaf finding')

    // The seven paused days contribute nothing: the denominator is 3, never 10.
    expect(finding.rawCounts.dueCount).toBe(3)
    expect(finding.rawCounts.completedCount).toBe(2)   // the 6th and the 14th
    // 2/3 — the outstanding day is the 15th, which is simply not done yet. None of
    // the seven paused days appears in either half of that fraction.
    expect(finding.rawAdherence).toBeCloseTo(2 / 3)
  })
})

// ── Parents and children ─────────────────────────────────────────────────────

describe('v2 §9.1.1.b — each item in a subtree is filtered by its own paused timeline', () => {
  it("a parent's own paused days leave its observation array", async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const parent = await makeDailyHabit(user.id, 'Morning routine')
    await makeDailyHabit(user.id, 'Stretch', parent.id)

    // Pausing the parent cascades over the child (§5.6), so the whole subtree is off.
    await pause(parent, user.id, D(9))

    const { parentObs } = await buildParentDayObservations(
      pool, user.id, await reload(parent, user.id), WINDOW
    )
    expect(observedDays(parentObs)).toEqual([D(6), D(7), D(8)])
  })

  it('a child paused on its own drops out of the parent denominator on those days (§6.1)', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const parent = await makeDailyHabit(user.id, 'Morning routine')
    const kept = await makeDailyHabit(user.id, 'Stretch', parent.id)
    const paused = await makeDailyHabit(user.id, 'Cold shower', parent.id)

    // The kept child is done every day; the other is paused from the 9th.
    for (let n = 6; n <= 15; n++) await completeOn(kept, user.id, D(n))
    await pause(paused, user.id, D(9))

    const { parentObs, childObs } = await buildParentDayObservations(
      pool, user.id, await reload(parent, user.id), WINDOW
    )

    // The paused child contributes observations only while it was active.
    expect(observedDays(childObs.get(paused.id) ?? [])).toEqual([D(6), D(7), D(8)])

    // On the 10th only the kept child is due, and it was done — so the parent is at
    // 100%, not 50%. A not-due child is excluded from the denominator, and a paused
    // child is not due.
    const tenth = parentObs.find((o) => o.day === D(10))
    expect(tenth).toBeDefined()
    expect(tenth!.completionPercent).toBe(100)
  })
})

// ── Scoping ──────────────────────────────────────────────────────────────────

describe('v2 §9.1.1.b — one item pause never affects another', () => {
  it("pausing one habit leaves another habit's observations untouched", async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const paused = await makeDailyHabit(user.id, 'Paused')
    const other = await makeDailyHabit(user.id, 'Other')

    await pause(paused, user.id, D(9))

    const obs = await buildLeafDayObservations(pool, user.id, other, WINDOW)
    expect(observedDays(obs)).toEqual([...Array(10)].map((_, i) => D(6 + i)))
  })
})
