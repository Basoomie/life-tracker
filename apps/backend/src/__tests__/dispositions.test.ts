// §8 — Dispositions integration tests.
// Named after the spec's stated rules.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from './helpers/test-db'
import * as repos from '../db/repos/index'
import { runDispositions, applyDisposition, carryForward } from '../domain/dispositions'
import { addPrerequisite } from '../domain/prerequisites'
import { completeLeaf, completeChild } from '../domain/completion'
import { ensureOccurrenceMaterialized } from '../domain/materialization'
import type { Item, Occurrence } from '@tracker/shared'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DAY = '2025-01-15'   // Wednesday

async function makeUser(email: string) {
  return repos.insertUser(getTestPool(), { email })
}

async function makeHabit(
  userId: string,
  name: string,
  disposition: 'skip' | 'excuse' | 'auto_close' | 'require_manual' = 'skip'
) {
  return repos.insertItem(getTestPool(), {
    userId,
    name,
    recurrenceRule: { type: 'daily' },
    dispositionPolicy: disposition,
    creationSource: 'planned',
  })
}

async function makeTask(
  userId: string,
  name: string,
  disposition: 'skip' | 'excuse' | 'auto_close' | 'require_manual' = 'skip'
) {
  return repos.insertItem(getTestPool(), {
    userId,
    name,
    recurrenceRule: null,
    dispositionPolicy: disposition,
    creationSource: 'planned',
  })
}

async function materialize(item: Item, day: string, userId: string): Promise<Occurrence> {
  return ensureOccurrenceMaterialized(getTestPool(), item, day, userId)
}

// ── §8.1 Per-policy outcomes ──────────────────────────────────────────────────

describe('§8.1 skip policy: untouched occurrence at day-end fires a skip event', () => {
  it('§8.1 skip: runDispositions fires skipped event for untouched skip-policy occurrence', async () => {
    const u = await makeUser('disp-skip@test.com')
    const item = await makeHabit(u.id, 'Skip habit', 'skip')
    const occ = await materialize(item, DAY, u.id)

    await runDispositions(getTestPool(), u.id, DAY)

    const events = await repos.findEventsByOccurrence(getTestPool(), occ.id, u.id)
    const skipped = events.find((e) => e.eventType === 'skipped')
    expect(skipped).toBeDefined()
    expect(skipped!.appliesToDay).toBe(DAY)
  })

  it('§8.1 skip: already-touched occurrence is not re-processed', async () => {
    const u = await makeUser('disp-skip-touched@test.com')
    const item = await makeHabit(u.id, 'Skip touched', 'skip')
    const occ = await materialize(item, DAY, u.id)

    // Mark complete before runDispositions
    await completeLeaf(getTestPool(), occ, u.id)
    await runDispositions(getTestPool(), u.id, DAY)

    const events = await repos.findEventsByOccurrence(getTestPool(), occ.id, u.id)
    const skipped = events.find((e) => e.eventType === 'skipped')
    expect(skipped).toBeUndefined()   // already touched → no skip event added
  })
})

describe('§8.1 excuse policy: untouched occurrence at day-end fires an excuse event', () => {
  it('§8.1 excuse: runDispositions fires excused event for excuse-policy occurrence', async () => {
    const u = await makeUser('disp-excuse@test.com')
    const item = await makeHabit(u.id, 'Excuse habit', 'excuse')
    const occ = await materialize(item, DAY, u.id)

    await runDispositions(getTestPool(), u.id, DAY)

    const events = await repos.findEventsByOccurrence(getTestPool(), occ.id, u.id)
    const excused = events.find((e) => e.eventType === 'excused')
    expect(excused).toBeDefined()
    expect(excused!.appliesToDay).toBe(DAY)
  })
})

