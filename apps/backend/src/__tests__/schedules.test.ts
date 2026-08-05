// §5.5 — Multiple schedules per item: integration tests.
//
// Tests are named after the spec's stated rules. All hit a real database.
//
// The worked example throughout is the spec's own (§5.5): one task with
//   morning    08:30–09:30  Tue/Thu/Fri
//   lateMorn   10:30–11:30  Mon/Wed
//   afternoon  13:00–14:00  all weekdays
// so every weekday carries exactly two slots.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from './helpers/test-db'
import * as repos from '../db/repos/index'
import { createItem } from '../domain/items'
import { addSchedule, editSchedule, removeSchedule } from '../domain/schedules'
import {
  ensureOccurrenceMaterialized,
  topUpMaterializationForItem,
  getOccurrencesInRange,
} from '../domain/materialization'
import { getParentCompletionState, completeLeaf } from '../domain/completion'
import { excuseOccurrenceByUser } from '../domain/dispositions'
import type { Item, ItemSchedule, Occurrence } from '@tracker/shared'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

// 2025-01-06 is a Monday.
const MON = '2025-01-06'
const TUE = '2025-01-07'
const WED = '2025-01-08'
const TODAY = MON

let userSeq = 0
async function makeUser() {
  return repos.insertUser(getTestPool(), { email: `sched-${userSeq++}-${Date.now()}@test.com` })
}

// The spec's worked example. Returns the item plus its three slots in order.
async function makeThreeSlotItem(userId: string, name = 'Task A') {
  const pool = getTestPool()
  const item = await createItem(pool, {
    userId,
    name,
    recurrenceRule: { type: 'days_of_week', days: [2, 4, 5] },  // Tue/Thu/Fri
    timingPrecision: 'range',
    timingStartTime: '08:30',
    timingEndTime: '09:30',
  })
  const [morning] = await repos.findSchedulesByItem(pool, item.id, userId)

  const lateMorn = await expectOk(addSchedule(pool, item, userId, {
    label: 'Late morning',
    recurrenceRule: { type: 'days_of_week', days: [1, 3] },      // Mon/Wed
    timingPrecision: 'range',
    timingStartTime: '10:30',
    timingEndTime: '11:30',
  }, TODAY))

  const afternoon = await expectOk(addSchedule(pool, item, userId, {
    label: 'Afternoon',
    recurrenceRule: { type: 'days_of_week', days: [1, 2, 3, 4, 5] },  // weekdays
    timingPrecision: 'range',
    timingStartTime: '13:00',
    timingEndTime: '14:00',
  }, TODAY))

  return { item, morning, lateMorn, afternoon }
}

