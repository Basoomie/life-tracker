// §8 — Pure replay of an occurrence's disposition from its event stream.
//
// Split out of dispositions.ts so completion.ts can ask "was this child
// excused?" (needed to keep an excused child out of its parent's derived-%
// denominator, §8.1) without importing dispositions.ts, which imports
// completion.ts for auto-close. dispositions.ts re-exports deriveDisposition,
// so every existing import site is unaffected.

import type { TrackerEvent, OccurrenceDisposition } from '@tracker/shared'

// Event types that determine the occurrence's disposition, in the order
// enrichOccurrence and clearDispositionByUser both need it: "most recent wins."
const DERIVABLE_DISPOSITION_EVENT_TYPES = new Set([
  'item_completed',
  'retroactive_completion',
  'manual_parent_percent_declared',
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
    if (e.eventType === 'manual_parent_percent_declared') {
      // §6.2/§6.3 — a parent occurrence is completed by declaring a %, never by
      // an item_completed event (routes/occurrences.ts). Without this branch a
      // parent the user explicitly ticked would keep reading as 'pending'
      // forever, and v2's Layer 1.5 would score that day as un-dispositioned
      // (data-quality.ts) despite an explicit user action. Below 100 it IS
      // still pending — a declared 60% is a partial, not a close-out.
      const pct = (p.declaredPercent as number) ?? 0
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
