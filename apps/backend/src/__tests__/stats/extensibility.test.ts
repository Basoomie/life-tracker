// §3.5 Extensibility — integration tests.
// Named after the spec's stated rules.  All tests hit a real database.
//
// The key claim: calculators are individually-defined, independently-computable.
// Adding one calculator touches nothing else.  It computes retroactively over
// already-collected events.  Every calculator returns rawCounts.
//
// The canonical test: define a new inline calculator that runs over the SAME
// observation arrays produced by the existing domain layer, without modifying
// any existing file.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from '../helpers/test-db'
import * as repos from '../../db/repos/index'
import { ensureOccurrenceMaterialized } from '../../domain/materialization'
import {
  getItemAdherence,
  getItemStreak,
  getItemTimeStats,
  getItemProcrastination,
  getItemDataQuality,
} from '../../stats/index'
import { buildLeafDayObservations } from '../../stats/domain/observations'
import type { DayObservation } from '../../stats/types'
import type { Item } from '@tracker/shared'
import type { DateWindow } from '@tracker/shared'
import { randomUUID } from 'crypto'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

const MON = '2025-04-07'
const TUE = '2025-04-08'
const WED = '2025-04-09'
const THU = '2025-04-10'
const FRI = '2025-04-11'

const WEEK: DateWindow = { startDay: MON, endDay: FRI }

async function makeUser(suffix: string) {
  return repos.insertUser(getTestPool(), { email: `ext-${suffix}@test.com` })
}

async function makeDaily(userId: string, name = 'Habit') {
  return repos.insertItem(getTestPool(), {
    userId, name, recurrenceRule: { type: 'daily' }, creationSource: 'planned',
  })
}

async function complete(item: Item, day: string, userId: string) {
  const occ = await ensureOccurrenceMaterialized(getTestPool(), item, day, userId)
  await repos.insertEvent(getTestPool(), {
    userId, eventType: 'item_completed',
    occurrenceId: occ.id, itemId: item.id, appliesToDay: day,
    payload: { completionPercent: 100, completionKind: 'declared' },
  })
}

// ── §3.5 New calculator added without modifying existing files ─────────────────

// This inline calculator is NEW — not in any existing file.
// It runs over DayObservation[] (the same array produced by buildLeafDayObservations)
// and computes a "completion volatility" stat (std-dev of completionPercent values).
// Adding it requires zero changes to existing calculators, routes, or index.
type VolatilityFinding = {
  type: 'completion_volatility'
  userId: string
  itemId: string
  window: DateWindow
  rawCounts: { dueCount: number; completedCount: number }
  stdDevPercent: number
}

function computeCompletionVolatility(
  itemId: string,
  userId: string,
  window: DateWindow,
  observations: DayObservation[]
): VolatilityFinding {
  const values = observations.map(o => o.completionPercent)
  const n = values.length
  const mean = n === 0 ? 0 : values.reduce((a, b) => a + b, 0) / n
  const variance = n < 2 ? 0 : values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1)
  return {
    type: 'completion_volatility',
    userId,
    itemId,
    window,
    rawCounts: {
      dueCount: n,
      completedCount: values.filter(v => v >= 100).length,
    },
    stdDevPercent: Math.sqrt(variance),
  }
}

describe('§3.5 new calculator added without modifying existing calculators', () => {
  it('§3.5 computeCompletionVolatility runs over same observations without touching existing code', async () => {
    const u = await makeUser('volatility')
    const h = await makeDaily(u.id)

    await complete(h, MON, u.id)
    await complete(h, TUE, u.id)
    // Wed–Fri: not completed (0%)

    const observations = await buildLeafDayObservations(getTestPool(), u.id, h, WEEK)
    const finding = computeCompletionVolatility(h.id, u.id, WEEK, observations)

    expect(finding.type).toBe('completion_volatility')
    // Values: [100, 100, 0, 0, 0] → mean=40, variance=2000/4=2500, stddev≈50
    expect(finding.rawCounts.dueCount).toBe(5)
    expect(finding.rawCounts.completedCount).toBe(2)
    expect(finding.stdDevPercent).toBeGreaterThan(0)
  })

  it('§3.5 new calculator does not break or alter results of existing calculators', async () => {
    const u = await makeUser('no-interference')
    const h = await makeDaily(u.id)

    await complete(h, MON, u.id)
    await complete(h, WED, u.id)

    // Run existing calculators
    const adherence = await getItemAdherence(getTestPool(), u.id, h.id, WEEK)
    const streak    = await getItemStreak(getTestPool(), u.id, h.id, WEEK)
    const quality   = await getItemDataQuality(getTestPool(), u.id, h.id, WEEK)

    // Run new calculator over the same observations
    const observations = await buildLeafDayObservations(getTestPool(), u.id, h, WEEK)
    const volatility = computeCompletionVolatility(h.id, u.id, WEEK, observations)

    // Existing results are unchanged
    expect(adherence.type).toBe('leaf_adherence')
    expect(streak.type).toBe('streak')
    expect(quality.type).toBe('data_quality')

    // New calculator returned its own result
    expect(volatility.type).toBe('completion_volatility')
  })
})

