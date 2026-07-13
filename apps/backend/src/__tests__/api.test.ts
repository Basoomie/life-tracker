// §3–§10 — API layer integration tests.
// Named after the spec rules they verify; the test list should read the design back.
//
// All tests use app.inject() to hit a real Fastify instance backed by the test DB.
// The test app's resolveUserId is injected so each test controls its own user identity.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from './helpers/test-db'
import * as repos from '../db/repos/index'
import { buildApp } from '../app'
import { ensureOccurrenceMaterialized } from '../domain/materialization'
import type { FastifyInstance } from 'fastify'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

// ── Test fixtures ──────────────────────────────────────────────────────────────

// Deterministic test dates (Wed 2025-01-15 / Tue 2025-01-14)
const TODAY   = '2025-01-15'  // Wednesday
const TUESDAY = '2025-01-14'  // Tuesday

async function makeUser(email: string) {
  return repos.insertUser(getTestPool(), { email })
}

// Build a Fastify app that always resolves to the given userId (no auth logic)
async function buildTestApp(userId: string): Promise<FastifyInstance> {
  return buildApp(async () => userId)
}

// ── §6.1 — child completion raises parent derived % ──────────────────────────

describe('§6.1 — completing a child via API raises the parent derived percent', () => {
  it('§6.1 child completion via POST /occurrences/:id/complete updates parent derived %', async () => {
    const u = await makeUser('api-child-complete@test.com')
    const app = await buildTestApp(u.id)

    // Create parent + child items
    const parent = await repos.insertItem(getTestPool(), {
      userId: u.id,
      name: 'API Parent',
      recurrenceRule: { type: 'daily' },
      creationSource: 'planned',
    })
    const child = await repos.insertItem(getTestPool(), {
      userId: u.id,
      name: 'API Child',
      recurrenceRule: { type: 'days_of_week', days: [1, 3, 5] }, // Mon/Wed/Fri
      parentId: parent.id,
      creationSource: 'planned',
    })

    // Materialize parent + child for TODAY (Wednesday — child IS due)
    const parentOcc = await ensureOccurrenceMaterialized(getTestPool(), parent, TODAY, u.id)
    const childOcc  = await ensureOccurrenceMaterialized(getTestPool(), child, TODAY, u.id)

    // Complete the child via the API
    const completeRes = await app.inject({
      method: 'POST',
      url: `/api/occurrences/${childOcc.id}/complete`,
    })
    expect(completeRes.statusCode).toBe(200)

    // Parent derived % should now be > 0 (child was the only due child)
    const parentRes = await app.inject({
      method: 'GET',
      url: `/api/occurrences/${parentOcc.id}`,
    })
    expect(parentRes.statusCode).toBe(200)
    const parentData = JSON.parse(parentRes.body)
    expect(parentData.completionState.derivedPercent).toBeGreaterThan(0)

    await app.close()
  })
})

// ── §6.1 — Tuesday not-due child → parent 100% vacuous ───────────────────────

describe('§6.1 — Tuesday-not-due child yields parent 100 derived percent via API', () => {
  it('§6.1 parent occurrence is 100% derived when no children are due that day', async () => {
    const u = await makeUser('api-tuesday-vacuous@test.com')
    const app = await buildTestApp(u.id)

    const parent = await repos.insertItem(getTestPool(), {
      userId: u.id,
      name: 'API Daily Parent',
      recurrenceRule: { type: 'daily' },
      creationSource: 'planned',
    })
    // MWF child — NOT due on Tuesday
    await repos.insertItem(getTestPool(), {
      userId: u.id,
      name: 'API MWF Child',
      recurrenceRule: { type: 'days_of_week', days: [1, 3, 5] },
      parentId: parent.id,
      creationSource: 'planned',
    })

    // Materialize parent for TUESDAY only (child not due → vacuous 100%)
    const parentOcc = await ensureOccurrenceMaterialized(getTestPool(), parent, TUESDAY, u.id)

    const res = await app.inject({
      method: 'GET',
      url: `/api/occurrences/${parentOcc.id}`,
    })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body)
    expect(data.completionState.derivedPercent).toBe(100)

    await app.close()
  })
})

// ── §6.2 — completing/uncompleting a PARENT's own occurrence uses declared %,
//          not a leaf item_completed event that the derivation ignores ────────

