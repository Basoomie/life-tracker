// §5.5 — Schedule routes: the API surface and its invariants.
//
// The domain rules themselves are covered in schedules.test.ts; these assert that the
// HTTP layer exposes them correctly — in particular that the containment constraint
// is refused with a 409 from BOTH directions (adding a slot to a parent, and
// re-parenting under a multi-slot item), since either one alone would leave the
// invariant reachable.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from './helpers/test-db'
import { buildApp } from '../app'
import * as repos from '../db/repos/index'
import { createItem } from '../domain/items'
import type { FastifyInstance } from 'fastify'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

let seq = 0
async function makeUser() {
  return repos.insertUser(getTestPool(), { email: `sr-${seq++}-${Date.now()}@test.com` })
}

async function buildTestApp(userId: string): Promise<FastifyInstance> {
  return buildApp(async () => userId)
}

const DAILY = { type: 'daily' as const }

// ── The endpoints ────────────────────────────────────────────────────────────

describe('§5.5 POST /items/:id/schedules adds a slot', () => {
  it('§5.5 a second slot is created and returned with its own timing', async () => {
    const u = await makeUser()
    const app = await buildTestApp(u.id)
    const item = await createItem(getTestPool(), {
      userId: u.id, name: 'Task A', recurrenceRule: DAILY,
    })

    const res = await app.inject({
      method: 'POST',
      url: `/api/items/${item.id}/schedules`,
      payload: {
        label: 'Afternoon',
        recurrenceRule: { type: 'days_of_week', days: [1, 2, 3, 4, 5] },
        timingPrecision: 'range',
        timingStartTime: '13:00',
        timingEndTime: '14:00',
      },
    })

    expect(res.statusCode).toBe(201)
    const body = JSON.parse(res.body)
    expect(body.label).toBe('Afternoon')
    expect(body.timingStartTime).toBe('13:00:00')
    expect(body.sortOrder).toBe(1)

    await app.close()
  })

  it('§5.5 GET /items/:id returns every slot the item carries', async () => {
    const u = await makeUser()
    const app = await buildTestApp(u.id)
    const item = await createItem(getTestPool(), {
      userId: u.id, name: 'Task A', recurrenceRule: DAILY,
    })

    await app.inject({
      method: 'POST', url: `/api/items/${item.id}/schedules`,
      payload: { recurrenceRule: DAILY },
    })

    const res = await app.inject({ method: 'GET', url: `/api/items/${item.id}` })
    expect(JSON.parse(res.body).schedules).toHaveLength(2)

    await app.close()
  })

  it('§5.5 GET /items lists each item with its schedules', async () => {
    const u = await makeUser()
    const app = await buildTestApp(u.id)
    const item = await createItem(getTestPool(), {
      userId: u.id, name: 'Task A', recurrenceRule: DAILY,
    })
    await app.inject({
      method: 'POST', url: `/api/items/${item.id}/schedules`, payload: { recurrenceRule: DAILY },
    })

    const res = await app.inject({ method: 'GET', url: '/api/items' })
    const listed = JSON.parse(res.body).find((i: { id: string }) => i.id === item.id)
    expect(listed.schedules).toHaveLength(2)

    await app.close()
  })
})

