// §5.6 — Active / inactive items: integration tests.
//
// Tests are named after the spec's stated rules. All hit a real database.
//
// The distinction under test throughout: an inactive item stops being SCHEDULED while
// keeping everything it already IS — its fields, its slots, its parent, and every
// occurrence it has already accumulated. Deleting is a different decision with a
// different event, and the two must stay tellable apart in the log.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from './helpers/test-db'
import * as repos from '../db/repos/index'
import { createItem } from '../domain/items'
import { deactivateItemTree, reactivateItemTree, findInactiveAncestor } from '../domain/deactivation'
import {
  ensureOccurrenceForItemDay,
  topUpMaterialization,
  topUpMaterializationForItem,
  getOccurrencesInRange,
  getOverdueOccurrences,
} from '../domain/materialization'
import { completeLeaf } from '../domain/completion'
import { isBlocked, getIncompletePrerequisites, addPrerequisite } from '../domain/prerequisites'
import type { Item, TrackerEvent } from '@tracker/shared'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

// 2025-03-03 is a Monday.
const TODAY = '2025-03-03'
const YESTERDAY = '2025-03-02'
const TOMORROW = '2025-03-04'
const LATER = '2025-04-10'

let userSeq = 0
async function makeUser() {
  return repos.insertUser(getTestPool(), { email: `deact-${userSeq++}-${Date.now()}@test.com` })
}

// A plain daily habit, its near-term horizon materialized as the app would have it.
async function makeDailyItem(userId: string, name = 'Guitar practice', parentId?: string) {
  const pool = getTestPool()
  const item = await createItem(pool, {
    userId,
    name,
    parentId: parentId ?? null,
    recurrenceRule: { type: 'daily' },
    anchorDay: YESTERDAY,
    timingPrecision: 'point',
    timingStartTime: '08:30',
  })
  await topUpMaterializationForItem(pool, item, userId, TODAY)
  return item
}

// A one-time task with its single occurrence materialized on `day`.
async function makeOneTimeItem(userId: string, name: string, day: string) {
  const pool = getTestPool()
  const item = await createItem(pool, { userId, name, anchorDay: day })
  await ensureOccurrenceForItemDay(pool, item, day, userId)
  return item
}

const deactivate = (item: Item, userId: string, day = TODAY) =>
  deactivateItemTree(getTestPool(), item, userId, day)
const reactivate = (item: Item, userId: string, day = LATER) =>
  reactivateItemTree(getTestPool(), item, userId, day)

async function reload(item: Item, userId: string): Promise<Item> {
  const fresh = await repos.findItemById(getTestPool(), item.id, userId)
  if (!fresh) throw new Error(`item ${item.id} vanished`)
  return fresh
}

async function templateEvents(itemId: string, userId: string): Promise<TrackerEvent[]> {
  return repos.findTemplateEventsByItem(getTestPool(), itemId, userId)
}