describe('§6.2 — POST /occurrences/:id/complete on a parent occurrence declares 100%', () => {
  it('§6.2 completing an occurrence that has children writes manual_parent_percent_declared, not item_completed', async () => {
    const u = await makeUser('api-parent-complete@test.com')
    const app = await buildTestApp(u.id)

    const parent = await repos.insertItem(getTestPool(), {
      userId: u.id,
      name: 'API Parent Checkbox',
      recurrenceRule: { type: 'daily' },
      creationSource: 'planned',
    })
    await repos.insertItem(getTestPool(), {
      userId: u.id,
      name: 'API Parent Checkbox Child',
      recurrenceRule: { type: 'daily' },
      parentId: parent.id,
      creationSource: 'planned',
    })
    const parentOcc = await ensureOccurrenceMaterialized(getTestPool(), parent, TODAY, u.id)

    const res = await app.inject({
      method: 'POST',
      url: `/api/occurrences/${parentOcc.id}/complete`,
    })
    expect(res.statusCode).toBe(200)

    const events = await repos.findEventsByOccurrence(getTestPool(), parentOcc.id, u.id)
    expect(events.some((e) => e.eventType === 'manual_parent_percent_declared')).toBe(true)
    expect(events.some((e) => e.eventType === 'item_completed')).toBe(false)

    const data = JSON.parse(res.body)
    expect(data.completionState.isComplete).toBe(true)

    await app.close()
  })
})

describe('§6.2 — POST /occurrences/:id/uncomplete overrides a vacuous derived 100%', () => {
  it('§6.2 uncompleting a parent occurrence with 0 due children flips isComplete to false without erasing derivedPercent', async () => {
    const u = await makeUser('api-parent-uncomplete@test.com')
    const app = await buildTestApp(u.id)

    const parent = await repos.insertItem(getTestPool(), {
      userId: u.id,
      name: 'API Vacuous Parent',
      recurrenceRule: { type: 'daily' },
      creationSource: 'planned',
    })
    // MWF child — NOT due on Tuesday, so derivedPercent is vacuously 100
    await repos.insertItem(getTestPool(), {
      userId: u.id,
      name: 'API Vacuous MWF Child',
      recurrenceRule: { type: 'days_of_week', days: [1, 3, 5] },
      parentId: parent.id,
      creationSource: 'planned',
    })
    const parentOcc = await ensureOccurrenceMaterialized(getTestPool(), parent, TUESDAY, u.id)

    // Confirm the vacuous-100 starting state, matching the real bug report
    const before = await app.inject({ method: 'GET', url: `/api/occurrences/${parentOcc.id}` })
    const beforeData = JSON.parse(before.body)
    expect(beforeData.completionState.derivedPercent).toBe(100)
    expect(beforeData.completionState.isComplete).toBe(true)

    const uncompleteRes = await app.inject({
      method: 'POST',
      url: `/api/occurrences/${parentOcc.id}/uncomplete`,
    })
    expect(uncompleteRes.statusCode).toBe(200)
    const afterData = JSON.parse(uncompleteRes.body)

    // The click must actually stick: isComplete flips, even though the
    // underlying derived % (computed fresh from children) is untouched.
    expect(afterData.completionState.isComplete).toBe(false)
    expect(afterData.completionState.derivedPercent).toBe(100)
    expect(afterData.completionState.declaredPercent).toBe(0)

    await app.close()
  })
})

// ── §13.4 — user A cannot read user B occurrences ────────────────────────────

describe('§13.4 — user A cannot read user B occurrences', () => {
  it('§13.4 GET /api/occurrences returns only the requesting user\'s data', async () => {
    const userA = await makeUser('api-scope-a@test.com')
    const userB = await makeUser('api-scope-b@test.com')

    const appA = await buildTestApp(userA.id)
    const appB = await buildTestApp(userB.id)

    // Create an item + occurrence for userA
    const itemA = await repos.insertItem(getTestPool(), {
      userId: userA.id,
      name: 'User A Task',
      recurrenceRule: null,
      creationSource: 'planned',
    })
    await ensureOccurrenceMaterialized(getTestPool(), itemA, TODAY, userA.id)

    // userB queries occurrences — should see nothing for userA's data
    const resB = await appB.inject({
      method: 'GET',
      url: `/api/occurrences?start=${TODAY}&end=${TODAY}`,
    })
    expect(resB.statusCode).toBe(200)
    const dataB = JSON.parse(resB.body) as { itemId: string }[]
    const userAItemIds = dataB.map((o) => o.itemId)
    expect(userAItemIds).not.toContain(itemA.id)

    await appA.close()
    await appB.close()
  })
})

