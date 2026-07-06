// §8 — End-of-day disposition handling.
//
// Runs after topUpMaterialization (phase a) as the second phase of runBackgroundJob.
// For each occurrence that was due on `day` but untouched (no completion or disposition
// events), applies its configured policy:
//
//   skip          → fires skipped event
//   excuse        → fires excused event (user configured this policy ahead of time)
//   auto_close    → fires auto_closed event at whatever the derived child % was
//   require_manual → no event; left for the user
//
// §4.2 note: blocked-past-due takes normal disposition — NOT auto-excused.
// §8.2 carry-forward: explicit human action only; see carryForward().

import type { Pool } from 'pg'
import type { Occurrence, TrackerEvent } from '@tracker/shared'
import * as repos from '../db/repos/index'
import { getParentCompletionState } from './completion'

// ── "Untouched" detection ─────────────────────────────────────────────────────

// Event types that count as "the occurrence was explicitly closed out."
// child_completed / child_unchecked are history notifications on the parent,
// NOT explicit completions of the parent itself, so they do not prevent auto-close/skip.
const DISPOSITION_EVENT_TYPES = new Set([
  'item_completed',
  'retroactive_completion',
  'manual_parent_percent_declared',
  'skipped',
  'excused',
  'rescheduled',
  'auto_closed',
])

/**
 * Returns true if the occurrence has been touched by any completion or disposition event.
 */
async function isOccurrenceTouched(
  pool: Pool,
  occurrence: Occurrence,
  userId: string
): Promise<boolean> {
  const events = await repos.findEventsByOccurrence(pool, occurrence.id, userId)
  return events.some((e) => DISPOSITION_EVENT_TYPES.has(e.eventType))
}

// ── Per-policy actions ────────────────────────────────────────────────────────

async function applySkip(
  pool: Pool,
  occurrence: Occurrence,
  userId: string,
  opts: { reasonId?: string | null; comment?: string | null } = {}
): Promise<TrackerEvent> {
  return repos.insertEvent(pool, {
    userId,
    eventType: 'skipped',
    occurrenceId: occurrence.id,
    itemId: occurrence.itemId,
    appliesToDay: occurrence.appliesToDay,
    payload: { reasonId: opts.reasonId ?? null, comment: opts.comment ?? null },
  })
}

async function applyExcuse(
  pool: Pool,
  occurrence: Occurrence,
  userId: string,
  opts: { reasonId?: string | null; comment?: string | null } = {}
): Promise<TrackerEvent> {
  return repos.insertEvent(pool, {
    userId,
    eventType: 'excused',
    occurrenceId: occurrence.id,
    itemId: occurrence.itemId,
    appliesToDay: occurrence.appliesToDay,
    payload: { reasonId: opts.reasonId ?? null, comment: opts.comment ?? null },
  })
}

async function applyAutoClose(
  pool: Pool,
  occurrence: Occurrence,
  userId: string
): Promise<TrackerEvent> {
  // Compute derived % at time of auto-close (§8.1: "at whatever the derived child % was")
  const state = await getParentCompletionState(pool, occurrence, userId, occurrence.appliesToDay)
  return repos.insertEvent(pool, {
    userId,
    eventType: 'auto_closed',
    occurrenceId: occurrence.id,
    itemId: occurrence.itemId,
    appliesToDay: occurrence.appliesToDay,
    payload: { derivedPercent: state.derivedPercent },
  })
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * §8 / §8.4 — Apply end-of-day disposition to a single occurrence.
 * Called only for occurrences that are due on `day` but untouched.
 * Exported for targeted testing; normally called by runDispositions.
 */
export async function applyDisposition(
  pool: Pool,
  occurrence: Occurrence,
  userId: string,
  opts: { reasonId?: string | null; comment?: string | null } = {}
): Promise<TrackerEvent | null> {
  const policy = occurrence.snapshot.dispositionPolicy

  switch (policy) {
    case 'skip':
      return applySkip(pool, occurrence, userId, opts)
    case 'excuse':
      return applyExcuse(pool, occurrence, userId, opts)
    case 'auto_close':
      return applyAutoClose(pool, occurrence, userId)
    case 'require_manual':
      return null  // no automatic action; left for the user
  }
}

/**
 * §8.4 — Background job phase (b): end-of-day dispositions.
 * Processes all occurrences for `day` that are untouched.
 * Uses the day-start timeline (via the caller) to know which day to close out;
 * this function just operates on the materialized rows for `day`.
 *
 * §4.2: blocked items (prerequisite not complete) are NOT auto-excused — they take
 * their normal configured policy.
 */
export async function runDispositions(
  pool: Pool,
  userId: string,
  day: string   // YYYY-MM-DD — the logical day being closed out
): Promise<void> {
  const occurrences = await repos.findOccurrencesByDay(pool, userId, day)

  for (const occ of occurrences) {
    const touched = await isOccurrenceTouched(pool, occ, userId)
    if (!touched) {
      await applyDisposition(pool, occ, userId)
    }
  }
}

// ── §8.2 Explicit carry-forward ───────────────────────────────────────────────

/**
 * §8.2 — Carry forward an incomplete occurrence to a new day.
 *
 * Creates a NEW occurrence on targetDay (materializing it now) and records a
 * rescheduled event on the ORIGINAL occurrence. The original occurrence is NEVER
 * erased — it remains with its rescheduled event so the history reads honestly:
 * "scheduled → not done → rescheduled → (later) completed."
 *
 * This is an explicit logged action, NOT automatic rollover (§8.2).
 */
export async function carryForward(
  pool: Pool,
  occurrence: Occurrence,
  targetDay: string,   // YYYY-MM-DD — the new day
  userId: string,
  opts: { reasonId?: string | null; comment?: string | null } = {}
): Promise<{ newOccurrence: Occurrence; rescheduleEvent: TrackerEvent }> {
  // Materialize a new occurrence on the target day with the same item
  const newOccurrence = await repos.insertOccurrence(pool, {
    userId,
    itemId: occurrence.itemId,
    appliesToDay: targetDay,
    snapshot: occurrence.snapshot,
  })

  // Record rescheduled on the ORIGINAL occurrence (never erased)
  const rescheduleEvent = await repos.insertEvent(pool, {
    userId,
    eventType: 'rescheduled',
    occurrenceId: occurrence.id,
    itemId: occurrence.itemId,
    appliesToDay: occurrence.appliesToDay,
    payload: {
      newDay: targetDay,
      newOccurrenceId: newOccurrence.id,
      reasonId: opts.reasonId ?? null,
      comment: opts.comment ?? null,
    },
  })

  return { newOccurrence, rescheduleEvent }
}
