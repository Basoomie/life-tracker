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
import type { Occurrence, TrackerEvent, OccurrenceDisposition } from '@tracker/shared'
import * as repos from '../db/repos/index'
import { getParentCompletionState } from './completion'

// ── Deriving disposition from history ─────────────────────────────────────────

// Event types that determine the occurrence's disposition, in the order
// enrichOccurrence and clearDispositionByUser both need it: "most recent wins."
const DERIVABLE_DISPOSITION_EVENT_TYPES = new Set([
  'item_completed',
  'retroactive_completion',
  'skipped',
  'excused',
  'rescheduled',
  'auto_closed',
  'disposition_cleared',
])

const PENDING_DISPOSITION: OccurrenceDisposition = {
  type: 'pending',
  reasonId: null,
  comment: null,
  rescheduledToDay: null,
  derivedPercentAtClose: null,
}

/**
 * Pure replay: given an occurrence's full event history, derive its current
 * disposition from the most recent disposition-type event. A `disposition_cleared`
 * event (§ user-initiated undo) resets to 'pending' without deleting the event
 * it's undoing — history stays intact, only the derived *current* state changes.
 *
 * Shared by enrichOccurrence (API responses) and clearDispositionByUser (which
 * needs to know the current type before allowing an undo).
 */
export function deriveDisposition(events: TrackerEvent[]): OccurrenceDisposition {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (!DERIVABLE_DISPOSITION_EVENT_TYPES.has(e.eventType)) continue

    const p = e.payload as Record<string, unknown>

    if (e.eventType === 'item_completed' || e.eventType === 'retroactive_completion') {
      const pct = (p.completionPercent as number) ?? 0
      return {
        type: pct >= 100 ? 'completed' : 'pending',
        reasonId: null,
        comment: null,
        rescheduledToDay: null,
        derivedPercentAtClose: null,
      }
    }
    if (e.eventType === 'skipped') {
      return {
        type: 'skipped',
        reasonId: (p.reasonId as string | null) ?? null,
        comment: (p.comment as string | null) ?? null,
        rescheduledToDay: null,
        derivedPercentAtClose: null,
      }
    }
    if (e.eventType === 'excused') {
      return {
        type: 'excused',
        reasonId: (p.reasonId as string | null) ?? null,
        comment: (p.comment as string | null) ?? null,
        rescheduledToDay: null,
        derivedPercentAtClose: null,
      }
    }
    if (e.eventType === 'rescheduled') {
      return {
        type: 'rescheduled',
        reasonId: (p.reasonId as string | null) ?? null,
        comment: (p.comment as string | null) ?? null,
        rescheduledToDay: (p.newDay as string | null) ?? null,
        derivedPercentAtClose: null,
      }
    }
    if (e.eventType === 'auto_closed') {
      return {
        type: 'auto_closed',
        reasonId: null,
        comment: null,
        rescheduledToDay: null,
        derivedPercentAtClose: (p.derivedPercent as number | null) ?? null,
      }
    }
    // disposition_cleared: falls through to the PENDING_DISPOSITION return below.
    return { ...PENDING_DISPOSITION }
  }
  return { ...PENDING_DISPOSITION }
}

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

// ── User-initiated skip / excuse ──────────────────────────────────────────────

/**
 * §8 — User-initiated skip (explicit action from the UI or API).
 * Unlike applyDisposition (background-job path), this is always a skip regardless
 * of the item's configured disposition policy.
 */
export async function skipOccurrenceByUser(
  pool: Pool,
  occurrence: Occurrence,
  userId: string,
  opts: { reasonId?: string | null; comment?: string | null } = {}
): Promise<TrackerEvent> {
  return applySkip(pool, occurrence, userId, opts)
}

/**
 * §8 — User-initiated excuse (explicit action from the UI or API).
 * Always an excuse regardless of the item's configured disposition policy.
 */
export async function excuseOccurrenceByUser(
  pool: Pool,
  occurrence: Occurrence,
  userId: string,
  opts: { reasonId?: string | null; comment?: string | null } = {}
): Promise<TrackerEvent> {
  return applyExcuse(pool, occurrence, userId, opts)
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

// ── User-initiated undo (remove skip / excuse / carry-forward status) ────────

/**
 * User-initiated undo of a skip/excuse/carry-forward disposition.
 *
 * Not part of the original spec's §8 disposition policies — added on direct user
 * request so a mis-clicked skip/excuse/carry-forward can be reversed. Consistent
 * with the "never silently mutate" and "events are immutable" rules: this does
 * NOT delete or edit the skipped/excused/rescheduled event, it appends a new
 * disposition_cleared event that deriveDisposition() reads as "pending again."
 *
 * Carry-forward specifically: clearing only un-dispositions the ORIGINAL
 * occurrence. The new occurrence already materialized on the target day by
 * carryForward() is untouched — both are left as independently actionable
 * occurrences rather than deleting the copy, since deleting a materialized
 * occurrence (and whatever events it may have gathered since) is not a thing
 * this system does anywhere else.
 *
 * Only valid from skipped/excused/rescheduled — pending/completed/auto_closed
 * have no "undo" via this path (completed already has uncomplete*; auto_closed
 * is a system action, not a user one).
 */
export async function clearDispositionByUser(
  pool: Pool,
  occurrence: Occurrence,
  userId: string
): Promise<{ ok: true; event: TrackerEvent } | { ok: false; error: string }> {
  const events = await repos.findEventsByOccurrence(pool, occurrence.id, userId)
  const current = deriveDisposition(events)

  if (current.type !== 'skipped' && current.type !== 'excused' && current.type !== 'rescheduled') {
    return { ok: false, error: `Cannot clear a disposition of type '${current.type}'` }
  }

  const event = await repos.insertEvent(pool, {
    userId,
    eventType: 'disposition_cleared',
    occurrenceId: occurrence.id,
    itemId: occurrence.itemId,
    appliesToDay: occurrence.appliesToDay,
    payload: { previousDispositionType: current.type },
  })

  return { ok: true, event }
}