describe('§5.5 PATCH and DELETE act on one slot', () => {
  it('§5.3 + §5.5 PATCH edits only the named slot', async () => {
    const u = await makeUser()
    const app = await buildTestApp(u.id)
    const item = await createItem(getTestPool(), {
      userId: u.id, name: 'Task A', recurrenceRule: DAILY,
      timingPrecision: 'point', timingStartTime: '08:30',
    })
    const [first] = await repos.findSchedulesByItem(getTestPool(), item.id, u.id)

    const added = await app.inject({
      method: 'POST', url: `/api/items/${item.id}/schedules`,
      payload: { recurrenceRule: DAILY, timingPrecision: 'point', timingStartTime: '13:00' },
    })
    const second = JSON.parse(added.body)

    const res = await app.inject({
      method: 'PATCH', url: `/api/items/${item.id}/schedules/${second.id}`,
      payload: { timingStartTime: '15:00' },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).timingStartTime).toBe('15:00:00')

    const stillFirst = await repos.findScheduleById(getTestPool(), first.id, u.id)
    expect(stillFirst!.timingStartTime).toBe('08:30:00')

    await app.close()
  })

  it('§5.5 DELETE archives the slot rather than removing the row (§3.4)', async () => {
    const u = await makeUser()
    const app = await buildTestApp(u.id)
    const item = await createItem(getTestPool(), {
      userId: u.id, name: 'Task A', recurrenceRule: DAILY,
    })
    const added = await app.inject({
      method: 'POST', url: `/api/items/${item.id}/schedules`, payload: { recurrenceRule: DAILY },
    })
    const second = JSON.parse(added.body)

    const res = await app.inject({
      method: 'DELETE', url: `/api/items/${item.id}/schedules/${second.id}`,
    })
    expect(res.statusCode).toBe(200)

    const archived = await repos.findScheduleById(getTestPool(), second.id, u.id)
    expect(archived).not.toBeNull()
    expect(archived!.archivedAt).not.toBeNull()

    await app.close()
  })

  it("§5.5 DELETE of an item's last slot is refused with 409", async () => {
    const u = await makeUser()
    const app = await buildTestApp(u.id)
    const item = await createItem(getTestPool(), {
      userId: u.id, name: 'Task A', recurrenceRule: DAILY,
    })
    const [only] = await repos.findSchedulesByItem(getTestPool(), item.id, u.id)

    const res = await app.inject({
      method: 'DELETE', url: `/api/items/${item.id}/schedules/${only.id}`,
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toBe('last_schedule')

    await app.close()
  })

  it('§5.5 a schedule belonging to another item is a 404, not a cross-item edit', async () => {
    const u = await makeUser()
    const app = await buildTestApp(u.id)
    const a = await createItem(getTestPool(), { userId: u.id, name: 'A', recurrenceRule: DAILY })
    const b = await createItem(getTestPool(), { userId: u.id, name: 'B', recurrenceRule: DAILY })
    const [bSchedule] = await repos.findSchedulesByItem(getTestPool(), b.id, u.id)

    const res = await app.inject({
      method: 'PATCH', url: `/api/items/${a.id}/schedules/${bSchedule.id}`,
      payload: { timingStartTime: '09:00' },
    })
    expect(res.statusCode).toBe(404)

    await app.close()
  })
})

// ── §5.5 The containment constraint, from both directions ────────────────────

describe('§5.5 an item with children carries at most one schedule', () => {
  it('§5.5 adding a second schedule to an item that has children is refused with 409', async () => {
    const u = await makeUser()
    const app = await buildTestApp(u.id)
    const parent = await createItem(getTestPool(), {
      userId: u.id, name: 'Routine', recurrenceRule: DAILY,
    })
    await createItem(getTestPool(), {
      userId: u.id, name: 'Child', recurrenceRule: DAILY, parentId: parent.id,
    })

    const res = await app.inject({
      method: 'POST', url: `/api/items/${parent.id}/schedules`, payload: { recurrenceRule: DAILY },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toBe('parent_multi_schedule')

    await app.close()
  })

  it('§5.5 creating a child under a multi-schedule item is refused with 409', async () => {
    const u = await makeUser()
    const app = await buildTestApp(u.id)
    const item = await createItem(getTestPool(), {
      userId: u.id, name: 'Two slots', recurrenceRule: DAILY,
    })
    await app.inject({
      method: 'POST', url: `/api/items/${item.id}/schedules`, payload: { recurrenceRule: DAILY },
    })

    const res = await app.inject({
      method: 'POST', url: '/api/items',
      payload: { name: 'Child', recurrenceRule: DAILY, parentId: item.id, creationSource: 'planned' },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toBe('parent_multi_schedule')

    await app.close()
  })

  it('§5.5 re-parenting an existing item under a multi-schedule item is refused with 409', async () => {
    const u = await makeUser()
    const app = await buildTestApp(u.id)
    const twoSlot = await createItem(getTestPool(), {
      userId: u.id, name: 'Two slots', recurrenceRule: DAILY,
    })
    await app.inject({
      method: 'POST', url: `/api/items/${twoSlot.id}/schedules`, payload: { recurrenceRule: DAILY },
    })
    const orphan = await createItem(getTestPool(), {
      userId: u.id, name: 'Orphan', recurrenceRule: DAILY,
    })

    const res = await app.inject({
      method: 'PATCH', url: `/api/items/${orphan.id}`, payload: { parentId: twoSlot.id },
    })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body).error).toBe('parent_multi_schedule')

    await app.close()
  })

  it('§5.5 re-parenting under a SINGLE-schedule item is still allowed', async () => {
    const u = await makeUser()
    const app = await buildTestApp(u.id)
    const parent = await createItem(getTestPool(), {
      userId: u.id, name: 'Parent', recurrenceRule: DAILY,
    })
    const orphan = await createItem(getTestPool(), {
      userId: u.id, name: 'Orphan', recurrenceRule: DAILY,
    })

    const res = await app.inject({
      method: 'PATCH', url: `/api/items/${orphan.id}`, payload: { parentId: parent.id },
    })
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).parentId).toBe(parent.id)

    await app.close()
  })
})

// ── §10.2 The log explains itself ────────────────────────────────────────────

describe('§5.5 schedule changes are recorded in the event log', () => {
  it('§10.2 + §5.5 adding, editing and removing a slot each append an event carrying its snapshot', async () => {
    const u = await makeUser()
    const app = await buildTestApp(u.id)
    const item = await createItem(getTestPool(), {
      userId: u.id, name: 'Task A', recurrenceRule: DAILY,
    })

    const added = await app.inject({
      method: 'POST', url: `/api/items/${item.id}/schedules`,
      payload: { recurrenceRule: DAILY, timingPrecision: 'point', timingStartTime: '13:00' },
    })
    const slot = JSON.parse(added.body)

    await app.inject({
      method: 'PATCH', url: `/api/items/${item.id}/schedules/${slot.id}`,
      payload: { timingStartTime: '15:00' },
    })
    await app.inject({ method: 'DELETE', url: `/api/items/${item.id}/schedules/${slot.id}` })

    // Schedule events are template-level (no occurrence), same as template_edited.
    const events = await repos.findTemplateEventsByItem(getTestPool(), item.id, u.id)
    const types = events.map((e) => e.eventType)
    expect(types).toContain('schedule_added')
    expect(types).toContain('schedule_edited')
    expect(types).toContain('schedule_removed')

    const addedEvent = events.find((e) => e.eventType === 'schedule_added')!
    if (addedEvent.eventType === 'schedule_added') {
      expect(addedEvent.payload.snapshot.scheduleId).toBe(slot.id)
      expect(addedEvent.payload.snapshot.timingStartTime).toBe('13:00:00')
    }

    const removedEvent = events.find((e) => e.eventType === 'schedule_removed')!
    if (removedEvent.eventType === 'schedule_removed') {
      // The edit moved it to 15:00, so the removal snapshot records that, not 13:00.
      expect(removedEvent.payload.snapshot.timingStartTime).toBe('15:00:00')
    }

    await app.close()
  })
})