describe('§8.1 auto_close policy: fires auto_closed event at derived child % at day-end', () => {
  it('§8.1 auto_close: fires auto_closed event with derived child % when no children completed', async () => {
    const u = await makeUser('disp-auto-zero@test.com')
    const parent = await repos.insertItem(getTestPool(), {
      userId: u.id,
      name: 'Auto close parent zero',
      recurrenceRule: { type: 'daily' },
      dispositionPolicy: 'auto_close',
      creationSource: 'planned',
    })
    // Child due on DAY (Wednesday = day 3, i.e. index 3)
    const child = await repos.insertItem(getTestPool(), {
      userId: u.id,
      name: 'Auto close child',
      recurrenceRule: { type: 'days_of_week', days: [3] },  // Wednesdays
      dispositionPolicy: 'skip',
      parentId: parent.id,
      creationSource: 'planned',
    })

    const parentOcc = await materialize(parent, DAY, u.id)
    await materialize(child, DAY, u.id)

    // Neither parent nor child touched; run dispositions
    await runDispositions(getTestPool(), u.id, DAY)

    const events = await repos.findEventsByOccurrence(getTestPool(), parentOcc.id, u.id)
    const autoClosed = events.find((e) => e.eventType === 'auto_closed')
    expect(autoClosed).toBeDefined()
    expect((autoClosed!.payload as any).derivedPercent).toBe(0)  // child not completed
  })

  it('§8.1 auto_close: fires auto_closed at correct derived % when some children completed', async () => {
    // child_completed on the parent is a history notification, NOT an explicit close-out.
    // The parent is still "untouched" for disposition purposes and auto_close fires at derived %.
    const MONDAY = '2025-01-13'
    const u = await makeUser('disp-auto-partial@test.com')
    const parent = await repos.insertItem(getTestPool(), {
      userId: u.id,
      name: 'Auto close parent partial',
      recurrenceRule: { type: 'daily' },
      dispositionPolicy: 'auto_close',
      creationSource: 'planned',
    })
    const child1 = await repos.insertItem(getTestPool(), {
      userId: u.id,
      name: 'Auto child1',
      recurrenceRule: { type: 'days_of_week', days: [1] },  // Mondays
      dispositionPolicy: 'skip',
      parentId: parent.id,
      creationSource: 'planned',
    })
    const child2 = await repos.insertItem(getTestPool(), {
      userId: u.id,
      name: 'Auto child2',
      recurrenceRule: { type: 'days_of_week', days: [1] },  // Mondays
      dispositionPolicy: 'skip',
      parentId: parent.id,
      creationSource: 'planned',
    })

    const parentOcc = await materialize(parent, MONDAY, u.id)
    const c1Occ = await materialize(child1, MONDAY, u.id)
    await materialize(child2, MONDAY, u.id)

    // Complete child1 (fires child_completed on parent — NOT a disposition event)
    await completeChild(getTestPool(), c1Occ, parentOcc, u.id)

    await runDispositions(getTestPool(), u.id, MONDAY)

    // Parent: child_completed is NOT in DISPOSITION_EVENT_TYPES → parent is untouched
    // → auto_close fires at derived % = 50% (1 of 2 children done)
    const parentEvents = await repos.findEventsByOccurrence(getTestPool(), parentOcc.id, u.id)
    const autoClosed = parentEvents.find((e) => e.eventType === 'auto_closed')
    expect(autoClosed).toBeDefined()
    expect((autoClosed!.payload as any).derivedPercent).toBe(50)
  })
})

describe('§8.1 require_manual policy: no event fired — left for user', () => {
  it('§8.1 require_manual: no automatic event fired at day-end', async () => {
    const u = await makeUser('disp-require-manual@test.com')
    const item = await makeHabit(u.id, 'Require manual habit', 'require_manual')
    const occ = await materialize(item, DAY, u.id)

    await runDispositions(getTestPool(), u.id, DAY)

    const events = await repos.findEventsByOccurrence(getTestPool(), occ.id, u.id)
    // No disposition events should be present
    const dispEvents = events.filter((e) =>
      ['skipped', 'excused', 'auto_closed'].includes(e.eventType)
    )
    expect(dispEvents).toHaveLength(0)
  })
})

