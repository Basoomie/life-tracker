// §9.1 — Session duration computation.
//
// Pure helper: given the event stream for a session and the stopped-at timestamp,
// compute the effective tracked duration in whole minutes.
//
// Algorithm:
//   startedAt = session_started event's recordedAt (the payload only carries sessionId)
//   totalPausedMs = sum of (resumedAt - pausedAt) for each pause/resume pair
//   durationMs = stoppedAt - startedAt - totalPausedMs
//   durationMin = Math.max(0, Math.round(durationMs / 60000))
//
// Trailing pauses (pause without a matching resume) are ignored — the timer was
// stopped while paused; the un-resumed gap is not counted.

import type { Pool } from 'pg'
import type { TrackerEvent } from '@tracker/shared'
import * as repos from '../db/repos/index'

/**
 * §9.1 — Compute the effective tracked duration for a live session.
 *
 * @param events  All events for the session, in chronological order.
 *                Must include the session_started event.
 * @param stoppedAt  The moment the session was stopped (used as the end boundary).
 * @returns  Duration in whole minutes, minimum 0.
 */
export function computeSessionDurationMin(
  events: TrackerEvent[],
  stoppedAt: Date
): number {
  // Find the start anchor: session_started's recorded-at is the real clock start.
  const startEvent = events.find((e) => e.eventType === 'session_started')
  if (!startEvent) return 0

  const startedAt = startEvent.recordedAt

  // Sum paused intervals from pause/resume pairs (in order).
  let totalPausedMs = 0
  let pendingPauseAt: Date | null = null

  for (const e of events) {
    if (e.eventType === 'session_paused') {
      // Payload: { sessionId, pausedAt: ISO string }
      pendingPauseAt = new Date((e.payload as { sessionId: string; pausedAt: string }).pausedAt)
    } else if (e.eventType === 'session_resumed') {
      if (pendingPauseAt !== null) {
        // Payload: { sessionId, resumedAt: ISO string }
        const resumedAt = new Date((e.payload as { sessionId: string; resumedAt: string }).resumedAt)
        totalPausedMs += resumedAt.getTime() - pendingPauseAt.getTime()
        pendingPauseAt = null
      }
    }
  }

  const totalMs = stoppedAt.getTime() - startedAt.getTime() - totalPausedMs
  return Math.max(0, Math.round(totalMs / 60000))
}

const FINALIZING_EVENT_TYPES = new Set(['session_stopped', 'session_created', 'session_edited'])

/**
 * §9.1 — Sum finalized session durations for an occurrence's event stream.
 *
 * Multiple start/stop cycles against the same occurrence are independent
 * sessions (each with its own sessionId) — this is what makes re-starting
 * a timer additive rather than a reset. Per session:
 *   - a session_stopped event finalizes a live session's durationMin
 *   - the latest session_created/session_edited finalizes a manual session
 *     (an edit supersedes the create it corrects — never both)
 *   - a session with no stop/manual-finalize event is still in progress
 *     and contributes nothing here; its live elapsed time is tracked
 *     client-side while running.
 */
export function computeLoggedMinutes(events: TrackerEvent[]): number {
  const bySession = new Map<string, TrackerEvent[]>()
  for (const e of events) {
    if (!FINALIZING_EVENT_TYPES.has(e.eventType)) continue
    const sessionId = (e.payload as { sessionId?: string }).sessionId
    if (!sessionId) continue
    if (!bySession.has(sessionId)) bySession.set(sessionId, [])
    bySession.get(sessionId)!.push(e)
  }

  let totalMin = 0
  for (const sessionEvents of bySession.values()) {
    const stopEvent = sessionEvents.find((e) => e.eventType === 'session_stopped')
    if (stopEvent) {
      totalMin += (stopEvent.payload as { durationMin: number }).durationMin
      continue
    }
    const manualEvents = sessionEvents.filter(
      (e) => e.eventType === 'session_created' || e.eventType === 'session_edited'
    )
    if (manualEvents.length > 0) {
      const latest = manualEvents[manualEvents.length - 1]
      totalMin += (latest.payload as { durationMin: number }).durationMin
    }
  }
  return totalMin
}

/**
 * §9.1 — A parent's logged time rolls up its whole subtree, the same way derived
 * completion % rolls up child completions: an item's total is its own finalized
 * session time plus every descendant's, recursively. Timing a child contributes
 * to the parent's total in addition to anything timed directly on the parent —
 * running a timer at two levels at once is additive, never one overriding the other.
 */
export async function computeSubtreeLoggedMinutes(
  pool: Pool,
  itemId: string,
  day: string,
  userId: string
): Promise<number> {
  const [occ, children] = await Promise.all([
    repos.findOccurrenceByItemAndDay(pool, itemId, day, userId),
    repos.findChildItems(pool, itemId, userId),
  ])

  const own = occ
    ? computeLoggedMinutes(await repos.findEventsByOccurrence(pool, occ.id, userId))
    : 0

  if (children.length === 0) return own

  const childTotals = await Promise.all(
    children.map((c) => computeSubtreeLoggedMinutes(pool, c.id, day, userId))
  )
  return own + childTotals.reduce((sum, m) => sum + m, 0)
}