function expectOk<T>(result: { ok: true; value: T } | { ok: false; code: string; error: string }): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.error}`)
  return result.value
}

// ── The pause itself ─────────────────────────────────────────────────────────

describe('§5.6 — an inactive item keeps everything it is and stops being scheduled', () => {
  it('deactivating keeps the item, its fields and its schedules intact', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const item = await makeDailyItem(user.id)
    const schedulesBefore = await repos.findSchedulesByItem(pool, item.id, user.id)

    expectOk(await deactivate(item, user.id))

    const after = await reload(item, user.id)
    expect(after.deactivatedAt).not.toBeNull()
    expect(after.name).toBe('Guitar practice')
    expect(after.archivedAt).toBeNull()   // §3.4 delete is a separate, untouched fact

    const schedulesAfter = await repos.findSchedulesByItem(pool, item.id, user.id)
    expect(schedulesAfter.map((s) => s.id)).toEqual(schedulesBefore.map((s) => s.id))
    expect(schedulesAfter[0].timingStartTime).toBe('08:30:00')
    expect(schedulesAfter[0].recurrenceRule).toEqual({ type: 'daily' })
  })

  it('an inactive item is not due from the deactivation day forward', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const item = await makeDailyItem(user.id)

    expectOk(await deactivate(item, user.id))

    const range = await getOccurrencesInRange(pool, user.id, TODAY, '2025-03-31')
    expect(range.filter((o) => o.itemId === item.id)).toEqual([])
  })

  it('the nightly top-up does not quietly undo the pause', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const item = await makeDailyItem(user.id)
    expectOk(await deactivate(item, user.id))

    // Phase (a) of the background job, run for a later day.
    await topUpMaterialization(pool, user.id, TOMORROW)

    const range = await getOccurrencesInRange(pool, user.id, TOMORROW, '2025-03-31')
    expect(range.filter((o) => o.itemId === item.id)).toEqual([])
  })

  it('deactivating twice is refused rather than appending a second pause', async () => {
    const user = await makeUser()
    const item = await makeDailyItem(user.id)
    expectOk(await deactivate(item, user.id))

    const second = await deactivate(await reload(item, user.id), user.id)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.code).toBe('no_change')

    const deactivations = (await templateEvents(item.id, user.id))
      .filter((e) => e.eventType === 'template_deactivated')
    expect(deactivations).toHaveLength(1)
  })
})

// ── Forward-only: history is never rewritten ─────────────────────────────────

describe('§5.6 — deactivation is forward-only and never rewrites history', () => {
  it('past occurrences stay materialized and countable', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const item = await makeDailyItem(user.id)

    const yesterdayOcc = await ensureOccurrenceForItemDay(pool, item, YESTERDAY, user.id)
    await completeLeaf(pool, yesterdayOcc, user.id)

    expectOk(await deactivate(item, user.id))

    const stored = await repos.findOccurrencesByItemsInRange(
      pool, [item.id], user.id, YESTERDAY, YESTERDAY
    )
    expect(stored).toHaveLength(1)
    expect(stored[0].id).toBe(yesterdayOcc.id)
  })

  it('a paused item keeps its past occurrences visible in range views', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const item = await makeDailyItem(user.id)
    const yesterdayOcc = await ensureOccurrenceForItemDay(pool, item, YESTERDAY, user.id)
    await completeLeaf(pool, yesterdayOcc, user.id)

    expectOk(await deactivate(item, user.id))

    const range = await getOccurrencesInRange(pool, user.id, YESTERDAY, YESTERDAY)
    expect(range.map((o) => o.id)).toContain(yesterdayOcc.id)
  })

  it('an occurrence already carrying an event is not cleared, even on the pause day itself', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const item = await makeDailyItem(user.id)

    // Completed this morning, paused this afternoon: the morning happened.
    const todayOcc = await ensureOccurrenceForItemDay(pool, item, TODAY, user.id)
    await completeLeaf(pool, todayOcc, user.id)

    expectOk(await deactivate(item, user.id))

    const stored = await repos.findOccurrencesByItemsInRange(pool, [item.id], user.id, TODAY, TODAY)
    expect(stored.map((o) => o.id)).toEqual([todayOcc.id])
  })

  it('untouched occurrences from the pause day forward are cleared', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const item = await makeDailyItem(user.id)

    const before = await repos.findOccurrencesByItemsInRange(pool, [item.id], user.id, TODAY, '2025-03-31')
    expect(before.length).toBeGreaterThan(0)

    const result = expectOk(await deactivate(item, user.id))
    expect(result.clearedFutureOccurrences).toBe(before.length)

    const after = await repos.findOccurrencesByItemsInRange(pool, [item.id], user.id, TODAY, '2025-03-31')
    expect(after).toEqual([])
  })

  it('a paused one-time task drops out of the overdue backlog', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const item = await makeOneTimeItem(user.id, 'File taxes', YESTERDAY)

    const beforeIds = (await getOverdueOccurrences(pool, user.id, TODAY)).map((o) => o.itemId)
    expect(beforeIds).toContain(item.id)

    expectOk(await deactivate(item, user.id))

    const afterIds = (await getOverdueOccurrences(pool, user.id, TODAY)).map((o) => o.itemId)
    expect(afterIds).not.toContain(item.id)
  })
})

// ── Reactivation ─────────────────────────────────────────────────────────────

describe('§5.6 — reactivation resumes scheduling and does not backfill the gap', () => {
  it('the item is due again from the reactivation day forward', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const item = await makeDailyItem(user.id)
    expectOk(await deactivate(item, user.id))

    expectOk(await reactivate(await reload(item, user.id), user.id, LATER))

    const range = await getOccurrencesInRange(pool, user.id, LATER, '2025-04-20')
    expect(range.filter((o) => o.itemId === item.id).length).toBeGreaterThan(0)
  })

  it('no occurrences are created for the paused days', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const item = await makeDailyItem(user.id)
    expectOk(await deactivate(item, user.id))
    expectOk(await reactivate(await reload(item, user.id), user.id, LATER))

    // The whole pause: the day after deactivation up to the day before reactivation.
    const gap = await getOccurrencesInRange(pool, user.id, TOMORROW, '2025-04-09')
    expect(gap.filter((o) => o.itemId === item.id)).toEqual([])
  })

  it('reactivating an active item is refused rather than logged as a change', async () => {
    const user = await makeUser()
    const item = await makeDailyItem(user.id)

    const result = await reactivate(item, user.id)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('no_change')

    const reactivations = (await templateEvents(item.id, user.id))
      .filter((e) => e.eventType === 'template_reactivated')
    expect(reactivations).toHaveLength(0)
  })
})

// ── The event timeline ───────────────────────────────────────────────────────

describe('§5.6 — the paused interval is recorded as events with an applies-to day', () => {
  it('deactivation logs template_deactivated on the day it takes effect', async () => {
    const user = await makeUser()
    const item = await makeDailyItem(user.id)
    expectOk(await deactivate(item, user.id, TODAY))

    const event = (await templateEvents(item.id, user.id))
      .find((e) => e.eventType === 'template_deactivated')
    expect(event).toBeDefined()
    expect(event!.appliesToDay).toBe(TODAY)
    if (event!.eventType === 'template_deactivated') {
      expect(event!.payload.cascadedFrom).toBeNull()
    }
  })

  it('reactivation logs template_reactivated on the day scheduling resumes', async () => {
    const user = await makeUser()
    const item = await makeDailyItem(user.id)
    expectOk(await deactivate(item, user.id, TODAY))
    expectOk(await reactivate(await reload(item, user.id), user.id, LATER))

    const event = (await templateEvents(item.id, user.id))
      .find((e) => e.eventType === 'template_reactivated')
    expect(event).toBeDefined()
    expect(event!.appliesToDay).toBe(LATER)
  })

  it('pausing and deleting stay tellable apart in the log', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const item = await makeDailyItem(user.id)

    expectOk(await deactivate(item, user.id))
    await repos.archiveItem(pool, item.id, user.id)
    await repos.insertEvent(pool, {
      userId: user.id,
      eventType: 'template_soft_deleted',
      itemId: item.id,
      occurrenceId: null,
      appliesToDay: null,
      payload: {},
    })

    const types = (await templateEvents(item.id, user.id)).map((e) => e.eventType)
    expect(types).toContain('template_deactivated')
    expect(types).toContain('template_soft_deleted')
  })
})

// ── Containment cascade ──────────────────────────────────────────────────────

describe('§5.6 / §4.1 — deactivating a parent cascades over its subtree', () => {
  // parent -> child -> grandchild, all daily.
  async function makeTree(userId: string) {
    const parent = await makeDailyItem(userId, 'Morning routine')
    const child = await makeDailyItem(userId, 'Stretch', parent.id)
    const grandchild = await makeDailyItem(userId, 'Hamstrings', child.id)
    return { parent, child, grandchild }
  }

  it('the whole subtree is deactivated, one logged event each', async () => {
    const user = await makeUser()
    const { parent, child, grandchild } = await makeTree(user.id)

    const result = expectOk(await deactivate(parent, user.id))
    expect(result.affected.map((i) => i.id)).toEqual([parent.id, child.id, grandchild.id])

    for (const item of [parent, child, grandchild]) {
      expect((await reload(item, user.id)).deactivatedAt).not.toBeNull()
      const events = (await templateEvents(item.id, user.id))
        .filter((e) => e.eventType === 'template_deactivated')
      expect(events).toHaveLength(1)
    }
  })

  it('each cascaded event records the ancestor that caused it', async () => {
    const user = await makeUser()
    const { parent, child, grandchild } = await makeTree(user.id)
    expectOk(await deactivate(parent, user.id))

    for (const item of [child, grandchild]) {
      const event = (await templateEvents(item.id, user.id))
        .find((e) => e.eventType === 'template_deactivated')
      if (event?.eventType === 'template_deactivated') {
        expect(event.payload.cascadedFrom).toBe(parent.id)
      } else {
        throw new Error('expected a template_deactivated event')
      }
    }
  })

  it('reactivating the parent brings back exactly what it cascaded over', async () => {
    const user = await makeUser()
    const { parent, child, grandchild } = await makeTree(user.id)
    expectOk(await deactivate(parent, user.id))

    const result = expectOk(await reactivate(await reload(parent, user.id), user.id))
    expect(result.affected.map((i) => i.id).sort())
      .toEqual([parent.id, child.id, grandchild.id].sort())

    for (const item of [parent, child, grandchild]) {
      expect((await reload(item, user.id)).deactivatedAt).toBeNull()
    }
  })

  it('a child the user had already paused stays paused when the parent returns', async () => {
    const user = await makeUser()
    const { parent, child, grandchild } = await makeTree(user.id)

    // The user pauses the child on its own FIRST, then pauses the parent.
    expectOk(await deactivate(child, user.id))
    expectOk(await deactivate(parent, user.id))

    expectOk(await reactivate(await reload(parent, user.id), user.id))

    expect((await reload(parent, user.id)).deactivatedAt).toBeNull()
    expect((await reload(child, user.id)).deactivatedAt).not.toBeNull()
    // The grandchild was swept in by the CHILD's own deactivation, not the parent's,
    // so it stays paused too — the subtree the user switched off is still off.
    expect((await reload(grandchild, user.id)).deactivatedAt).not.toBeNull()
  })

  it('a child can be paused on its own without touching its parent', async () => {
    const user = await makeUser()
    const { parent, child } = await makeTree(user.id)

    expectOk(await deactivate(child, user.id))

    expect((await reload(parent, user.id)).deactivatedAt).toBeNull()
    expect((await reload(child, user.id)).deactivatedAt).not.toBeNull()
  })
})

describe('§5.6 — no active item ever sits under an inactive ancestor', () => {
  it('reactivating a child under a still-paused parent is refused', async () => {
    const user = await makeUser()
    const parent = await makeDailyItem(user.id, 'Morning routine')
    const child = await makeDailyItem(user.id, 'Stretch', parent.id)
    expectOk(await deactivate(parent, user.id))

    const result = await reactivate(await reload(child, user.id), user.id)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe('ancestor_inactive')
      expect(result.error).toContain('Morning routine')
    }
    expect((await reload(child, user.id)).deactivatedAt).not.toBeNull()
  })

  it('findInactiveAncestor reports the nearest paused ancestor', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const parent = await makeDailyItem(user.id, 'Morning routine')
    const child = await makeDailyItem(user.id, 'Stretch', parent.id)
    const grandchild = await makeDailyItem(user.id, 'Hamstrings', child.id)

    expect(await findInactiveAncestor(pool, grandchild, user.id)).toBeNull()

    expectOk(await deactivate(parent, user.id))
    const found = await findInactiveAncestor(pool, await reload(grandchild, user.id), user.id)
    expect(found?.id).toBe(child.id)   // nearest, not outermost
  })
})

// ── Prerequisites ────────────────────────────────────────────────────────────

describe('§5.6 / §4.2 — an inactive prerequisite does not block', () => {
  async function makeBlockedPair(userId: string) {
    const pool = getTestPool()
    const blocker = await makeOneTimeItem(userId, 'Buy strings', TODAY)
    const dependent = await makeOneTimeItem(userId, 'Restring guitar', TODAY)
    const result = await addPrerequisite(pool, dependent, blocker, userId)
    if (!result.ok) throw new Error(result.error)
    return { blocker, dependent }
  }

  it('an incomplete active prerequisite blocks, as it always did', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const { dependent } = await makeBlockedPair(user.id)
    expect(await isBlocked(pool, dependent.id, user.id)).toBe(true)
  })

  it('pausing the prerequisite unblocks its dependent', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const { blocker, dependent } = await makeBlockedPair(user.id)

    expectOk(await deactivate(blocker, user.id))

    expect(await isBlocked(pool, dependent.id, user.id)).toBe(false)
    expect(await getIncompletePrerequisites(pool, dependent.id, user.id)).toEqual([])
  })

  it('reactivating a still-incomplete prerequisite blocks again — derived, not repaired', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const { blocker, dependent } = await makeBlockedPair(user.id)

    expectOk(await deactivate(blocker, user.id))
    expectOk(await reactivate(await reload(blocker, user.id), user.id))

    expect(await isBlocked(pool, dependent.id, user.id)).toBe(true)
    expect(await getIncompletePrerequisites(pool, dependent.id, user.id)).toEqual([blocker.id])
  })
})

// ── List queries ─────────────────────────────────────────────────────────────

describe('§5.6 — the inactive list is asked for by name, never mixed into the active one', () => {
  it('findActiveItemsByUser excludes paused items; findInactiveItemsByUser returns them', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const kept = await makeDailyItem(user.id, 'Kept')
    const paused = await makeDailyItem(user.id, 'Paused')
    expectOk(await deactivate(paused, user.id))

    const active = (await repos.findActiveItemsByUser(pool, user.id)).map((i) => i.id)
    expect(active).toContain(kept.id)
    expect(active).not.toContain(paused.id)

    const inactive = (await repos.findInactiveItemsByUser(pool, user.id)).map((i) => i.id)
    expect(inactive).toEqual([paused.id])
  })

  it('findItemsByUser still returns paused items, so history never loses them', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const paused = await makeDailyItem(user.id, 'Paused')
    expectOk(await deactivate(paused, user.id))

    const all = (await repos.findItemsByUser(pool, user.id)).map((i) => i.id)
    expect(all).toContain(paused.id)
  })

  it('a deleted item is not in the inactive list — the two states are separate', async () => {
    const pool = getTestPool()
    const user = await makeUser()
    const item = await makeDailyItem(user.id, 'Deleted')
    await repos.archiveItem(pool, item.id, user.id)

    const inactive = (await repos.findInactiveItemsByUser(pool, user.id)).map((i) => i.id)
    expect(inactive).not.toContain(item.id)
  })
})