// ── §8.3 Reasons + comments ───────────────────────────────────────────────────

describe('§8.3 skip and excuse events carry optional reason + comment', () => {
  it('§8.3 applyDisposition skip carries reasonId and comment', async () => {
    const u = await makeUser('disp-skip-reason@test.com')
    const item = await makeHabit(u.id, 'Skip with reason', 'skip')
    const occ = await materialize(item, DAY, u.id)
    const reason = await repos.insertReason(getTestPool(), { userId: u.id, name: 'Sick' })

    const event = await applyDisposition(getTestPool(), occ, u.id, {
      reasonId: reason.id,
      comment: 'Flu',
    })

    expect(event).not.toBeNull()
    expect(event!.eventType).toBe('skipped')
    expect((event!.payload as any).reasonId).toBe(reason.id)
    expect((event!.payload as any).comment).toBe('Flu')
  })

  it('§8.3 applyDisposition excuse carries reasonId and comment', async () => {
    const u = await makeUser('disp-excuse-reason@test.com')
    const item = await makeHabit(u.id, 'Excuse with reason', 'excuse')
    const occ = await materialize(item, DAY, u.id)
    const reason = await repos.insertReason(getTestPool(), { userId: u.id, name: 'Traveling' })

    const event = await applyDisposition(getTestPool(), occ, u.id, {
      reasonId: reason.id,
      comment: 'Work trip',
    })

    expect(event).not.toBeNull()
    expect(event!.eventType).toBe('excused')
    expect((event!.payload as any).reasonId).toBe(reason.id)
    expect((event!.payload as any).comment).toBe('Work trip')
  })
})

// ── §8.2 Carry-forward ────────────────────────────────────────────────────────

describe('§8.2 carry-forward: explicit human action, not automatic rollover', () => {
  it('§8.2 carry-forward creates a new occurrence on the target day', async () => {
    const u = await makeUser('disp-carry-new-occ@test.com')
    const item = await makeHabit(u.id, 'Carry forward item')
    const occ = await materialize(item, DAY, u.id)

    const TARGET_DAY = '2025-01-16'
    const { newOccurrence } = await carryForward(getTestPool(), occ, TARGET_DAY, u.id)

    expect(newOccurrence.appliesToDay).toBe(TARGET_DAY)
    expect(newOccurrence.itemId).toBe(item.id)
    expect(newOccurrence.id).not.toBe(occ.id)  // new occurrence
  })

  it('§8.2 carry-forward records a rescheduled event on the original occurrence', async () => {
    const u = await makeUser('disp-carry-event@test.com')
    const item = await makeHabit(u.id, 'Carry event item')
    const occ = await materialize(item, DAY, u.id)

    const TARGET_DAY = '2025-01-17'
    const { rescheduleEvent } = await carryForward(getTestPool(), occ, TARGET_DAY, u.id)

    expect(rescheduleEvent.eventType).toBe('rescheduled')
    expect(rescheduleEvent.occurrenceId).toBe(occ.id)   // on the ORIGINAL occurrence
    expect((rescheduleEvent.payload as any).newDay).toBe(TARGET_DAY)
  })

  it('§8.2 carry-forward does not erase the original occurrence (history intact)', async () => {
    const u = await makeUser('disp-carry-not-erased@test.com')
    const item = await makeHabit(u.id, 'Carry not erased')
    const occ = await materialize(item, DAY, u.id)

    await carryForward(getTestPool(), occ, '2025-01-18', u.id)

    // Original occurrence must still exist
    const original = await repos.findOccurrenceById(getTestPool(), occ.id, u.id)
    expect(original).not.toBeNull()
    expect(original!.appliesToDay).toBe(DAY)
  })

  it('§8.2 history reads: scheduled → not done → rescheduled (original is NOT erased)', async () => {
    const u = await makeUser('disp-carry-history@test.com')
    const item = await makeHabit(u.id, 'History item')
    const occ = await materialize(item, DAY, u.id)

    const TARGET_DAY = '2025-01-19'
    const { newOccurrence, rescheduleEvent } = await carryForward(getTestPool(), occ, TARGET_DAY, u.id)

    // Original still exists with the rescheduled event
    const origStillExists = await repos.findOccurrenceById(getTestPool(), occ.id, u.id)
    expect(origStillExists).not.toBeNull()

    // rescheduled event points to the new occurrence
    expect((rescheduleEvent.payload as any).newOccurrenceId).toBe(newOccurrence.id)

    // New occurrence is on the target day
    const newExists = await repos.findOccurrenceById(getTestPool(), newOccurrence.id, u.id)
    expect(newExists).not.toBeNull()
    expect(newExists!.appliesToDay).toBe(TARGET_DAY)
  })

  it('§8.2 carry-forward event carries optional reason + comment', async () => {
    const u = await makeUser('disp-carry-reason@test.com')
    const item = await makeHabit(u.id, 'Carry reason item')
    const occ = await materialize(item, DAY, u.id)
    const reason = await repos.insertReason(getTestPool(), { userId: u.id, name: 'Rest day' })

    const { rescheduleEvent } = await carryForward(getTestPool(), occ, '2025-01-20', u.id, {
      reasonId: reason.id,
      comment: 'Too tired',
    })

    expect((rescheduleEvent.payload as any).reasonId).toBe(reason.id)
    expect((rescheduleEvent.payload as any).comment).toBe('Too tired')
  })
})