// ── §10.1 — state changes append events; no in-place mutation ────────────────

describe('§10.1 — state changes append events; no in-place mutation', () => {
  it('§10.1 completing and uncompleting adds events without mutating the occurrence row', async () => {
    const u = await makeUser('api-immutable@test.com')
    const app = await buildTestApp(u.id)

    const item = await repos.insertItem(getTestPool(), {
      userId: u.id,
      name: 'Immutability Task',
      recurrenceRule: null,
      creationSource: 'planned',
    })
    const occ = await ensureOccurrenceMaterialized(getTestPool(), item, TODAY, u.id)

    // Snapshot the occurrence row before any API calls
    const before = await repos.findOccurrenceById(getTestPool(), occ.id, u.id)

    // Complete
    await app.inject({ method: 'POST', url: `/api/occurrences/${occ.id}/complete` })

    // The occurrence row itself must be unchanged
    const after = await repos.findOccurrenceById(getTestPool(), occ.id, u.id)
    expect(after).toEqual(before)  // same row — state is in events, not in the occurrence

    // Verify event was appended
    const events1 = await repos.findEventsByOccurrence(getTestPool(), occ.id, u.id)
    expect(events1.length).toBe(1)
    expect(events1[0].eventType).toBe('item_completed')

    // Uncomplete — should append a second event, not replace the first
    await app.inject({ method: 'POST', url: `/api/occurrences/${occ.id}/uncomplete` })

    const events2 = await repos.findEventsByOccurrence(getTestPool(), occ.id, u.id)
    expect(events2.length).toBe(2)  // two events, not one updated event
    expect(events2[1].eventType).toBe('item_completed')

    await app.close()
  })
})

// ── §4.2 — prerequisite cycle rejected at the API ────────────────────────────

describe('§4.2 — prerequisite cycle rejected at the API with a clear error', () => {
  it('§4.2 adding a back-edge that forms a cycle returns 400 with error code cycle_rejected', async () => {
    const u = await makeUser('api-cycle@test.com')
    const app = await buildTestApp(u.id)

    const itemA = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Cycle A', recurrenceRule: null, creationSource: 'planned',
    })
    const itemB = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Cycle B', recurrenceRule: null, creationSource: 'planned',
    })

    // A → B (A depends on B)
    const res1 = await app.inject({
      method: 'POST',
      url: `/api/items/${itemA.id}/prerequisites`,
      payload: { prerequisiteItemId: itemB.id },
    })
    expect(res1.statusCode).toBe(201)

    // B → A (would close the cycle)
    const res2 = await app.inject({
      method: 'POST',
      url: `/api/items/${itemB.id}/prerequisites`,
      payload: { prerequisiteItemId: itemA.id },
    })
    expect(res2.statusCode).toBe(400)
    const body = JSON.parse(res2.body)
    expect(body.error).toBe('cycle_rejected')

    await app.close()
  })
})

// ── §4.2 — habit-as-prerequisite rejected ────────────────────────────────────

describe('§4.2 — habit-as-prerequisite rejected at the API', () => {
  it('§4.2 using a recurring habit as a prerequisite returns 400 with error code habit_as_prerequisite', async () => {
    const u = await makeUser('api-habit-prereq@test.com')
    const app = await buildTestApp(u.id)

    const habit = await repos.insertItem(getTestPool(), {
      userId: u.id,
      name: 'A Habit',
      recurrenceRule: { type: 'daily' },
      creationSource: 'planned',
    })
    const task = await repos.insertItem(getTestPool(), {
      userId: u.id,
      name: 'A Task',
      recurrenceRule: null,
      creationSource: 'planned',
    })

    const res = await app.inject({
      method: 'POST',
      url: `/api/items/${task.id}/prerequisites`,
      payload: { prerequisiteItemId: habit.id },
    })
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body)
    expect(body.error).toBe('habit_as_prerequisite')

    await app.close()
  })
})

