// v2 §6.4 / §9.3 — Cadence & scheduling.
//
// "Period boundaries respect the configurable day-start, never midnight. A review
// generated at 3am Sunday must review the week that JUST ENDED." The caller (the
// background job, per §9.3: "reuse v1's existing background job") is responsible for
// turning a real timestamp into a logical day via v1's bucketTimestamp/bucketLocalDateTime
// (packages/shared/src/domain/day-start.ts) BEFORE calling determineClosedPeriods — this
// module only does calendar arithmetic on the resulting logical day string, so day-start
// bucketing is honored by construction rather than re-implemented here.
//
// "The week boundary itself is configurable (Sunday vs. Monday start), and must align with
// quota-habit periods" — weekStartDay is a per-user preference (user_preferences table,
// same mechanism as every other v1 preference), defaulting to 'monday' to match the
// existing ISO-week convention already used by the quota streak calculator
// (apps/backend/src/stats/calculators/streaks.ts).
//
// No daily cadence exists here — there is no branch that ever fires "daily" (§6.4: "a
// single day can't clear any threshold; commenting on it is forbidden").

import type { Pool } from 'pg'
import type { DateWindow, ReviewCadence } from '@tracker/shared'
import { getAllUserPreferences } from '../db/repos/preferences'

export type WeekStartDay = 'sunday' | 'monday'

export type ReviewPeriod = {
  cadence: ReviewCadence
  window: DateWindow
}

function formatDateUTC(dt: Date): string {
  return (
    String(dt.getUTCFullYear()) +
    '-' +
    String(dt.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(dt.getUTCDate()).padStart(2, '0')
  )
}

function addDaysUTC(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  return formatDateUTC(new Date(Date.UTC(y, m - 1, d + n)))
}

function dayOfWeekUTC(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/**
 * §9.3 — Given the logical day that has just started (already day-start-bucketed by the
 * caller), returns every cadence period that just closed. 0–3 entries: a given day can be
 * simultaneously a week-start, a month-start, and a quarter-start.
 */
export function determineClosedPeriods(day: string, weekStartDay: WeekStartDay): ReviewPeriod[] {
  const periods: ReviewPeriod[] = []
  const [, m, d] = day.split('-').map(Number)

  // Weekly: the 7 days ending yesterday — never split a quota-habit's period (§9.3).
  const weekStartDow = weekStartDay === 'sunday' ? 0 : 1
  if (dayOfWeekUTC(day) === weekStartDow) {
    periods.push({
      cadence: 'weekly',
      window: { startDay: addDaysUTC(day, -7), endDay: addDaysUTC(day, -1) },
    })
  }

  // Monthly: the entire previous calendar month.
  if (d === 1) {
    const lastDayPrevMonth = addDaysUTC(day, -1)
    const [py, pm] = lastDayPrevMonth.split('-').map(Number)
    periods.push({
      cadence: 'monthly',
      window: { startDay: `${py}-${String(pm).padStart(2, '0')}-01`, endDay: lastDayPrevMonth },
    })

    // Quarterly: fires on the 1st of Jan/Apr/Jul/Oct, covering the previous 3 months.
    if (m === 1 || m === 4 || m === 7 || m === 10) {
      const quarterStart = formatDateUTC(new Date(Date.UTC(py, pm - 1 - 2, 1)))
      periods.push({
        cadence: 'quarterly',
        window: { startDay: quarterStart, endDay: lastDayPrevMonth },
      })
    }
  }

  return periods
}

const DEFAULT_WEEK_START_DAY: WeekStartDay = 'monday'

export async function resolveWeekStartDay(pool: Pool, userId: string): Promise<WeekStartDay> {
  const prefs = await getAllUserPreferences(pool, userId)
  const value = prefs['weekStartDay']
  return value === 'sunday' || value === 'monday' ? value : DEFAULT_WEEK_START_DAY
}