// ── §4.2 Blocked-past-due takes normal disposition ───────────────────────────

describe('§4.2 blocked-past-due takes normal disposition (not auto-excused)', () => {
  it('§4.2 blocked item with skip policy gets skipped at end of day, not auto-excused', async () => {
    const u = await makeUser('disp-blocked-skip@test.com')
    const prereq = await makeTask(u.id, 'Blocked prereq skip')
    const item   = await makeTask(u.id, 'Blocked item skip', 'skip')

    await addPrerequisite(getTestPool(), item, prereq, u.id)
    // prereq NOT completed → item is blocked

    const occ = await materialize(item, DAY, u.id)
    await runDispositions(getTestPool(), u.id, DAY)

    const events = await repos.findEventsByOccurrence(getTestPool(), occ.id, u.id)
    const skipped = events.find((e) => e.eventType === 'skipped')
    const excused = events.find((e) => e.eventType === 'excused')
    expect(skipped).toBeDefined()   // normal skip policy applied even though blocked
    expect(excused).toBeUndefined() // NOT auto-excused
  })
})

// ── §6.7 Day-start bucketing boundary ────────────────────────────────────────

describe('§6.7 end-of-day boundary uses day-start bucketing correctly', () => {
  it('§6.7 runDispositions processes occurrences for the specified logical day', async () => {
    const DAY_A = '2025-02-01'
    const DAY_B = '2025-02-02'
    const u = await makeUser('disp-daystart-boundary@test.com')
    const item = await makeHabit(u.id, 'Day start boundary item', 'skip')

    // Materialize on DAY_A only
    const occA = await materialize(item, DAY_A, u.id)

    // Run dispositions for DAY_B — should not touch DAY_A occurrence
    await runDispositions(getTestPool(), u.id, DAY_B)
    const eventsA = await repos.findEventsByOccurrence(getTestPool(), occA.id, u.id)
    expect(eventsA.filter((e) => e.eventType === 'skipped')).toHaveLength(0)

    // Run dispositions for DAY_A — should fire skip on DAY_A occurrence
    await runDispositions(getTestPool(), u.id, DAY_A)
    const eventsA2 = await repos.findEventsByOccurrence(getTestPool(), occA.id, u.id)
    expect(eventsA2.filter((e) => e.eventType === 'skipped')).toHaveLength(1)
  })
})
