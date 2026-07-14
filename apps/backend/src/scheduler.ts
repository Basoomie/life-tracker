// §8.4 / v2 §9.3 — In-process daily scheduler.
//
// admin.ts's /admin/background-job and /admin/generate-reviews were built to be
// invoked by "a production cron" that was never actually wired up anywhere (no
// cron entry in docker-compose.yml, no scheduler in this process). Without it, an
// item's materialized-occurrence horizon only advances when the user directly
// touches that item (create/edit/complete/etc) — everything else silently ages
// past its horizon and falls back to computed-only occurrences (id: null), which
// the frontend then can't attach a timer or a disposition action to (see
// OccurrenceRow.tsx). This is that missing cron, running in-process so the fix
// applies identically in dev and in the single-container NAS deploy with no
// external setup.
//
// Polls hourly rather than firing a precise midnight timer — cheap, simple, and
// correct: every tick just checks "has the calendar day advanced since we last
// ran?" and no-ops otherwise. topUpMaterialization/runDispositions/
// runScheduledReviews are all idempotent for a given day (see their own doc
// comments), so re-checking hourly costs nothing on the days it's a no-op.

import type { Pool } from 'pg'
import { runBackgroundJob } from './domain/materialization'
import { runScheduledReviews } from './review/generate'
import { findSoleUser } from './db/repos/users'
import { resolveLogicalToday } from './domain/day'

const POLL_INTERVAL_MS = 60 * 60 * 1000

// Subtract one calendar day from a YYYY-MM-DD string using UTC to avoid DST distortion.
export function previousDay(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d - 1))
  return (
    String(dt.getUTCFullYear()) +
    '-' +
    String(dt.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(dt.getUTCDate()).padStart(2, '0')
  )
}

/**
 * Pure gating logic, split out from runDailyTick so the "once per calendar day,
 * and it's always the PRIOR day that gets closed out — never the in-progress
 * one" rule is unit-testable without a database.
 *
 * runBackgroundJob's `day` is "the logical day being closed out" (admin.ts) —
 * dispositions (skip/excuse/auto-close) fire for occurrences due on that day.
 * Passing today's date would auto-close out today's still-in-progress tasks,
 * which is exactly the silent-mutation the spec forbids. So when the calendar
 * day advances, the day to close out is always the one that just fully elapsed.
 */
export function planDailyTick(
  today: string,
  lastRunDay: string | null
): { closeOutDay: string } | null {
  if (today === lastRunDay) return null
  return { closeOutDay: previousDay(today) }
}

/**
 * Runs the plan (if any) for `today` given the last day the job successfully
 * ran. Returns the new lastRunDay to store (unchanged if nothing ran, or if
 * the background job failed — a failure must not be swallowed for a whole day;
 * the next hourly poll should retry).
 */
export async function runDailyTick(
  pool: Pool,
  today: string,
  lastRunDay: string | null
): Promise<string | null> {
  const plan = planDailyTick(today, lastRunDay)
  if (!plan) return lastRunDay

  const user = await findSoleUser(pool)
  if (!user) return lastRunDay  // fresh install — bootstrap hasn't created the user yet

  // Phase (a)+(b): top up the materialization horizon and close out yesterday's
  // untouched occurrences. Left uncaught deliberately: if this throws, lastRunDay
  // is not advanced, so the next hourly poll retries instead of silently giving
  // up on materialization for the rest of the day.
  await runBackgroundJob(pool, user.id, plan.closeOutDay)

  // Review generation (v2 §9.3) is a separate concern — a missing/misconfigured
  // LLM config must never block materialization/dispositions, so its failure is
  // isolated here rather than reverting lastRunDay.
  try {
    await runScheduledReviews(pool, user.id, today)
  } catch (err) {
    console.error('[scheduler] review generation failed', err)
  }

  return today
}

export function startScheduler(pool: Pool): void {
  let lastRunDay: string | null = null

  async function tick() {
    try {
      // §6.7 — bucket "now" through the user's day-start timeline before deciding
      // whether the logical day has advanced; a raw calendar-day rollover isn't
      // enough (see resolveLogicalToday). Resolved here, not inside runDailyTick,
      // because computing it needs the DB (day-start timeline lookup) — findSoleUser
      // runs a second time inside runDailyTick too, which is a deliberately accepted
      // duplication to keep that function's existing signature and tests untouched.
      const resolved = await resolveLogicalToday(pool)
      if (!resolved) return  // fresh install — bootstrap hasn't created the user yet
      lastRunDay = await runDailyTick(pool, resolved.today, lastRunDay)
    } catch (err) {
      console.error('[scheduler] daily tick failed', err)
    }
  }

  void tick()
  setInterval(tick, POLL_INTERVAL_MS)
}
