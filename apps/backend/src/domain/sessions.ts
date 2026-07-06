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

import type { TrackerEvent } from '@tracker/shared'

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