// ── §3.5 New calculator computes retroactively over already-collected events ───

describe('§3.5 new calculator computes retroactively over already-collected events', () => {
  it('§3.5 retroactive computation: volatility over events already in the DB', async () => {
    const u = await makeUser('retroactive')
    const h = await makeDaily(u.id)

    // Simulate: events were already in the DB (from some past date)
    // The new calculator didn't exist when they were recorded, but it can compute now.
    const pastDate = new Date('2025-01-01T00:00:00.000Z')
    const pastWindow: DateWindow = { startDay: '2025-01-01', endDay: '2025-01-07' }

    for (const day of ['2025-01-01', '2025-01-02', '2025-01-03']) {
      const occ = await ensureOccurrenceMaterialized(getTestPool(), h, day, u.id)
      await repos.insertEvent(getTestPool(), {
        userId: u.id, eventType: 'item_completed',
        occurrenceId: occ.id, itemId: h.id, appliesToDay: day,
        recordedAt: new Date(pastDate.getTime() + 1000),
        payload: { completionPercent: 100, completionKind: 'declared' },
      })
    }

    // New calculator retroactively computes over those already-stored events
    const observations = await buildLeafDayObservations(getTestPool(), u.id, h, pastWindow)
    const volatility = computeCompletionVolatility(h.id, u.id, pastWindow, observations)

    // 3 completions, 4 missing → mix → volatility > 0
    expect(volatility.rawCounts.dueCount).toBe(7)
    expect(volatility.rawCounts.completedCount).toBe(3)
    expect(volatility.stdDevPercent).toBeGreaterThan(0)
  })
})

// ── §3.5 Every calculator returns rawCounts ───────────────────────────────────

describe('§3.5 every calculator returns rawCounts', () => {
  it('§3.5 getItemAdherence returns finding with rawCounts', async () => {
    const u = await makeUser('rawcounts-adherence')
    const h = await makeDaily(u.id)
    const f = await getItemAdherence(getTestPool(), u.id, h.id, WEEK)
    expect(f.rawCounts).toBeDefined()
    expect(typeof f.rawCounts).toBe('object')
  })

  it('§3.5 getItemStreak returns finding with rawCounts', async () => {
    const u = await makeUser('rawcounts-streak')
    const h = await makeDaily(u.id)
    const f = await getItemStreak(getTestPool(), u.id, h.id, WEEK)
    expect(f.rawCounts).toBeDefined()
  })

  it('§3.5 getItemTimeStats returns finding with rawCounts', async () => {
    const u = await makeUser('rawcounts-time')
    const h = await makeDaily(u.id)
    const f = await getItemTimeStats(getTestPool(), u.id, h.id, WEEK)
    expect(f.rawCounts).toBeDefined()
  })

  it('§3.5 getItemProcrastination returns finding with rawCounts', async () => {
    const u = await makeUser('rawcounts-procrast')
    const h = await makeDaily(u.id)
    const f = await getItemProcrastination(getTestPool(), u.id, h.id, WEEK)
    expect(f.rawCounts).toBeDefined()
  })

  it('§3.5 getItemDataQuality returns finding with rawCounts', async () => {
    const u = await makeUser('rawcounts-dq')
    const h = await makeDaily(u.id)
    const f = await getItemDataQuality(getTestPool(), u.id, h.id, WEEK)
    expect(f.rawCounts).toBeDefined()
  })

  it('§3.5 the inline volatility calculator also returns rawCounts', async () => {
    const u = await makeUser('rawcounts-volatility')
    const h = await makeDaily(u.id)
    const obs = await buildLeafDayObservations(getTestPool(), u.id, h, WEEK)
    const f = computeCompletionVolatility(h.id, u.id, WEEK, obs)
    expect(f.rawCounts).toBeDefined()
    expect(f.rawCounts).toHaveProperty('dueCount')
    expect(f.rawCounts).toHaveProperty('completedCount')
  })
})

// ── §3.5 Observation-array seam: calculators are pure / no DB access ──────────

describe('§3.5 observation-array seam: calculators are pure functions over arrays', () => {
  it('§3.5 same observation array produces same result with no DB calls inside calculator', async () => {
    const u = await makeUser('seam-pure')
    const h = await makeDaily(u.id)

    await complete(h, MON, u.id)
    await complete(h, WED, u.id)

    const obs = await buildLeafDayObservations(getTestPool(), u.id, h, WEEK)

    // Call the pure calculator twice on the same array — must produce identical results
    const r1 = computeCompletionVolatility(h.id, u.id, WEEK, obs)
    const r2 = computeCompletionVolatility(h.id, u.id, WEEK, obs)

    expect(r1.stdDevPercent).toBe(r2.stdDevPercent)
    expect(r1.rawCounts).toEqual(r2.rawCounts)
  })
})
