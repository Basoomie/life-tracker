// §6.7 — logicalToday/resolveLogicalToday: the backend's single source of truth
// for "what day is it," honoring the user's configured day-start boundary instead
// of raw local midnight. Named after the spec rule this exists to satisfy.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { setupTestDb, teardownTestDb, getTestPool } from './helpers/test-db'
import * as users from '../db/repos/users'
import * as dayStart from '../db/repos/day_start'
import { logicalToday, todayLocal } from '../domain/day'

beforeAll(async () => { await setupTestDb() })
afterAll(async () => { await teardownTestDb() })

// Local-time Date constructor (year, monthIndex, day, hours, minutes) — always
// means "this wall-clock time" regardless of the host machine's UTC offset, so
// these assertions are deterministic across timezones (unlike an ISO 'Z' string,
// which would shift when interpreted against local time).
function localDateTime(y: number, m: number, d: number, h: number, min: number): Date {
  return new Date(y, m - 1, d, h, min)
}

describe('§6.7 logicalToday: buckets "now" through the user\'s day-start timeline', () => {
  it('§6.7 with no day-start configured, logicalToday equals the raw local calendar day', async () => {
    const pool = getTestPool()
    const u = await users.insertUser(pool, { email: 'logical-today-none@test.com' })

    const now = localDateTime(2024, 1, 15, 1, 30)
    expect(await logicalToday(pool, u.id, now)).toBe(todayLocal(now))
  })

  it('§6.7 with a 4:00am day-start, a 1:30am timestamp belongs to the previous logical day', async () => {
    const pool = getTestPool()
    const u = await users.insertUser(pool, { email: 'logical-today-before@test.com' })
    await dayStart.insertDayStartEntry(pool, { userId: u.id, startsOn: '2024-01-01', value: '04:00' })

    const now = localDateTime(2024, 1, 15, 1, 30)
    expect(await logicalToday(pool, u.id, now)).toBe('2024-01-14')
  })

  it('§6.7 with a 4:00am day-start, a 5:00am timestamp belongs to the current logical day', async () => {
    const pool = getTestPool()
    const u = await users.insertUser(pool, { email: 'logical-today-after@test.com' })
    await dayStart.insertDayStartEntry(pool, { userId: u.id, startsOn: '2024-01-01', value: '04:00' })

    const now = localDateTime(2024, 1, 15, 5, 0)
    expect(await logicalToday(pool, u.id, now)).toBe('2024-01-15')
  })

  it('§6.7 past logical days use the day-start value effective at the time, not the current one', async () => {
    const pool = getTestPool()
    const u = await users.insertUser(pool, { email: 'logical-today-timeline@test.com' })
    // 00:00 from Jan 1, changed to 04:00 from Jun 1.
    await dayStart.insertDayStartEntry(pool, { userId: u.id, startsOn: '2024-01-01', value: '00:00' })
    await dayStart.insertDayStartEntry(pool, { userId: u.id, startsOn: '2024-06-01', value: '04:00' })

    // Jan 15 at 01:00 — effective day-start was still 00:00 → belongs to Jan 15.
    expect(await logicalToday(pool, u.id, localDateTime(2024, 1, 15, 1, 0))).toBe('2024-01-15')
    // Jun 15 at 01:00 — effective day-start is now 04:00 → belongs to Jun 14.
    expect(await logicalToday(pool, u.id, localDateTime(2024, 6, 15, 1, 0))).toBe('2024-06-14')
  })
})

// resolveLogicalToday (the scheduler-facing sole-user + bucketing wrapper) is
// tested in scheduler.test.ts instead — it depends on findSoleUser, which only
// behaves predictably while exactly one user exists in the file's shared DB
// state, an invariant that file already establishes and maintains.
