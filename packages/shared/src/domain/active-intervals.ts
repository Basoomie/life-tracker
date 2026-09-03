// §5.6 — When was an item paused?
//
// `Item.deactivatedAt` answers "is it off right now", which is all scheduling needs.
// It cannot answer "was it off on 14 March", and that question is not backfillable —
// so the truth lives in the event log and is derived by replay here, exactly as the
// day-start timeline is (§6.7).
//
// This module is deliberately pure: events in, day ranges out.  No DB, no clock, no
// domain lookups.  The stats layer's paused-day exclusion (design-v2 §9.1.1.b) is
// built on it, and a wrong answer here would silently reshape every window in v2.

import type { TrackerEvent } from '../types/events'

/**
 * A stretch of days on which an item was not scheduled.
 * `start` is the first paused day (inclusive).  `end` is the first day it was
 * scheduled again (EXCLUSIVE), or null when the pause is still open.
 *
 * Half-open on purpose: deactivating and reactivating on the same day yields
 * start === end, an interval containing nothing, which is the honest reading —
 * the item was never actually off for a whole day.
 */
export type PausedInterval = {
  start: string        // YYYY-MM-DD, inclusive
  end: string | null   // YYYY-MM-DD, exclusive; null = still paused
}

// Only these two event types matter, and they are read in recorded order so that a
// correction appended later wins — the ordinary event-sourcing rule (§10.1).
type TransitionType = 'template_deactivated' | 'template_reactivated'

function isTransition(e: TrackerEvent): e is TrackerEvent & { eventType: TransitionType } {
  return e.eventType === 'template_deactivated' || e.eventType === 'template_reactivated'
}

/**
 * §5.6 — Replay an item's deactivation history into its paused intervals.
 *
 * `events` may be the item's whole event stream (everything else is ignored) and need
 * not be sorted — this sorts by recordedAt, with appliesToDay as the tiebreak for the
 * synthetic streams tests build, where several transitions share a timestamp.
 *
 * Redundant transitions are absorbed rather than trusted: a second `deactivated`
 * while already paused does not restart the interval, and a `reactivated` while
 * already active is a no-op.  The log is allowed to be untidy; the derivation is not.
 */
export function pausedIntervalsFromEvents(events: TrackerEvent[]): PausedInterval[] {
  const transitions = events
    .filter(isTransition)
    .slice()
    .sort((a, b) => {
      const t = a.recordedAt.getTime() - b.recordedAt.getTime()
      if (t !== 0) return t
      return (a.appliesToDay ?? '').localeCompare(b.appliesToDay ?? '')
    })

  const intervals: PausedInterval[] = []
  let open: PausedInterval | null = null

  for (const e of transitions) {
    // A transition with no applies-to day cannot be placed on the timeline at all.
    // Skipping it is the only honest option: guessing a day would invent a fact.
    if (e.appliesToDay === null) continue

    if (e.eventType === 'template_deactivated') {
      if (open) continue           // already paused — the first one owns the interval
      open = { start: e.appliesToDay, end: null }
      intervals.push(open)
    } else {
      if (!open) continue          // already active — nothing to close
      open.end = e.appliesToDay
      open = null
    }
  }

  return intervals
}

/**
 * Was `day` (YYYY-MM-DD) inside one of these paused intervals?
 * Half-open: the start day is paused, the end day is not.
 */
export function isDayPaused(day: string, intervals: PausedInterval[]): boolean {
  return intervals.some((i) => day >= i.start && (i.end === null || day < i.end))
}
