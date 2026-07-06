// §14.2 rules:
//   "every table round-trips (insert → read → correct types)"
//   "user_id scoping is present on all reads"
//   "soft-delete on categories/reasons works (archived rows excluded from normal reads,
//    still resolvable for history)"

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from './helpers/test-db'
import * as users      from '../db/repos/users'
import * as categories from '../db/repos/categories'
import * as reasons    from '../db/repos/reasons'
import * as buckets    from '../db/repos/buckets'
import * as dayStart   from '../db/repos/day_start'
import * as items      from '../db/repos/items'
import * as occurrences from '../db/repos/occurrences'
import * as events      from '../db/repos/events'
import type { ItemSnapshot } from '@tracker/shared'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

// ── Users ─────────────────────────────────────────────────────────────────────

describe('users table round-trips', () => {
  it('inserts and reads back a user with correct types', async () => {
    const pool = getTestPool()
    const u = await users.insertUser(pool, { email: 'test@example.com' })

    expect(u.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(u.email).toBe('test@example.com')
    expect(u.createdAt).toBeInstanceOf(Date)

    const found = await users.findUserById(pool, u.id)
    expect(found).not.toBeNull()
    expect(found!.email).toBe('test@example.com')
  })

  it('findUserByEmail returns null for unknown email', async () => {
    const pool = getTestPool()
    const result = await users.findUserByEmail(pool, 'nobody@nowhere.com')
    expect(result).toBeNull()
  })
})

// ── Categories ────────────────────────────────────────────────────────────────

describe('categories table round-trips', () => {
  it('inserts and reads back a category', async () => {
    const pool = getTestPool()
    const u    = await users.insertUser(pool, { email: 'cat-test@example.com' })
    const cat  = await categories.insertCategory(pool, { userId: u.id, name: 'Fitness' })

    expect(cat.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(cat.userId).toBe(u.id)
    expect(cat.name).toBe('Fitness')
    expect(cat.archivedAt).toBeNull()
    expect(cat.createdAt).toBeInstanceOf(Date)
  })

  it('§7 soft-delete: archived category is excluded from normal reads but resolvable by id', async () => {
    const pool = getTestPool()
    const u    = await users.insertUser(pool, { email: 'cat-archive@example.com' })
    const cat  = await categories.insertCategory(pool, { userId: u.id, name: 'To Archive' })

    // Appears in normal reads before archiving
    const before = await categories.findCategoriesByUser(pool, u.id)
    expect(before.map((c) => c.id)).toContain(cat.id)

    await categories.archiveCategory(pool, cat.id, u.id)

    // Excluded from normal reads after archiving
    const after = await categories.findCategoriesByUser(pool, u.id)
    expect(after.map((c) => c.id)).not.toContain(cat.id)

    // Still resolvable by id for historical event resolution
    const byId = await categories.findCategoryById(pool, cat.id, u.id)
    expect(byId).not.toBeNull()
    expect(byId!.archivedAt).toBeInstanceOf(Date)
  })
})

// ── Reasons ───────────────────────────────────────────────────────────────────

describe('reasons table round-trips', () => {
  it('inserts and reads back a reason', async () => {
    const pool = getTestPool()
    const u    = await users.insertUser(pool, { email: 'reason-test@example.com' })
    const r    = await reasons.insertReason(pool, { userId: u.id, name: 'Sick' })

    expect(r.userId).toBe(u.id)
    expect(r.name).toBe('Sick')
    expect(r.archivedAt).toBeNull()
  })

  it('§7 soft-delete: archived reason excluded from normal reads, resolvable by id', async () => {
    const pool = getTestPool()
    const u    = await users.insertUser(pool, { email: 'reason-archive@example.com' })
    const r    = await reasons.insertReason(pool, { userId: u.id, name: 'To Archive' })

    const before = await reasons.findReasonsByUser(pool, u.id)
    expect(before.map((x) => x.id)).toContain(r.id)

    await reasons.archiveReason(pool, r.id, u.id)

    const after = await reasons.findReasonsByUser(pool, u.id)
    expect(after.map((x) => x.id)).not.toContain(r.id)

    const byId = await reasons.findReasonById(pool, r.id, u.id)
    expect(byId!.archivedAt).toBeInstanceOf(Date)
  })
})

// ── Buckets ───────────────────────────────────────────────────────────────────

describe('buckets table round-trips', () => {
  it('inserts and reads back a bucket', async () => {
    const pool = getTestPool()
    const u    = await users.insertUser(pool, { email: 'bucket-test@example.com' })
    const b    = await buckets.insertBucket(pool, {
      userId: u.id, name: 'Morning', startTime: '06:00', endTime: '12:00', sortOrder: 1,
    })

    expect(b.userId).toBe(u.id)
    expect(b.name).toBe('Morning')
    expect(b.startTime).toContain('06:00')
    expect(b.endTime).toContain('12:00')
    expect(b.sortOrder).toBe(1)
  })

  it('findBucketsByUser returns buckets ordered by sort_order', async () => {
    const pool = getTestPool()
    const u    = await users.insertUser(pool, { email: 'bucket-order@example.com' })
    await buckets.insertBucket(pool, { userId: u.id, name: 'Evening',   startTime: '17:00', endTime: '22:00', sortOrder: 3 })
    await buckets.insertBucket(pool, { userId: u.id, name: 'Afternoon', startTime: '12:00', endTime: '17:00', sortOrder: 2 })
    await buckets.insertBucket(pool, { userId: u.id, name: 'Morning',   startTime: '06:00', endTime: '12:00', sortOrder: 1 })

    const list = await buckets.findBucketsByUser(pool, u.id)
    expect(list.map((b) => b.sortOrder)).toEqual([1, 2, 3])
  })
})

// ── Day-start timeline ────────────────────────────────────────────────────────

describe('day_start_timeline table round-trips', () => {
  it('inserts and reads back a day-start entry', async () => {
    const pool = getTestPool()
    const u    = await users.insertUser(pool, { email: 'ds-test@example.com' })
    const ds   = await dayStart.insertDayStartEntry(pool, {
      userId: u.id, startsOn: '2024-01-01', value: '04:00',
    })

    expect(ds.userId).toBe(u.id)
    expect(ds.startsOn).toBe('2024-01-01')
    expect(ds.value).toContain('04:00')
    expect(ds.recordedAt).toBeInstanceOf(Date)
  })

  it('§6.7 findEffectiveDayStart returns the correct entry for a given day', async () => {
    const pool = getTestPool()
    const u    = await users.insertUser(pool, { email: 'ds-effective@example.com' })

    await dayStart.insertDayStartEntry(pool, { userId: u.id, startsOn: '2024-01-01', value: '04:00' })
    await dayStart.insertDayStartEntry(pool, { userId: u.id, startsOn: '2024-06-01', value: '05:00' })

    const jan = await dayStart.findEffectiveDayStart(pool, u.id, '2024-03-15')
    expect(jan!.value).toContain('04:00')

    const jun = await dayStart.findEffectiveDayStart(pool, u.id, '2024-06-15')
    expect(jun!.value).toContain('05:00')

    const before = await dayStart.findEffectiveDayStart(pool, u.id, '2023-12-31')
    expect(before).toBeNull()
  })
})

// ── Items ─────────────────────────────────────────────────────────────────────

describe('items table round-trips', () => {
  it('inserts and reads back an item with all fields', async () => {
    const pool = getTestPool()
    const u    = await users.insertUser(pool, { email: 'item-test@example.com' })
    const cat  = await categories.insertCategory(pool, { userId: u.id, name: 'Health' })

    const item = await items.insertItem(pool, {
      userId:            u.id,
      name:              'Night Routine',
      description:       'Evening wind-down',
      categoryId:        cat.id,
      valence:           'productive',
      priority:          'medium',
      recurrenceRule:    { type: 'daily' },
      quotaTarget:       null,
      timingPrecision:   'none',
      dispositionPolicy: 'auto_close',
      creationSource:    'planned',
    })

    expect(item.userId).toBe(u.id)
    expect(item.name).toBe('Night Routine')
    expect(item.categoryId).toBe(cat.id)
    expect(item.valence).toBe('productive')
    expect(item.priority).toBe('medium')
    expect(item.recurrenceRule).toEqual({ type: 'daily' })
    expect(item.dispositionPolicy).toBe('auto_close')
    expect(item.archivedAt).toBeNull()
  })

  it('user_id scoping: findItemsByUser excludes other users items', async () => {
    const pool = getTestPool()
    const u1   = await users.insertUser(pool, { email: 'scope-u1@example.com' })
    const u2   = await users.insertUser(pool, { email: 'scope-u2@example.com' })
    await items.insertItem(pool, { userId: u1.id, name: 'U1 item' })
    await items.insertItem(pool, { userId: u2.id, name: 'U2 item' })

    const u1Items = await items.findItemsByUser(pool, u1.id)
    expect(u1Items.map((i) => i.name)).toContain('U1 item')
    expect(u1Items.map((i) => i.name)).not.toContain('U2 item')
  })

  it('§5.1 recurrence_rule JSONB round-trips all supported shapes', async () => {
    const pool = getTestPool()
    const u    = await users.insertUser(pool, { email: 'rrule-test@example.com' })

    const daysOfWeek = await items.insertItem(pool, {
      userId: u.id, name: 'MWF', recurrenceRule: { type: 'days_of_week', days: [1, 3, 5] },
    })
    expect(daysOfWeek.recurrenceRule).toEqual({ type: 'days_of_week', days: [1, 3, 5] })

    const interval = await items.insertItem(pool, {
      userId: u.id, name: 'Biweekly', recurrenceRule: { type: 'interval', unit: 'week', every: 2 },
    })
    expect(interval.recurrenceRule).toEqual({ type: 'interval', unit: 'week', every: 2 })

    const monthly = await items.insertItem(pool, {
      userId: u.id, name: 'Monthly', recurrenceRule: { type: 'monthly' },
    })
    expect(monthly.recurrenceRule).toEqual({ type: 'monthly' })

    const oneTime = await items.insertItem(pool, {
      userId: u.id, name: 'One-time', recurrenceRule: null,
    })
    expect(oneTime.recurrenceRule).toBeNull()
  })

  it('§4.2 prerequisite round-trips (insert and read)', async () => {
    const pool = getTestPool()
    const u    = await users.insertUser(pool, { email: 'prereq-test@example.com' })
    const a    = await items.insertItem(pool, { userId: u.id, name: 'Task A' })
    const b    = await items.insertItem(pool, { userId: u.id, name: 'Task B' })

    await items.insertPrerequisite(pool, b.id, a.id, u.id)

    const prereqs = await items.findPrerequisitesByItem(pool, b.id, u.id)
    expect(prereqs).toHaveLength(1)
    expect(prereqs[0].prerequisiteId).toBe(a.id)
  })

  it('§3.1 archived items excluded from findItemsByUser but resolvable by id', async () => {
    const pool = getTestPool()
    const u    = await users.insertUser(pool, { email: 'item-archive@example.com' })
    const item = await items.insertItem(pool, { userId: u.id, name: 'To Archive' })

    await items.archiveItem(pool, item.id, u.id)

    const list = await items.findItemsByUser(pool, u.id)
    expect(list.map((i) => i.id)).not.toContain(item.id)

    const byId = await items.findItemById(pool, item.id, u.id)
    expect(byId!.archivedAt).toBeInstanceOf(Date)
  })
})

// ── Occurrences ───────────────────────────────────────────────────────────────

describe('occurrences table round-trips', () => {
  it('inserts and reads back an occurrence with correct snapshot types', async () => {
    const pool  = getTestPool()
    const u     = await users.insertUser(pool, { email: 'occ-test@example.com' })
    const item  = await items.insertItem(pool, { userId: u.id, name: 'Routine' })

    const snapshot: ItemSnapshot = {
      name: 'Routine', description: null, categoryId: null, valence: null,
      priority: null, recurrenceRule: { type: 'daily' }, quotaTarget: null,
      timingPrecision: 'none', timingBucketId: null, timingStartTime: null,
      timingEndTime: null, plannedDurationMin: null, dispositionPolicy: 'skip',
      parentId: null, prerequisiteIds: [],
    }

    const occ = await occurrences.insertOccurrence(pool, {
      userId: u.id, itemId: item.id, appliesToDay: '2024-01-15', snapshot,
    })

    expect(occ.userId).toBe(u.id)
    expect(occ.itemId).toBe(item.id)
    expect(occ.appliesToDay).toBe('2024-01-15')
    expect(occ.snapshot).toEqual(snapshot)
    expect(occ.materializedAt).toBeInstanceOf(Date)
  })

  it('UNIQUE constraint: inserting duplicate item+day throws', async () => {
    const pool  = getTestPool()
    const u     = await users.insertUser(pool, { email: 'occ-unique@example.com' })
    const item  = await items.insertItem(pool, { userId: u.id, name: 'Unique test' })
    const snap: ItemSnapshot = {
      name: 'Unique test', description: null, categoryId: null, valence: null,
      priority: null, recurrenceRule: null, quotaTarget: null, timingPrecision: 'none',
      timingBucketId: null, timingStartTime: null, timingEndTime: null,
      plannedDurationMin: null, dispositionPolicy: 'skip', parentId: null, prerequisiteIds: [],
    }
    await occurrences.insertOccurrence(pool, {
      userId: u.id, itemId: item.id, appliesToDay: '2024-01-20', snapshot: snap,
    })
    await expect(
      occurrences.insertOccurrence(pool, {
        userId: u.id, itemId: item.id, appliesToDay: '2024-01-20', snapshot: snap,
      })
    ).rejects.toThrow()
  })

  it('user_id scoping: findOccurrencesByDay only returns the requesting user\'s rows', async () => {
    const pool  = getTestPool()
    const u1    = await users.insertUser(pool, { email: 'occ-scope-u1@example.com' })
    const u2    = await users.insertUser(pool, { email: 'occ-scope-u2@example.com' })
    const i1    = await items.insertItem(pool, { userId: u1.id, name: 'U1 item' })
    const i2    = await items.insertItem(pool, { userId: u2.id, name: 'U2 item' })
    const makeSnap = (name: string): ItemSnapshot => ({
      name, description: null, categoryId: null, valence: null, priority: null,
      recurrenceRule: null, quotaTarget: null, timingPrecision: 'none', timingBucketId: null,
      timingStartTime: null, timingEndTime: null, plannedDurationMin: null,
      dispositionPolicy: 'skip', parentId: null, prerequisiteIds: [],
    })
    await occurrences.insertOccurrence(pool, { userId: u1.id, itemId: i1.id, appliesToDay: '2024-02-01', snapshot: makeSnap('U1 item') })
    await occurrences.insertOccurrence(pool, { userId: u2.id, itemId: i2.id, appliesToDay: '2024-02-01', snapshot: makeSnap('U2 item') })

    const u1Occs = await occurrences.findOccurrencesByDay(pool, u1.id, '2024-02-01')
    expect(u1Occs.every((o) => o.userId === u1.id)).toBe(true)
    expect(u1Occs.map((o) => o.itemId)).not.toContain(i2.id)
  })
})

// ── Events ────────────────────────────────────────────────────────────────────

describe('events table round-trips', () => {
  it('inserts and reads back an item_completed event with correct types', async () => {
    const pool = getTestPool()
    const u    = await users.insertUser(pool, { email: 'evt-test@example.com' })
    const item = await items.insertItem(pool, { userId: u.id, name: 'Evt item' })

    const evt = await events.insertEvent(pool, {
      userId:        u.id,
      eventType:     'item_completed',
      itemId:        item.id,
      appliesToDay:  '2024-01-10',
      payload:       { completionPercent: 100, completionKind: 'declared' },
    })

    expect(evt.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(evt.userId).toBe(u.id)
    expect(evt.eventType).toBe('item_completed')
    expect(evt.recordedAt).toBeInstanceOf(Date)
    expect(evt.appliesToDay).toBe('2024-01-10')

    if (evt.eventType === 'item_completed') {
      expect(evt.payload.completionPercent).toBe(100)
      expect(evt.payload.completionKind).toBe('declared')
    }
  })

  it('user_id scoping: findEventsByDay only returns the requesting user\'s events', async () => {
    const pool = getTestPool()
    const u1   = await users.insertUser(pool, { email: 'evt-scope-u1@example.com' })
    const u2   = await users.insertUser(pool, { email: 'evt-scope-u2@example.com' })
    const i1   = await items.insertItem(pool, { userId: u1.id, name: 'E-U1 item' })
    const i2   = await items.insertItem(pool, { userId: u2.id, name: 'E-U2 item' })

    await events.insertEvent(pool, { userId: u1.id, eventType: 'skipped', itemId: i1.id, appliesToDay: '2024-03-01', payload: { reasonId: null, comment: null } })
    await events.insertEvent(pool, { userId: u2.id, eventType: 'skipped', itemId: i2.id, appliesToDay: '2024-03-01', payload: { reasonId: null, comment: null } })

    const u1Events = await events.findEventsByDay(pool, u1.id, '2024-03-01')
    expect(u1Events.every((e) => e.userId === u1.id)).toBe(true)
    expect(u1Events.map((e) => e.itemId)).not.toContain(i2.id)
  })

  it('config-level events (no item_id, no occurrence_id) insert and read correctly', async () => {
    const pool = getTestPool()
    const u    = await users.insertUser(pool, { email: 'evt-config@example.com' })

    const evt = await events.insertEvent(pool, {
      userId:    u.id,
      eventType: 'day_start_changed',
      payload:   { newValue: '04:00', effectiveFrom: '2024-01-01', previousValue: null },
    })

    expect(evt.occurrenceId).toBeNull()
    expect(evt.itemId).toBeNull()
    expect(evt.eventType).toBe('day_start_changed')
  })
})
