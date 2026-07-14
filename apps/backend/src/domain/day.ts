// §6.7 — "What day is it" for the backend: the raw local calendar day, and the
// day-start-bucketed logical day. Business logic (uses the DB + the shared
// bucketing function), so it lives here rather than in routes/helpers.ts,
// which is plumbing only.

import type { Pool } from 'pg'
import { bucketTimestamp } from '@tracker/shared'
import * as repos from '../db/repos/index'
import { findSoleUser } from '../db/repos/users'

/**
 * Returns the current local calendar date as YYYY-MM-DD.
 *
 * "Local" here means the host process's system timezone — see
 * packages/shared/src/domain/day-start.ts, whose bucketTimestamp() uses the same
 * convention. Using UTC would make this disagree with a native <input type="date">
 * (always local) for part of every day, splitting completions/time logs recorded
 * "today" across two different appliesToDay values depending on which UI path
 * produced the date string. Matches the frontend's todayStr() (see
 * apps/frontend/src/lib/date-range.ts).
 */
export function todayLocal(ref: Date = new Date()): string {
  return (
    String(ref.getFullYear()) +
    '-' +
    String(ref.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(ref.getDate()).padStart(2, '0')
  )
}

/**
 * §6.7 — The day-start-bucketed logical day for `now`: the day a timestamp
 * "belongs to" once the user's configured day-start boundary is taken into
 * account (e.g. with a 4:00am day-start, 1:30am belongs to yesterday).
 *
 * Only needs the single day-start entry effective as of `now`'s raw calendar
 * date — bucketLocalDateTime looks up the timeline using that date, never the
 * previous day, so fetching the whole timeline isn't necessary.
 */
export async function logicalToday(
  pool: Pool,
  userId: string,
  now: Date = new Date()
): Promise<string> {
  const rawToday = todayLocal(now)
  const entry = await repos.findEffectiveDayStart(pool, userId, rawToday)
  return bucketTimestamp(now, entry ? [entry] : [])
}

/**
 * For the scheduler, which has no request-scoped userId: resolves the sole
 * user and their day-start-bucketed logical day for `now` in one step.
 * Returns null on a fresh install (no user yet).
 */
export async function resolveLogicalToday(
  pool: Pool,
  now: Date = new Date()
): Promise<{ userId: string; today: string } | null> {
  const user = await findSoleUser(pool)
  if (!user) return null
  return { userId: user.id, today: await logicalToday(pool, user.id, now) }
}
