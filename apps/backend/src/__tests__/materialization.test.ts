// §5.3 / §5.4 — Lazy materialization integration tests.
//
// Tests named after the spec's stated rules (§5.3 frozen history, §5.4 lazy
// materialization).  All tests hit a real database via the test pool.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from './helpers/test-db'
import * as repos from '../db/repos/index'
import { getDueDays } from '@tracker/shared'
import {
  ensureOccurrenceMaterialized,
  topUpMaterialization,
  regenerateFutureOccurrences,
  getOccurrencesInRange,
  horizonDays,
} from '../domain/materialization'
import type { Item, ItemSnapshot } from '@tracker/shared'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

// ── Fixtures ──────────────────────────────────────────────────────────────────

// All test items use an anchor well before 'today' so the range always includes
// valid occurrences.  Using a fixed "today" string keeps tests deterministic.
const TODAY = '2025-01-15'
const ANCHOR = '2024-01-01'  // well before TODAY

async function makeUser(email: string) {
  return repos.insertUser(getTestPool(), { email })
}

async function makeDailyItem(userId: string, name = 'Daily item') {
  return repos.insertItem(getTestPool(), {
    userId,
    name,
    recurrenceRule: { type: 'daily' },
    creationSource: 'planned',
  })
}

async function makeMWFItem(userId: string) {
  return repos.insertItem(getTestPool(), {
    userId,
    name: 'MWF item',
    recurrenceRule: { type: 'days_of_week', days: [1, 3, 5] },
    creationSource: 'planned',
  })
}

async function makeMonthlyItem(userId: string) {
  return repos.insertItem(getTestPool(), {
    userId,
    name: 'Monthly item',
    recurrenceRule: { type: 'monthly' },
    creationSource: 'planned',
  })
}

// Re-fetch an item so createdAt reflects the actual DB timestamp.
// The anchor date derivation uses createdAt.toISOString().slice(0,10).
// We override the item's createdAt via a backdated insert by using an older
// test user and trusting that creation is "today" relative to TODAY.
// For interval rule tests we explicitly set a known anchor via a separate
// utility rather than relying on createdAt timing.

// ── §5.4 Far-future stays computed ───────────────────────────────────────────

describe('§5.4 far-future occurrences are computed, not stored', () => {
  it('§5.4 querying next year returns due days without writing any rows', async () => {
    const pool = getTestPool()
    const u    = await makeUser('mat-far-future@test.com')
    const item = await makeDailyItem(u.id)

    const nextYearStart = '2026-01-01'
    const nextYearEnd   = '2026-01-07'

    // Before query: no rows exist for next year
    const beforeRows = await repos.findOccurrencesByRange(pool, u.id, nextYearStart, nextYearEnd)
    expect(beforeRows).toHaveLength(0)

    // getOccurrencesInRange should return computed occurrences (id=null) without writing rows
    const occs = await getOccurrencesInRange(pool, u.id, nextYearStart, nextYearEnd)
    expect(occs).toHaveLength(7)  // 7 days for a daily item
    expect(occs.every((o) => o.id === null)).toBe(true)
    expect(occs.every((o) => o.materializedAt === null)).toBe(true)

    // After query: still no rows written
    const afterRows = await repos.findOccurrencesByRange(pool, u.id, nextYearStart, nextYearEnd)
    expect(afterRows).toHaveLength(0)
  })
})

// ── §5.4 Near-term topup ──────────────────────────────────────────────────────