// ── §5.3 — template edit is forward-only ─────────────────────────────────────

describe('§5.3 — template edit via API is forward-only: past occurrences remain frozen', () => {
  it('§5.3 PATCH /items/:id does not alter past materialized occurrences', async () => {
    const u = await makeUser('api-forward-only@test.com')
    const app = await buildTestApp(u.id)

    const item = await repos.insertItem(getTestPool(), {
      userId: u.id,
      name: 'Original Name',
      recurrenceRule: { type: 'daily' },
      creationSource: 'planned',
    })

    // Materialize an occurrence for TUESDAY (in the "past" relative to TODAY)
    const pastOcc = await ensureOccurrenceMaterialized(getTestPool(), item, TUESDAY, u.id)
    const oldSnapshotName = pastOcc.snapshot.name
    expect(oldSnapshotName).toBe('Original Name')

    // Edit the template via API
    const editRes = await app.inject({
      method: 'PATCH',
      url: `/api/items/${item.id}`,
      payload: { name: 'New Name' },
    })
    expect(editRes.statusCode).toBe(200)
    expect(JSON.parse(editRes.body).name).toBe('New Name')

    // The past occurrence snapshot must be frozen
    const frozenOcc = await repos.findOccurrenceById(getTestPool(), pastOcc.id, u.id)
    expect(frozenOcc!.snapshot.name).toBe('Original Name')  // unchanged

    // The item template must reflect the new name
    const itemRes = await app.inject({ method: 'GET', url: `/api/items/${item.id}` })
    expect(JSON.parse(itemRes.body).name).toBe('New Name')

    await app.close()
  })
})

// ── §5.1 amendment — explicit recurrence start day ────────────────────────────

describe('§5.1 — POST /items accepts an explicit anchorDay for recurring items', () => {
  it('§5.1 a recurring item created with anchorDay stores it verbatim', async () => {
    const u = await makeUser('api-anchor-explicit@test.com')
    const app = await buildTestApp(u.id)

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/items',
      payload: {
        name: 'Biweekly review',
        recurrenceRule: { type: 'interval', unit: 'week', every: 2 },
        anchorDay: '2024-06-03',
        creationSource: 'planned',
      },
    })
    expect(createRes.statusCode).toBe(201)
    expect(JSON.parse(createRes.body).anchorDay).toBe('2024-06-03')

    await app.close()
  })

  it('§5.1 a recurring item created without anchorDay stores null (falls back to createdAt)', async () => {
    const u = await makeUser('api-anchor-omitted@test.com')
    const app = await buildTestApp(u.id)

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/items',
      payload: {
        name: 'Daily habit',
        recurrenceRule: { type: 'daily' },
        creationSource: 'planned',
      },
    })
    expect(createRes.statusCode).toBe(201)
    expect(JSON.parse(createRes.body).anchorDay).toBeNull()

    await app.close()
  })
})

// ── §5.4 — POST /items materializes a recurring item's near-term horizon immediately ──

describe('§5.4 — POST /items tops up a recurring item\'s horizon on creation, not just on edit', () => {
  it('§5.4 a daily item created via the API has a materialized (non-null id) occurrence for today', async () => {
    const u = await makeUser('api-create-topup-daily@test.com')
    const app = await buildTestApp(u.id)
    const today = new Date().toISOString().slice(0, 10)

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/items',
      payload: {
        name: 'Fresh daily habit',
        recurrenceRule: { type: 'daily' },
        creationSource: 'planned',
      },
    })
    expect(createRes.statusCode).toBe(201)

    // Without an edit or the nightly background job, today's occurrence must
    // already be a stored row (id !== null) — not left as computed-on-the-fly.
    const stored = await repos.findOccurrenceByItemAndDay(
      getTestPool(),
      JSON.parse(createRes.body).id,
      today,
      u.id
    )
    expect(stored).not.toBeNull()

    await app.close()
  })

  it('§5.4 a one-time task created via the API is unaffected (still materializes only its own day)', async () => {
    const u = await makeUser('api-create-topup-onetime@test.com')
    const app = await buildTestApp(u.id)
    const today = new Date().toISOString().slice(0, 10)

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/items',
      payload: {
        name: 'One-off task',
        recurrenceRule: null,
        creationSource: 'planned',
      },
    })
    expect(createRes.statusCode).toBe(201)

    const stored = await repos.findOccurrenceByItemAndDay(
      getTestPool(),
      JSON.parse(createRes.body).id,
      today,
      u.id
    )
    expect(stored).not.toBeNull()

    await app.close()
  })
})

