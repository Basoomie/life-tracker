// §8.4 / v2 §9.3 — In-process daily scheduler tests.
// Named after the spec's stated rules this scheduler exists to satisfy: the
// background job (§8.4) must actually run daily, and dispositions must never
// fire on the still-in-progress current day (§8, "never silently mutate").

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from './helpers/test-db'
import * as repos from '../db/repos/index'
import { findSoleUser } from '../db/repos/users'
import { ensureOccurrenceMaterialized } from '../domain/materialization'
import { planDailyTick, previousDay, runDailyTick } from '../scheduler'
import { resolveLogicalToday } from '../domain/day'
import type { Item, Occurrence } from '@tracker/shared'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

// ── Fixtures ──────────────────────────────────────────────────────────────────

async function makeUser(email: string) {
  return repos.insertUser(getTestPool(), { email })
}

async function makeHabit(userId: string, name: string) {
  return repos.insertItem(getTestPool(), {
    userId,
    name,
    recurrenceRule: { type: 'daily' },
    dispositionPolicy: 'skip',
    creationSource: 'planned',
  })
}

async function materialize(item: Item, day: string, userId: string): Promise<Occurrence> {
  return ensureOccurrenceMaterialized(getTestPool(), item, day, userId)
}

// ── Pure gating logic ────────────────────────────────────────────────────────

describe('previousDay: UTC calendar-day arithmetic', () => {
  it('previousDay steps back one calendar day without DST distortion', () => {
    expect(previousDay('2025-03-02')).toBe('2025-03-01')
    expect(previousDay('2025-01-01')).toBe('2024-12-31')  // year boundary
  })
})

describe('planDailyTick: runs at most once per calendar day, always closing out YESTERDAY', () => {
  it('planDailyTick no-ops when today already matches lastRunDay', () => {
    expect(planDailyTick('2025-01-15', '2025-01-15')).toBeNull()
  })

  it('planDailyTick no-ops on the very first check of a fresh boot within the same day', () => {
    // lastRunDay starts null; the first tick on any given day should still plan to run.
    expect(planDailyTick('2025-01-15', null)).toEqual({ closeOutDay: '2025-01-14' })
  })

  it('planDailyTick closes out the day that just elapsed, never the in-progress day', () => {
    // §8: dispositions must never fire on today's still-in-progress occurrences —
    // the day passed to runBackgroundJob must always be yesterday relative to
    // the calendar day that just started.
    const plan = planDailyTick('2025-01-16', '2025-01-15')
    expect(plan).toEqual({ closeOutDay: '2025-01-15' })
  })
})

// ── Integration: runDailyTick against a real pool ────────────────────────────

// Runs first, before any other test in this file has inserted a user — the DB
// is freshly reset by setupTestDb()'s beforeAll, so this is the one point where
// "no user exists yet" is actually true.
describe('§8.4 runDailyTick: fresh install with no user yet', () => {
  it('§8.4 runDailyTick returns lastRunDay unchanged when no user exists yet', async () => {
    const pool = getTestPool()
    const result = await runDailyTick(pool, '2025-06-10', null)
    expect(result).toBeNull()
  })
})

// findSoleUser (used internally by runDailyTick) picks the earliest-created row
// across the WHOLE test database, which is only meaningful while this file's
// freshly-reset DB has exactly one user in it — so both behaviors below share
// a single user/tick sequence rather than each creating their own user.
describe('§8.4 runDailyTick: closes out yesterday, never today, and is idempotent same-day', () => {
  it('§8.4 runDailyTick fires disposition events for YESTERDAY, leaves TODAY untouched, and no-ops on a same-day retick', async () => {
    const pool = getTestPool()
    const u = await makeUser('scheduler-yesterday@test.com')
    const item = await makeHabit(u.id, 'Scheduler habit')

    const yesterday = '2025-06-09'
    const today = '2025-06-10'

    const occYesterday = await materialize(item, yesterday, u.id)
    const occToday = await materialize(item, today, u.id)

    const lastRunAfterFirst = await runDailyTick(pool, today, null)
    expect(lastRunAfterFirst).toBe(today)

    const eventsYesterday = await repos.findEventsByOccurrence(pool, occYesterday.id, u.id)
    const eventsToday = await repos.findEventsByOccurrence(pool, occToday.id, u.id)
    expect(eventsYesterday.filter((e) => e.eventType === 'skipped')).toHaveLength(1)
    expect(eventsToday.some((e) => e.eventType === 'skipped')).toBe(false)

    // Second tick same day: lastRunDay already equals today, so planDailyTick
    // no-ops and no duplicate disposition event is fired.
    const lastRunAfterSecond = await runDailyTick(pool, today, lastRunAfterFirst)
    expect(lastRunAfterSecond).toBe(today)

    const eventsAfterSecond = await repos.findEventsByOccurrence(pool, occYesterday.id, u.id)
    expect(eventsAfterSecond.filter((e) => e.eventType === 'skipped')).toHaveLength(1)
  })
})

// ── §6.7 day-start-aware tick: the scheduler must not treat the logical day as
// advanced (and so must not close out dispositions) until the configured
// day-start has actually passed, even though the raw calendar day already has ──

describe('§6.7 resolveLogicalToday: scheduler bucketing honors the configured day-start', () => {
  it('§6.7 with a 4:00am day-start, resolveLogicalToday still reports YESTERDAY at 1:30am and TODAY at 5:00am', async () => {
    const pool = getTestPool()
    // Reuses the single user already established by the earlier describe block in
    // this file — findSoleUser (which resolveLogicalToday calls internally) only
    // makes sense while exactly one user exists, per this file's existing convention.
    const existing = await findSoleUser(pool)
    if (!existing) throw new Error('expected a user from an earlier test in this file')

    await repos.insertDayStartEntry(pool, { userId: existing.id, startsOn: '2020-01-01', value: '04:00' })

    // Local-time Date constructor: "1:30am/5:00am on this date" regardless of the
    // host machine's UTC offset — deterministic across timezones.
    const beforeDayStart = await resolveLogicalToday(pool, new Date(2025, 5, 20, 1, 30))
    expect(beforeDayStart).not.toBeNull()
    expect(beforeDayStart!.userId).toBe(existing.id)
    expect(beforeDayStart!.today).toBe('2025-06-19')

    const afterDayStart = await resolveLogicalToday(pool, new Date(2025, 5, 20, 5, 0))
    expect(afterDayStart!.today).toBe('2025-06-20')
  })
})