describe('§5.4 topUpMaterialization: near-term horizon', () => {
  it('§5.4 topUpMaterialization: daily item gets ~7 materialized rows within horizon', async () => {
    const pool = getTestPool()
    const u    = await makeUser('mat-daily-topup@test.com')
    const item = await makeDailyItem(u.id)

    await topUpMaterialization(pool, u.id, TODAY)

    const horizon = horizonDays({ type: 'daily' })  // 7
    const endDay  = addDays(TODAY, horizon)
    const rows    = await repos.findOccurrencesByRange(pool, u.id, TODAY, endDay)
    expect(rows.length).toBe(horizon + 1)  // TODAY .. TODAY+7 inclusive = 8 days
  })

  it('§5.4 topUpMaterialization: MWF item only materializes Mon/Wed/Fri rows', async () => {
    const pool = getTestPool()
    const u    = await makeUser('mat-mwf-topup@test.com')
    const item = await makeMWFItem(u.id)

    await topUpMaterialization(pool, u.id, TODAY)

    // All materialized rows should be on Mon/Wed/Fri
    const horizon = horizonDays({ type: 'days_of_week', days: [1, 3, 5] })
    const rows = await repos.findOccurrencesByRange(pool, u.id, TODAY, addDays(TODAY, horizon))
    for (const row of rows) {
      const dow = new Date(row.appliesToDay + 'T12:00:00Z').getUTCDay()
      expect([1, 3, 5]).toContain(dow)
    }
    // Should be fewer rows than a daily item for the same horizon
    const dailyHorizon = horizonDays({ type: 'daily' })
    const dailyU    = await makeUser('mat-daily-compare@test.com')
    const dailyItem = await makeDailyItem(dailyU.id)
    await topUpMaterialization(pool, dailyU.id, TODAY)
    const dailyRows = await repos.findOccurrencesByRange(pool, dailyU.id, TODAY, addDays(TODAY, dailyHorizon))
    expect(rows.length).toBeLessThan(dailyRows.length)
  })

  it('§5.4 topUpMaterialization: already-materialized rows are not duplicated', async () => {
    const pool = getTestPool()
    const u    = await makeUser('mat-no-dup@test.com')
    const item = await makeDailyItem(u.id)

    await topUpMaterialization(pool, u.id, TODAY)
    const firstCount = (await repos.findOccurrencesByRange(pool, u.id, TODAY, addDays(TODAY, 30))).length

    // Run again — should be idempotent
    await topUpMaterialization(pool, u.id, TODAY)
    const secondCount = (await repos.findOccurrencesByRange(pool, u.id, TODAY, addDays(TODAY, 30))).length

    expect(secondCount).toBe(firstCount)
  })
})

// ── §5.4 First-event touch ────────────────────────────────────────────────────

describe('§5.4 first event touch materializes the occurrence', () => {
  it('§5.4 ensureOccurrenceMaterialized creates a stored row on first call', async () => {
    const pool = getTestPool()
    const u    = await makeUser('mat-first-touch@test.com')
    const item = await makeDailyItem(u.id)

    const futureDay = '2027-06-15'  // far future, certainly not in any horizon

    // No row yet
    const before = await repos.findOccurrenceByItemAndDay(pool, item.id, futureDay, u.id)
    expect(before).toBeNull()

    // Touch it
    const occ = await ensureOccurrenceMaterialized(pool, item, futureDay, u.id)
    expect(occ.id).toBeDefined()
    expect(occ.appliesToDay).toBe(futureDay)
    expect(occ.snapshot.name).toBe('Daily item')

    // Now stored
    const after = await repos.findOccurrenceByItemAndDay(pool, item.id, futureDay, u.id)
    expect(after).not.toBeNull()
    expect(after!.id).toBe(occ.id)
  })

  it('§5.4 ensureOccurrenceMaterialized is idempotent (no-op if already exists)', async () => {
    const pool = getTestPool()
    const u    = await makeUser('mat-idempotent@test.com')
    const item = await makeDailyItem(u.id, 'Idempotent item')

    const day = '2027-07-10'
    const first  = await ensureOccurrenceMaterialized(pool, item, day, u.id)
    const second = await ensureOccurrenceMaterialized(pool, item, day, u.id)
    expect(second.id).toBe(first.id)  // same row returned
  })
})

// ── §5.4 Proportional horizon ─────────────────────────────────────────────────

describe('§5.4 proportional horizon: daily=few rows, monthly=fewer', () => {
  it('§5.4 daily item horizon is 7 days — not 365', () => {
    expect(horizonDays({ type: 'daily' })).toBe(7)
  })

  it('§5.4 monthly item horizon is 60 days (~2 occurrences), not 365', () => {
    expect(horizonDays({ type: 'monthly' })).toBe(60)
  })

  it('§5.4 biweekly item horizon is proportional (28 days = 2 × 14-day period)', () => {
    expect(horizonDays({ type: 'interval', unit: 'week', every: 2 })).toBe(28)
  })

  it('§5.4 proportional horizon: monthly item materializes ~2 rows after topUp (not 12)', async () => {
    const pool = getTestPool()
    const u    = await makeUser('mat-monthly-horizon@test.com')
    const item = await makeMonthlyItem(u.id)

    await topUpMaterialization(pool, u.id, TODAY)

    const rows = await repos.findOccurrencesByRange(pool, u.id, TODAY, addDays(TODAY, 365))
    // 60-day horizon → at most 2 monthly occurrences; certainly not 12
    expect(rows.length).toBeLessThanOrEqual(2)
    expect(rows.length).toBeGreaterThanOrEqual(1)
  })
})

// ── §5.3 Template edit — frozen history ──────────────────────────────────────