// ── §8.2 — carry-forward leaves original intact ───────────────────────────────

describe('§8.2 — carry-forward via API leaves the original occurrence intact', () => {
  it('§8.2 POST /occurrences/:id/carry-forward creates new occurrence; original not deleted', async () => {
    const TARGET_DAY = '2025-01-20'
    const u = await makeUser('api-carry-forward@test.com')
    const app = await buildTestApp(u.id)

    const item = await repos.insertItem(getTestPool(), {
      userId: u.id,
      name: 'Carry Forward Task',
      recurrenceRule: null,
      creationSource: 'planned',
    })
    const occ = await ensureOccurrenceMaterialized(getTestPool(), item, TODAY, u.id)

    const res = await app.inject({
      method: 'POST',
      url: `/api/occurrences/${occ.id}/carry-forward`,
      payload: { targetDay: TARGET_DAY },
    })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body)
    expect(data.newOccurrence).toBeDefined()
    expect(data.rescheduleEvent).toBeDefined()

    // Original occurrence still exists
    const original = await repos.findOccurrenceById(getTestPool(), occ.id, u.id)
    expect(original).not.toBeNull()

    // Rescheduled event on the original
    const events = await repos.findEventsByOccurrence(getTestPool(), occ.id, u.id)
    expect(events.some((e) => e.eventType === 'rescheduled')).toBe(true)

    // New occurrence on TARGET_DAY
    const newOcc = await repos.findOccurrenceById(getTestPool(), data.newOccurrence.id, u.id)
    expect(newOcc).not.toBeNull()
    expect(newOcc!.appliesToDay).toBe(TARGET_DAY)

    await app.close()
  })
})

// ── §9.1 — live timer: start pause resume stop ────────────────────────────────

