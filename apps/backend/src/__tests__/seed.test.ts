// §14.2 rule: "the seed script runs and produces the expected rows"
//
// Verifies that the seed function populates the sample data described in §14.2:
// Night Routine (daily parent) → MWF Tretinoin child, 4×/week Workout with quota,
// day-trading range item (04:00–06:30), one-time ad-hoc gaming item,
// plus the categories, reasons, buckets, and day-start they need.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from './helpers/test-db'
import { seed } from '../db/seed'
import * as categories  from '../db/repos/categories'
import * as reasons     from '../db/repos/reasons'
import * as buckets     from '../db/repos/buckets'
import * as dayStart    from '../db/repos/day_start'
import * as items       from '../db/repos/items'

let seedUserId: string

beforeAll(async () => {
  await setupTestDb()
  // Insert a test user that seed will attach demo data to (bootstrap role for this test)
  const { rows: [u] } = await getTestPool().query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ('seed-test@test.com', 'placeholder') RETURNING id`
  )
  seedUserId = u.id
  await seed(getTestPool(), seedUserId)
})

afterAll(async () => { await teardownTestDb() })

describe('seed produces the expected categories', () => {
  it('creates Health, Fitness, Trading, Gaming categories', async () => {
    const cats = await categories.findCategoriesByUser(getTestPool(), seedUserId)
    const names = cats.map((c) => c.name)
    expect(names).toContain('Health')
    expect(names).toContain('Fitness')
    expect(names).toContain('Trading')
    expect(names).toContain('Gaming')
  })
})

describe('seed is idempotent', () => {
  it('running seed again does not duplicate categories', async () => {
    await seed(getTestPool(), seedUserId)  // second run
    const cats = await categories.findCategoriesByUser(getTestPool(), seedUserId)
    expect(cats).toHaveLength(4)
  })
})

describe('seed produces the expected reasons', () => {
  it('creates Sick, Traveling, Rest day reasons', async () => {
    const rList = await reasons.findReasonsByUser(getTestPool(), seedUserId)
    const names = rList.map((r) => r.name)
    expect(names).toContain('Sick')
    expect(names).toContain('Traveling')
    expect(names).toContain('Rest day')
  })
})

describe('seed produces the day-start timeline', () => {
  it('sets day-start to 04:00 effective 2024-01-01', async () => {
    const eff = await dayStart.findEffectiveDayStart(getTestPool(), seedUserId, '2024-06-15')
    expect(eff).not.toBeNull()
    expect(eff!.value).toContain('04:00')
  })
})

describe('seed produces the expected buckets', () => {
  it('creates 5 buckets tiling the day-start window', async () => {
    const bList = await buckets.findBucketsByUser(getTestPool(), seedUserId)
    expect(bList).toHaveLength(5)
    const names = bList.map((b) => b.name)
    expect(names).toContain('Early Morning')
    expect(names).toContain('Night')
  })
})

describe('seed produces the expected items', () => {
  it('creates Night Routine as a daily item', async () => {
    const allItems = await items.findItemsByUser(getTestPool(), seedUserId)
    const routine  = allItems.find((i) => i.name === 'Night Routine')
    expect(routine).toBeDefined()
    expect(routine!.recurrenceRule).toEqual({ type: 'daily' })
    expect(routine!.dispositionPolicy).toBe('auto_close')
    expect(routine!.parentId).toBeNull()
  })

  it('§4.1 Tretinoin is a child of Night Routine with MWF recurrence', async () => {
    const allItems = await items.findItemsByUser(getTestPool(), seedUserId)
    const routine  = allItems.find((i) => i.name === 'Night Routine')!
    const tret     = allItems.find((i) => i.name === 'Tretinoin')
    expect(tret).toBeDefined()
    expect(tret!.parentId).toBe(routine.id)
    expect(tret!.recurrenceRule).toEqual({ type: 'days_of_week', days: [1, 3, 5] })
  })

  it('§5.2 Workout has a 4×/week quota target', async () => {
    const allItems = await items.findItemsByUser(getTestPool(), seedUserId)
    const workout  = allItems.find((i) => i.name === 'Workout')
    expect(workout).toBeDefined()
    expect(workout!.quotaTarget).toEqual({ count: 4, period: 'week' })
  })

  it('§6.5 Day Trading has range timing 04:00–06:30 and planned 150 min', async () => {
    const allItems = await items.findItemsByUser(getTestPool(), seedUserId)
    const trading  = allItems.find((i) => i.name === 'Day Trading')
    expect(trading).toBeDefined()
    expect(trading!.timingPrecision).toBe('range')
    expect(trading!.timingStartTime).toContain('04:00')
    expect(trading!.timingEndTime).toContain('06:30')
    expect(trading!.plannedDurationMin).toBe(150)
  })

  it('§9.2 Gaming session is a one-time ad-hoc item', async () => {
    const allItems = await items.findItemsByUser(getTestPool(), seedUserId)
    const gaming   = allItems.find((i) => i.name === 'Gaming session')
    expect(gaming).toBeDefined()
    expect(gaming!.recurrenceRule).toBeNull()
    expect(gaming!.creationSource).toBe('ad_hoc')
  })
})