describe('§5.3 regenerateFutureOccurrences', () => {
  it('§5.3 template edit: untouched future occurrences get updated snapshot', async () => {
    const pool = getTestPool()
    const u    = await makeUser('mat-regen-untouched@test.com')
    const item = await makeDailyItem(u.id, 'Original name')

    // Materialize some future rows
    await topUpMaterialization(pool, u.id, TODAY)
    const beforeRows = await repos.findOccurrencesByRange(pool, u.id, TODAY, addDays(TODAY, 10))
    expect(beforeRows.every((r) => r.snapshot.name === 'Original name')).toBe(true)

    // Update the template
    const updated = await repos.updateItem(pool, item.id, u.id, { name: 'Renamed' })
    expect(updated!.name).toBe('Renamed')

    // Regenerate
    await regenerateFutureOccurrences(pool, updated!, u.id, TODAY)

    const afterRows = await repos.findOccurrencesByRange(pool, u.id, TODAY, addDays(TODAY, 10))
    expect(afterRows.every((r) => r.snapshot.name === 'Renamed')).toBe(true)
  })

  it('§5.3 template edit: past occurrences are frozen (unchanged)', async () => {
    const pool   = getTestPool()
    const u      = await makeUser('mat-regen-past@test.com')
    const item   = await makeDailyItem(u.id, 'Past item')

    // Manually insert a past occurrence with the old snapshot
    const pastDay = '2024-12-01'  // before TODAY
    const oldSnap: ItemSnapshot = {
      name: 'Past item', description: null, categoryId: null, valence: null,
      priority: null, recurrenceRule: { type: 'daily' }, quotaTarget: null,
      timingPrecision: 'none', timingBucketId: null, timingStartTime: null,
      timingEndTime: null, plannedDurationMin: null, dispositionPolicy: 'skip',
      parentId: null, prerequisiteIds: [],
    }
    const pastOcc = await repos.insertOccurrence(pool, {
      userId: u.id, itemId: item.id, appliesToDay: pastDay, snapshot: oldSnap,
    })

    // Update template
    const updated = await repos.updateItem(pool, item.id, u.id, { name: 'New name' })!

    // Regenerate with today > pastDay
    await regenerateFutureOccurrences(pool, updated!, u.id, TODAY)

    // Past occurrence must be unchanged
    const stillPast = await repos.findOccurrenceById(pool, pastOcc.id, u.id)
    expect(stillPast!.snapshot.name).toBe('Past item')  // frozen
  })

  it('§5.3 template edit: occurrences with events are frozen (untouched by regeneration)', async () => {
    const pool = getTestPool()
    const u    = await makeUser('mat-regen-evented@test.com')
    const item = await makeDailyItem(u.id, 'Evented item')

    // Materialize a future occurrence
    await topUpMaterialization(pool, u.id, TODAY)
    const futureDay = addDays(TODAY, 1)
    const occ = await repos.findOccurrenceByItemAndDay(pool, item.id, futureDay, u.id)
    expect(occ).not.toBeNull()

    // Attach an event to it
    await repos.insertEvent(pool, {
      userId:       u.id,
      eventType:    'skipped',
      itemId:       item.id,
      occurrenceId: occ!.id,
      appliesToDay: futureDay,
      payload:      { reasonId: null, comment: 'test' },
    })

    // Update template
    const updated = await repos.updateItem(pool, item.id, u.id, { name: 'Post-edit name' })

    // Regenerate
    await regenerateFutureOccurrences(pool, updated!, u.id, TODAY)

    // The evented occurrence must survive with its original snapshot
    const survived = await repos.findOccurrenceById(pool, occ!.id, u.id)
    expect(survived).not.toBeNull()
    expect(survived!.snapshot.name).toBe('Evented item')  // frozen — not 'Post-edit name'
  })
})

// ── §5.4 Merged read API ──────────────────────────────────────────────────────