describe('§9.1 — live timer start pause resume stop produces correct session events and duration', () => {
  it('§9.1 four-step session produces 4 events in order and non-negative durationMin', async () => {
    const u = await makeUser('api-live-session@test.com')
    const app = await buildTestApp(u.id)

    const item = await repos.insertItem(getTestPool(), {
      userId: u.id,
      name: 'Timer Task',
      recurrenceRule: null,
      creationSource: 'planned',
    })
    const occ = await ensureOccurrenceMaterialized(getTestPool(), item, TODAY, u.id)

    // Start
    const startRes = await app.inject({
      method: 'POST',
      url: '/api/sessions/start',
      payload: { itemId: item.id, day: TODAY },
    })
    expect(startRes.statusCode).toBe(201)
    const { sessionId, occurrenceId } = JSON.parse(startRes.body)
    expect(sessionId).toBeTruthy()
    expect(occurrenceId).toBe(occ.id)

    // Pause
    const pauseRes = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/pause` })
    expect(pauseRes.statusCode).toBe(200)

    // Resume
    const resumeRes = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/resume` })
    expect(resumeRes.statusCode).toBe(200)

    // Stop
    const stopRes = await app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/stop` })
    expect(stopRes.statusCode).toBe(200)
    const stopData = JSON.parse(stopRes.body)
    expect(stopData.durationMin).toBeGreaterThanOrEqual(0)

    // Query events for the session — exactly 4 in order
    const sessionEvents = await repos.findEventsBySessionId(getTestPool(), sessionId, u.id)
    expect(sessionEvents).toHaveLength(4)
    expect(sessionEvents[0].eventType).toBe('session_started')
    expect(sessionEvents[1].eventType).toBe('session_paused')
    expect(sessionEvents[2].eventType).toBe('session_resumed')
    expect(sessionEvents[3].eventType).toBe('session_stopped')

    await app.close()
  })
})

// ── §9.1 — two overlapping live timers run independently ─────────────────────

describe('§9.1 — two overlapping live timers run independently', () => {
  it('§9.1 session1 and session2 can overlap; stopping each does not affect the other', async () => {
    const u = await makeUser('api-overlap-sessions@test.com')
    const app = await buildTestApp(u.id)

    const item1 = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Overlap Task 1', recurrenceRule: null, creationSource: 'planned',
    })
    const item2 = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Overlap Task 2', recurrenceRule: null, creationSource: 'planned',
    })
    await ensureOccurrenceMaterialized(getTestPool(), item1, TODAY, u.id)
    await ensureOccurrenceMaterialized(getTestPool(), item2, TODAY, u.id)

    const start1 = await app.inject({
      method: 'POST', url: '/api/sessions/start', payload: { itemId: item1.id, day: TODAY },
    })
    const start2 = await app.inject({
      method: 'POST', url: '/api/sessions/start', payload: { itemId: item2.id, day: TODAY },
    })
    const { sessionId: s1 } = JSON.parse(start1.body)
    const { sessionId: s2 } = JSON.parse(start2.body)
    expect(s1).not.toBe(s2)

    // Stop session1 while session2 is still running
    const stop1 = await app.inject({ method: 'POST', url: `/api/sessions/${s1}/stop` })
    expect(stop1.statusCode).toBe(200)

    // Stop session2 independently
    const stop2 = await app.inject({ method: 'POST', url: `/api/sessions/${s2}/stop` })
    expect(stop2.statusCode).toBe(200)

    // Each session has its own events
    const events1 = await repos.findEventsBySessionId(getTestPool(), s1, u.id)
    const events2 = await repos.findEventsBySessionId(getTestPool(), s2, u.id)
    expect(events1.length).toBe(2)   // started + stopped
    expect(events2.length).toBe(2)   // started + stopped
    expect(events1.every((e) => (e.payload as { sessionId: string }).sessionId === s1)).toBe(true)
    expect(events2.every((e) => (e.payload as { sessionId: string }).sessionId === s2)).toBe(true)

    await app.close()
  })
})

// ── §9.1 — occurrence loggedMinutes accumulates across independent sessions ──

describe('§9.1 — occurrence loggedMinutes accumulates across independent sessions (re-starting the timer is additive)', () => {
  it('§9.1 GET occurrence reflects the sum of two stopped sessions, not just the latest one', async () => {
    const u = await makeUser('api-logged-minutes@test.com')
    const app = await buildTestApp(u.id)

    const item = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Logged Minutes Task', recurrenceRule: null, creationSource: 'planned',
    })
    const occ = await ensureOccurrenceMaterialized(getTestPool(), item, TODAY, u.id)

    // First start/stop cycle
    const start1 = await app.inject({
      method: 'POST', url: '/api/sessions/start', payload: { itemId: item.id, day: TODAY },
    })
    const { sessionId: s1 } = JSON.parse(start1.body)
    const stop1 = await app.inject({ method: 'POST', url: `/api/sessions/${s1}/stop` })
    const { durationMin: d1 } = JSON.parse(stop1.body)

    const afterFirst = await app.inject({ method: 'GET', url: `/api/occurrences/${occ.id}` })
    expect(JSON.parse(afterFirst.body).loggedMinutes).toBe(d1)

    // Second, independent start/stop cycle on the same occurrence — must add
    // on top of the first, never replace it.
    const start2 = await app.inject({
      method: 'POST', url: '/api/sessions/start', payload: { itemId: item.id, day: TODAY },
    })
    const { sessionId: s2 } = JSON.parse(start2.body)
    expect(s2).not.toBe(s1)
    const stop2 = await app.inject({ method: 'POST', url: `/api/sessions/${s2}/stop` })
    const { durationMin: d2 } = JSON.parse(stop2.body)

    const afterSecond = await app.inject({ method: 'GET', url: `/api/occurrences/${occ.id}` })
    expect(JSON.parse(afterSecond.body).loggedMinutes).toBe(d1 + d2)

    await app.close()
  })

  it('§9.1 an in-progress (not-yet-stopped) session does not count toward loggedMinutes', async () => {
    const u = await makeUser('api-logged-minutes-inprogress@test.com')
    const app = await buildTestApp(u.id)

    const item = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'In Progress Task', recurrenceRule: null, creationSource: 'planned',
    })
    const occ = await ensureOccurrenceMaterialized(getTestPool(), item, TODAY, u.id)

    await app.inject({
      method: 'POST', url: '/api/sessions/start', payload: { itemId: item.id, day: TODAY },
    })

    const res = await app.inject({ method: 'GET', url: `/api/occurrences/${occ.id}` })
    expect(JSON.parse(res.body).loggedMinutes).toBe(0)

    await app.close()
  })
})

// ── §9.1 — manual session create and edit ────────────────────────────────────

describe('§9.1 — manual session create and edit work', () => {
  it('§9.1 POST /sessions/manual creates session_created event with correct duration', async () => {
    const u = await makeUser('api-manual-session@test.com')
    const app = await buildTestApp(u.id)

    const item = await repos.insertItem(getTestPool(), {
      userId: u.id, name: 'Manual Session Task', recurrenceRule: null, creationSource: 'planned',
    })
    await ensureOccurrenceMaterialized(getTestPool(), item, TODAY, u.id)

    const startedAt = '2025-01-15T10:00:00.000Z'
    const endedAt   = '2025-01-15T10:30:00.000Z'  // 30 minutes

    const createRes = await app.inject({
      method: 'POST',
      url: '/api/sessions/manual',
      payload: { itemId: item.id, day: TODAY, startedAt, endedAt },
    })
    expect(createRes.statusCode).toBe(201)
    const { sessionId } = JSON.parse(createRes.body)

    const createdEvents = await repos.findEventsBySessionId(getTestPool(), sessionId, u.id)
    expect(createdEvents).toHaveLength(1)
    expect(createdEvents[0].eventType).toBe('session_created')
    const createdPayload = createdEvents[0].payload as { durationMin: number }
    expect(createdPayload.durationMin).toBe(30)

    // Edit the session — new duration 45 minutes
    const newStart = '2025-01-15T10:00:00.000Z'
    const newEnd   = '2025-01-15T10:45:00.000Z'
    const editRes = await app.inject({
      method: 'PATCH',
      url: `/api/sessions/${sessionId}`,
      payload: { startedAt: newStart, endedAt: newEnd },
    })
    expect(editRes.statusCode).toBe(200)

    const allEvents = await repos.findEventsBySessionId(getTestPool(), sessionId, u.id)
    const editedEvent = allEvents.find((e) => e.eventType === 'session_edited')
    expect(editedEvent).toBeDefined()
    const editedPayload = editedEvent!.payload as { durationMin: number }
    expect(editedPayload.durationMin).toBe(45)

    await app.close()
  })
})

// ── §9.2 — ad-hoc one-tap ────────────────────────────────────────────────────

describe('§9.2 — ad-hoc one-tap creates item and running session together', () => {
  it('§9.2 POST /ad-hoc returns item, occurrence, sessionId; session_started event exists', async () => {
    const u = await makeUser('api-adhoc@test.com')
    const app = await buildTestApp(u.id)

    const res = await app.inject({
      method: 'POST',
      url: '/api/ad-hoc',
      payload: { name: 'Gaming' },
    })
    expect(res.statusCode).toBe(201)
    const data = JSON.parse(res.body)

    expect(data.item).toBeDefined()
    expect(data.item.creationSource).toBe('ad_hoc')
    expect(data.occurrence).toBeDefined()
    expect(data.sessionId).toBeTruthy()

    // session_started event must exist for the returned sessionId
    const sessionEvents = await repos.findEventsBySessionId(getTestPool(), data.sessionId, u.id)
    expect(sessionEvents.length).toBeGreaterThanOrEqual(1)
    expect(sessionEvents[0].eventType).toBe('session_started')

    // Occurrence exists for today
    const occ = await repos.findOccurrenceById(getTestPool(), data.occurrence.id, u.id)
    expect(occ).not.toBeNull()

    await app.close()
  })
})

// ── §6.6 — bucket boundary update that breaks tiling is rejected ──────────────

describe('§6.6 — bucket boundary update that breaks tiling is rejected at the API', () => {
  it('§6.6 PATCH /buckets/:id/boundaries returns 400 when tiling is violated', async () => {
    const u = await makeUser('api-bucket-tiling@test.com')
    const app = await buildTestApp(u.id)
    const today = new Date().toISOString().slice(0, 10)

    // Post day-start at 04:00 (use actual today to pass the >= today validation)
    const dsRes = await app.inject({
      method: 'POST',
      url: '/api/day-start',
      payload: { value: '04:00', effectiveFrom: today },
    })
    expect(dsRes.statusCode).toBe(201)

    // Create two buckets that tile the day (04:00–16:00 and 16:00–04:00)
    const dayBucketRes = await app.inject({
      method: 'POST',
      url: '/api/buckets',
      payload: { name: 'Day', startTime: '04:00', endTime: '16:00', sortOrder: 1 },
    })
    expect(dayBucketRes.statusCode).toBe(201)
    const dayBucket = JSON.parse(dayBucketRes.body)

    await app.inject({
      method: 'POST',
      url: '/api/buckets',
      payload: { name: 'Night', startTime: '16:00', endTime: '04:00', sortOrder: 2 },
    })

    // Attempt to change Day bucket to 04:00–17:00 — this overlaps Night (still 16:00–04:00)
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/buckets/${dayBucket.id}/boundaries`,
      payload: { startTime: '04:00', endTime: '17:00' },
    })
    expect(patchRes.statusCode).toBe(400)
    const body = JSON.parse(patchRes.body)
    expect(body.error).toBe('invalid_tiling')

    await app.close()
  })
})