// Unwrap a ScheduleResult, failing the test with its message if it was rejected.
async function expectOk<T>(p: Promise<{ ok: true; value: T } | { ok: false; error: string }>): Promise<T> {
  const r = await p
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`)
  return r.value
}

async function materializeSlot(item: Item, schedule: ItemSchedule, day: string, userId: string) {
  return ensureOccurrenceMaterialized(getTestPool(), item, schedule, day, userId)
}

const complete = (occ: Occurrence, userId: string) => completeLeaf(getTestPool(), occ, userId)
const excuse = (occ: Occurrence, userId: string) => excuseOccurrenceByUser(getTestPool(), occ, userId)

// ── §5.5 Occurrence identity is (item, day, schedule) ────────────────────────

describe('§5.5 an item materializes one occurrence per due slot', () => {
  it('§5.5 the same item materializes two occurrences on one day when two schedules are due', async () => {
    const u = await makeUser()
    const { item } = await makeThreeSlotItem(u.id)

    await topUpMaterializationForItem(getTestPool(), item, u.id, TODAY)

    // Monday: late-morning + afternoon
    const monday = await repos.findOccurrencesByItemAndDay(getTestPool(), item.id, MON, u.id)
    expect(monday).toHaveLength(2)
    expect(new Set(monday.map((o) => o.scheduleId)).size).toBe(2)
  })

  it("§5.5 each slot's occurrence snapshots ITS OWN timing, not the item's first slot", async () => {
    const u = await makeUser()
    const { item } = await makeThreeSlotItem(u.id)

    await topUpMaterializationForItem(getTestPool(), item, u.id, TODAY)

    const monday = await repos.findOccurrencesByItemAndDay(getTestPool(), item.id, MON, u.id)
    const times = monday.map((o) => o.snapshot.timingStartTime).sort()
    expect(times).toEqual(['10:30:00', '13:00:00'])
  })

  it('§5.5 getOccurrencesInRange returns both of a day\'s slots, ordered by schedule sort order', async () => {
    const u = await makeUser()
    const { item, lateMorn, afternoon } = await makeThreeSlotItem(u.id)

    const occs = await getOccurrencesInRange(getTestPool(), u.id, MON, MON)
    const mine = occs.filter((o) => o.itemId === item.id)

    expect(mine).toHaveLength(2)
    // lateMorn was added first, so it sorts before afternoon.
    expect(mine.map((o) => o.scheduleId)).toEqual([lateMorn.id, afternoon.id])
  })

  it('§5.5 every weekday of the worked example carries exactly two slots; the weekend none', async () => {
    const u = await makeUser()
    const { item } = await makeThreeSlotItem(u.id)

    const occs = await getOccurrencesInRange(getTestPool(), u.id, MON, '2025-01-12')
    const perDay = new Map<string, number>()
    for (const o of occs.filter((x) => x.itemId === item.id)) {
      perDay.set(o.appliesToDay, (perDay.get(o.appliesToDay) ?? 0) + 1)
    }

    expect([...perDay.keys()].sort()).toEqual(
      [MON, TUE, WED, '2025-01-09', '2025-01-10']
    )
    expect([...new Set(perDay.values())]).toEqual([2])
  })
})

// ── §5.3 / §5.5 Forward-only, per-slot ───────────────────────────────────────

describe('§5.5 editing one schedule leaves the item\'s other slots alone', () => {
  it("§5.5 editing one schedule regenerates only that schedule's untouched future occurrences", async () => {
    const pool = getTestPool()
    const u = await makeUser()
    const { item, lateMorn, afternoon } = await makeThreeSlotItem(u.id)
    await topUpMaterializationForItem(pool, item, u.id, TODAY)

    const beforeAfternoon = (await repos.findOccurrencesByItemAndDay(pool, item.id, MON, u.id))
      .find((o) => o.scheduleId === afternoon.id)!

    await expectOk(editSchedule(pool, item, lateMorn.id, u.id, { timingStartTime: '09:45' }, TODAY))

    const after = await repos.findOccurrencesByItemAndDay(pool, item.id, MON, u.id)
    const newLate = after.find((o) => o.scheduleId === lateMorn.id)!
    const sameAfternoon = after.find((o) => o.scheduleId === afternoon.id)!

    expect(newLate.snapshot.timingStartTime).toBe('09:45:00')
    // The untouched slot's row is the very same row, not a regenerated one.
    expect(sameAfternoon.id).toBe(beforeAfternoon.id)
    expect(sameAfternoon.snapshot.timingStartTime).toBe('13:00:00')
  })

  it("§5.3 + §5.5 a past occurrence keeps its own schedule's frozen timing after that schedule is edited", async () => {
    const pool = getTestPool()
    const u = await makeUser()
    const { item, afternoon } = await makeThreeSlotItem(u.id)

    // A past occurrence of the afternoon slot (before TODAY, so frozen).
    const past = await materializeSlot(item, afternoon, '2024-12-30', u.id)

    await expectOk(editSchedule(pool, item, afternoon.id, u.id, { timingStartTime: '16:00' }, TODAY))

    const stillPast = await repos.findOccurrenceById(pool, past.id, u.id)
    expect(stillPast!.snapshot.timingStartTime).toBe('13:00:00')
  })
})

describe('§5.5 removing a schedule archives it and clears only its future', () => {
  it('§5.5 archiving a schedule removes its untouched future occurrences and leaves the others', async () => {
    const pool = getTestPool()
    const u = await makeUser()
    const { item, lateMorn, afternoon } = await makeThreeSlotItem(u.id)
    await topUpMaterializationForItem(pool, item, u.id, TODAY)

    await expectOk(removeSchedule(pool, item, lateMorn.id, u.id, TODAY))

    const monday = await repos.findOccurrencesByItemAndDay(pool, item.id, MON, u.id)
    expect(monday.map((o) => o.scheduleId)).toEqual([afternoon.id])
  })

  it('§5.5 a removed schedule stops producing future occurrences entirely', async () => {
    const pool = getTestPool()
    const u = await makeUser()
    const { item, lateMorn } = await makeThreeSlotItem(u.id)

    await expectOk(removeSchedule(pool, item, lateMorn.id, u.id, TODAY))

    const occs = await getOccurrencesInRange(pool, u.id, MON, '2025-01-31')
    expect(occs.some((o) => o.scheduleId === lateMorn.id)).toBe(false)
  })

  it('§5.5 a removed schedule\'s PAST occurrences stay visible — history keeps reading honestly', async () => {
    const pool = getTestPool()
    const u = await makeUser()
    const { item, lateMorn } = await makeThreeSlotItem(u.id)

    const past = await materializeSlot(item, lateMorn, '2024-12-30', u.id)
    await expectOk(removeSchedule(pool, item, lateMorn.id, u.id, TODAY))

    const occs = await getOccurrencesInRange(pool, u.id, '2024-12-30', '2024-12-30')
    expect(occs.map((o) => o.id)).toContain(past.id)
  })

  it('§5.5 removing a schedule archives it rather than deleting it (§3.4)', async () => {
    const pool = getTestPool()
    const u = await makeUser()
    const { item, lateMorn } = await makeThreeSlotItem(u.id)

    await expectOk(removeSchedule(pool, item, lateMorn.id, u.id, TODAY))

    const stillResolvable = await repos.findScheduleById(pool, lateMorn.id, u.id)
    expect(stillResolvable).not.toBeNull()
    expect(stillResolvable!.archivedAt).not.toBeNull()
  })

  it("§5.5 an item's last schedule cannot be removed — an item with no slot has no 'when'", async () => {
    const pool = getTestPool()
    const u = await makeUser()
    const item = await createItem(pool, {
      userId: u.id, name: 'Single slot', recurrenceRule: { type: 'daily' },
    })
    const [only] = await repos.findSchedulesByItem(pool, item.id, u.id)

    const result = await removeSchedule(pool, item, only.id, u.id, TODAY)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('last_schedule')
  })
})

// ── §5.5 The containment constraint ──────────────────────────────────────────

describe('§5.5 an item with children carries at most one schedule', () => {
  it('§5.5 an item with children rejects a second schedule', async () => {
    const pool = getTestPool()
    const u = await makeUser()
    const parent = await createItem(pool, {
      userId: u.id, name: 'Routine', recurrenceRule: { type: 'daily' },
    })
    await createItem(pool, {
      userId: u.id, name: 'Child', recurrenceRule: { type: 'daily' }, parentId: parent.id,
    })

    const result = await addSchedule(pool, parent, u.id, { recurrenceRule: { type: 'daily' } }, TODAY)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('parent_multi_schedule')
  })

  it('§5.5 a childless item accepts a second schedule', async () => {
    const pool = getTestPool()
    const u = await makeUser()
    const item = await createItem(pool, {
      userId: u.id, name: 'Leaf', recurrenceRule: { type: 'daily' },
    })

    const result = await addSchedule(pool, item, u.id, { recurrenceRule: { type: 'daily' } }, TODAY)
    expect(result.ok).toBe(true)
  })

  it('§5.5 a multi-slot item MAY still be a child', async () => {
    const pool = getTestPool()
    const u = await makeUser()
    const parent = await createItem(pool, {
      userId: u.id, name: 'Routine', recurrenceRule: { type: 'daily' },
    })
    const child = await createItem(pool, {
      userId: u.id, name: 'Child', recurrenceRule: { type: 'daily' }, parentId: parent.id,
    })

    const result = await addSchedule(pool, child, u.id, { recurrenceRule: { type: 'daily' } }, TODAY)
    expect(result.ok).toBe(true)
  })
})

// ── §6.1 + §5.5 A multi-slot child contributes the mean of its slots ─────────

describe('§6.1 + §5.5 a multi-slot child contributes the mean of its slots', () => {
  // Parent with one two-slot child: completing one of the child's two slots must read
  // as 50%, not as one complete child and one incomplete one.
  async function twoSlotChildTree(userId: string) {
    const pool = getTestPool()
    const parent = await createItem(pool, {
      userId, name: 'Routine', recurrenceRule: { type: 'daily' },
    })
    const child = await createItem(pool, {
      userId, name: 'Twice daily', recurrenceRule: { type: 'daily' }, parentId: parent.id,
    })
    const [slotA] = await repos.findSchedulesByItem(pool, child.id, userId)
    const slotB = await expectOk(addSchedule(pool, child, userId, {
      recurrenceRule: { type: 'daily' },
    }, TODAY))

    const parentSchedule = (await repos.findSchedulesByItem(pool, parent.id, userId))[0]
    const parentOcc = await materializeSlot(parent, parentSchedule, TODAY, userId)
    const occA = await materializeSlot(child, slotA, TODAY, userId)
    const occB = await materializeSlot(child, slotB, TODAY, userId)

    return { parent, parentOcc, child, occA, occB }
  }

  it('§6.1 + §5.5 completing one of a child\'s two slots gives the parent 50%, not 0 or 100', async () => {
    const u = await makeUser()
    const { parentOcc, occA } = await twoSlotChildTree(u.id)

    await complete(occA, u.id)

    const state = await getParentCompletionState(getTestPool(), parentOcc, u.id, TODAY)
    expect(state.derivedPercent).toBe(50)
  })

  it('§6.1 + §5.5 completing both of a child\'s slots gives the parent 100%', async () => {
    const u = await makeUser()
    const { parentOcc, occA, occB } = await twoSlotChildTree(u.id)

    await complete(occA, u.id)
    await complete(occB, u.id)

    const state = await getParentCompletionState(getTestPool(), parentOcc, u.id, TODAY)
    expect(state.derivedPercent).toBe(100)
  })

  it('§8.1 + §5.5 an excused slot leaves the denominator — the child\'s other slot alone decides', async () => {
    const u = await makeUser()
    const { parentOcc, occA, occB } = await twoSlotChildTree(u.id)

    await excuse(occB, u.id)
    await complete(occA, u.id)

    // Only slot A counts, and it is done → the child is 100%, so the parent is 100%.
    const state = await getParentCompletionState(getTestPool(), parentOcc, u.id, TODAY)
    expect(state.derivedPercent).toBe(100)
  })

  it('§8.1 + §5.5 a child whose every slot is excused leaves the parent\'s denominator entirely', async () => {
    const u = await makeUser()
    const { parentOcc, occA, occB } = await twoSlotChildTree(u.id)

    await excuse(occA, u.id)
    await excuse(occB, u.id)

    // No due children remain → vacuously 100% (§6.1), not 0%.
    const state = await getParentCompletionState(getTestPool(), parentOcc, u.id, TODAY)
    expect(state.derivedPercent).toBe(100)
  })

  it('§5.5 a two-slot child weighs the same as a one-slot sibling, not double', async () => {
    const pool = getTestPool()
    const u = await makeUser()
    const parent = await createItem(pool, {
      userId: u.id, name: 'Routine', recurrenceRule: { type: 'daily' },
    })
    const twice = await createItem(pool, {
      userId: u.id, name: 'Twice', recurrenceRule: { type: 'daily' }, parentId: parent.id,
    })
    const once = await createItem(pool, {
      userId: u.id, name: 'Once', recurrenceRule: { type: 'daily' }, parentId: parent.id,
    })
    const [twiceA] = await repos.findSchedulesByItem(pool, twice.id, u.id)
    const twiceB = await expectOk(addSchedule(pool, twice, u.id, { recurrenceRule: { type: 'daily' } }, TODAY))
    const [onceA] = await repos.findSchedulesByItem(pool, once.id, u.id)

    const parentSchedule = (await repos.findSchedulesByItem(pool, parent.id, u.id))[0]
    const parentOcc = await materializeSlot(parent, parentSchedule, TODAY, u.id)
    await materializeSlot(twice, twiceA, TODAY, u.id)
    await materializeSlot(twice, twiceB, TODAY, u.id)
    const onceOcc = await materializeSlot(once, onceA, TODAY, u.id)

    // Only the one-slot child is done. If the two-slot child counted once per slot the
    // parent would read 33%; as one child contributing its mean (0) it reads 50%.
    await complete(onceOcc, u.id)

    const state = await getParentCompletionState(pool, parentOcc, u.id, TODAY)
    expect(state.derivedPercent).toBe(50)
  })
})