describe('§5.4 getOccurrencesInRange: merged read API', () => {
  it('§5.4 materialized occurrences have id set; computed-on-the-fly have id=null', async () => {
    const pool = getTestPool()
    const u    = await makeUser('mat-merge-ids@test.com')
    const item = await makeDailyItem(u.id)

    const horizon = horizonDays({ type: 'daily' })  // 7

    // Materialize only the near-term horizon
    await topUpMaterialization(pool, u.id, TODAY)

    // Query a wider range: [TODAY, TODAY+20]
    const wideEnd = addDays(TODAY, 20)
    const occs    = await getOccurrencesInRange(pool, u.id, TODAY, wideEnd)

    // Occurrences within the 7-day horizon should be stored (id set)
    const nearEnd = addDays(TODAY, horizon)
    const nearOccs = occs.filter((o) => o.appliesToDay <= nearEnd)
    const farOccs  = occs.filter((o) => o.appliesToDay > nearEnd)

    expect(nearOccs.every((o) => o.id !== null)).toBe(true)
    expect(nearOccs.every((o) => o.materializedAt !== null)).toBe(true)
    expect(farOccs.every((o) => o.id === null)).toBe(true)
    expect(farOccs.every((o) => o.materializedAt === null)).toBe(true)
  })

  it('§5.4 getOccurrencesInRange: total due days match getDueDays for same range', async () => {
    const pool = getTestPool()
    const u    = await makeUser('mat-merge-duedays@test.com')
    const item = await makeMWFItem(u.id)

    const startDay = TODAY
    const endDay   = addDays(TODAY, 30)

    const occs    = await getOccurrencesInRange(pool, u.id, startDay, endDay)
    const itemOccs = occs.filter((o) => o.itemId === item.id)

    // Compare with getDueDays using UTC anchor date
    const anchor  = item.createdAt.toISOString().slice(0, 10)
    const expected = getDueDays(item.recurrenceRule!, startDay, endDay, anchor)

    expect(itemOccs.map((o) => o.appliesToDay)).toEqual(expected)
  })

  it('§5.4 getOccurrencesInRange: identical logical results whether stored or computed', async () => {
    const pool = getTestPool()
    const u    = await makeUser('mat-merge-logical@test.com')
    const item = await makeDailyItem(u.id, 'Logical item')

    const range = { start: addDays(TODAY, 10), end: addDays(TODAY, 17) }

    // First call: no rows materialized in this range → all computed
    const computed = await getOccurrencesInRange(pool, u.id, range.start, range.end)
    expect(computed.every((o) => o.id === null)).toBe(true)

    // Materialize those occurrences
    for (const occ of computed) {
      await ensureOccurrenceMaterialized(pool, item, occ.appliesToDay, u.id)
    }

    // Second call: now stored → all materialized
    const stored = await getOccurrencesInRange(pool, u.id, range.start, range.end)
    expect(stored.every((o) => o.id !== null)).toBe(true)

    // The logical days must be identical
    expect(stored.map((o) => o.appliesToDay)).toEqual(computed.map((o) => o.appliesToDay))

    // Snapshot name must be identical (same template, same snapshot fields)
    for (let i = 0; i < stored.length; i++) {
      expect(stored[i].snapshot.name).toBe(computed[i].snapshot.name)
    }
  })
})

// ── Invariant property test ───────────────────────────────────────────────────

describe('invariant: computed due-days == materialized rows appliesToDay for same range', () => {
  it('invariant: for a daily rule, materialization never changes which days are due', async () => {
    const pool = getTestPool()
    const u    = await makeUser('mat-inv-daily@test.com')
    const item = await makeDailyItem(u.id)

    await topUpMaterialization(pool, u.id, TODAY)

    const horizon = horizonDays({ type: 'daily' })
    const endDay  = addDays(TODAY, horizon)
    const anchor  = item.createdAt.toISOString().slice(0, 10)

    const expectedDays = getDueDays(item.recurrenceRule!, TODAY, endDay, anchor)
    const rows         = await repos.findOccurrencesByRange(pool, u.id, TODAY, endDay)

    expect(rows.map((r) => r.appliesToDay)).toEqual(expectedDays)
  })

  it('invariant: for an MWF rule, materialized days match computed due-days exactly', async () => {
    const pool = getTestPool()
    const u    = await makeUser('mat-inv-mwf@test.com')
    const item = await makeMWFItem(u.id)

    await topUpMaterialization(pool, u.id, TODAY)

    const horizon = horizonDays({ type: 'days_of_week', days: [1, 3, 5] })
    const endDay  = addDays(TODAY, horizon)
    const anchor  = item.createdAt.toISOString().slice(0, 10)

    const expectedDays = getDueDays(item.recurrenceRule!, TODAY, endDay, anchor)
    const rows         = await repos.findOccurrencesByRange(pool, u.id, TODAY, endDay)

    expect(rows.map((r) => r.appliesToDay)).toEqual(expectedDays)
  })

  it('invariant: for a monthly rule, materialized days match computed due-days exactly', async () => {
    const pool = getTestPool()
    const u    = await makeUser('mat-inv-monthly@test.com')
    const item = await makeMonthlyItem(u.id)

    await topUpMaterialization(pool, u.id, TODAY)

    const horizon = horizonDays({ type: 'monthly' })
    const endDay  = addDays(TODAY, horizon)
    const anchor  = item.createdAt.toISOString().slice(0, 10)

    const expectedDays = getDueDays(item.recurrenceRule!, TODAY, endDay, anchor)
    const rows         = await repos.findOccurrencesByRange(pool, u.id, TODAY, endDay)

    expect(rows.map((r) => r.appliesToDay)).toEqual(expectedDays)
  })
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return (
    String(dt.getUTCFullYear()) +
    '-' +
    String(dt.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(dt.getUTCDate()).padStart(2, '0')
  )
}