// ── §6.7 — day-start appends to timeline; no re-bucketing of past ─────────────

describe('§6.7 — day-start write appends to timeline and does not re-bucket past', () => {
  it('§6.7 two POST /day-start calls produce a 2-entry timeline; past effectiveFrom rejected', async () => {
    const u = await makeUser('api-day-start@test.com')
    const app = await buildTestApp(u.id)

    const today  = new Date().toISOString().slice(0, 10)
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const past   = '2020-01-01'

    // First entry — effective today
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/day-start',
      payload: { value: '04:00', effectiveFrom: today },
    })
    expect(res1.statusCode).toBe(201)

    // Second entry — effective next week
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/day-start',
      payload: { value: '05:00', effectiveFrom: future },
    })
    expect(res2.statusCode).toBe(201)

    // Timeline must have 2 entries
    const getRes = await app.inject({ method: 'GET', url: '/api/day-start' })
    expect(getRes.statusCode).toBe(200)
    const timeline = JSON.parse(getRes.body)
    expect(timeline.length).toBeGreaterThanOrEqual(2)

    // Second entry has the new value at the future date
    const laterEntry = timeline.find((e: { startsOn: string }) => e.startsOn === future)
    expect(laterEntry).toBeDefined()
    expect(laterEntry.value).toBe('05:00')

    // Reject past effectiveFrom
    const pastRes = await app.inject({
      method: 'POST',
      url: '/api/day-start',
      payload: { value: '06:00', effectiveFrom: past },
    })
    expect(pastRes.statusCode).toBe(400)
    const pastBody = JSON.parse(pastRes.body)
    expect(pastBody.error).toBe('past_effective_date')

    await app.close()
  })
})

// ── §8.4 — background job runs dispositions ───────────────────────────────────

describe('§8.4 — background job runs dispositions for a day and produces expected events', () => {
  it('§8.4 POST /admin/background-job skips an untouched occurrence with policy=skip', async () => {
    const u = await makeUser('api-background-job@test.com')
    const app = await buildTestApp(u.id)

    const item = await repos.insertItem(getTestPool(), {
      userId: u.id,
      name: 'Skip Policy Task',
      recurrenceRule: null,
      creationSource: 'planned',
      dispositionPolicy: 'skip',
    })

    // Materialize occurrence for TUESDAY (in the past)
    const occ = await ensureOccurrenceMaterialized(getTestPool(), item, TUESDAY, u.id)

    // Run background job for TUESDAY
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/background-job',
      payload: { day: TUESDAY },
    })
    expect(res.statusCode).toBe(200)
    const data = JSON.parse(res.body)
    expect(data.ok).toBe(true)
    expect(data.day).toBe(TUESDAY)

    // The occurrence should now have a 'skipped' event
    const events = await repos.findEventsByOccurrence(getTestPool(), occ.id, u.id)
    expect(events.some((e) => e.eventType === 'skipped')).toBe(true)

    await app.close()
  })
})
