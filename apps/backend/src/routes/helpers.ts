// Shared utilities for route handlers.
// All business logic lives in domain functions; these are plumbing only.

import type { FastifyReply } from 'fastify'
import type { Pool } from 'pg'
import type { ComputedOccurrence, Occurrence } from '@tracker/shared'
import type {
  OccurrenceCompletionState,
  OccurrenceDisposition,
  OccurrenceWithState,
} from '@tracker/shared'
import * as repos from '../db/repos/index'
import { isBlocked, getIncompletePrerequisites } from '../domain/prerequisites'
import { getLeafCompletionState, getParentCompletionState } from '../domain/completion'
import { computeLoggedMinutes, computeSubtreeLoggedMinutes } from '../domain/sessions'

// ── HTTP helpers ──────────────────────────────────────────────────────────────

export function notFound(reply: FastifyReply, resource = 'resource') {
  return reply.status(404).send({ error: 'not_found', message: `${resource} not found` })
}

export function badRequest(reply: FastifyReply, error: string, message: string) {
  return reply.status(400).send({ error, message })
}

// ── Date helper ───────────────────────────────────────────────────────────────

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
export function todayLocal(): string {
  const d = new Date()
  return (
    String(d.getFullYear()) +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  )
}

// ── Occurrence enrichment ─────────────────────────────────────────────────────

// Event types that determine the occurrence's disposition.
// Ordered by precedence for the "most recent wins" logic below.
const DISPOSITION_EVENT_TYPES = new Set([
  'item_completed',
  'retroactive_completion',
  'skipped',
  'excused',
  'rescheduled',
  'auto_closed',
])

/**
 * §5.4 — Enrich a ComputedOccurrence with derived state for API consumers.
 *
 * - isBlocked / incompletePrerequisiteIds: derived from prerequisite graph (§4.2).
 * - completionState: derived by replaying events; trivial for unmaterialized (id=null).
 * - disposition: from the most recent disposition-type event.
 * - hasChildren: whether any active child items exist in the containment tree.
 *
 * Every repo call is scoped by userId (§13.4).
 */
export async function enrichOccurrence(
  pool: Pool,
  occ: ComputedOccurrence,
  userId: string
): Promise<OccurrenceWithState> {
  // Blocked status + children can be resolved without a stored occurrence.
  const [blocked, incompletePrereqIds, children, sortOrder] = await Promise.all([
    isBlocked(pool, occ.itemId, userId),
    getIncompletePrerequisites(pool, occ.itemId, userId),
    repos.findChildItems(pool, occ.itemId, userId),
    repos.findItemSortOrder(pool, occ.itemId, userId),
  ])

  const hasChildren = children.length > 0

  // ── Completion state ──────────────────────────────────────────────────────

  let completionState: OccurrenceCompletionState

  if (!occ.id) {
    // Computed (not yet materialized) → trivially not complete; no events exist.
    completionState = {
      isLeaf: !hasChildren,
      completionPercent: 0,
      isComplete: false,
      completedAt: null,
      wasRetroactive: false,
      derivedPercent: hasChildren ? 0 : null,
      declaredPercent: null,
    }
  } else {
    // Build a full Occurrence to pass to the domain functions (id is non-null here).
    const storedOcc: Occurrence = {
      id: occ.id,
      userId: occ.userId,
      itemId: occ.itemId,
      appliesToDay: occ.appliesToDay,
      snapshot: occ.snapshot,
      materializedAt: occ.materializedAt!,
    }

    if (!hasChildren) {
      // Leaf occurrence: binary 0%/100% from item_completed events.
      const state = await getLeafCompletionState(pool, storedOcc, userId)
      completionState = {
        isLeaf: true,
        completionPercent: state.completionPercent,
        isComplete: state.completionPercent >= 100,
        completedAt: state.completedAt,
        wasRetroactive: state.wasRetroactive,
        derivedPercent: null,
        declaredPercent: null,
      }
    } else {
      // Parent occurrence: derived % from due children + optional declared %.
      const state = await getParentCompletionState(pool, storedOcc, userId, occ.appliesToDay)
      completionState = {
        isLeaf: false,
        completionPercent: state.displayPercent,
        isComplete: state.isComplete,
        completedAt: null,
        wasRetroactive: false,
        derivedPercent: state.derivedPercent,
        declaredPercent: state.declaredPercent,
      }
    }
  }

  // ── Disposition ───────────────────────────────────────────────────────────

  let disposition: OccurrenceDisposition = {
    type: 'pending',
    reasonId: null,
    comment: null,
    rescheduledToDay: null,
    derivedPercentAtClose: null,
  }

  // §9.1 — total finalized session time logged against this occurrence itself.
  // An unmaterialized occurrence (id=null) has no event stream, so no sessions.
  let loggedMinutes = 0

  if (occ.id) {
    const events = await repos.findEventsByOccurrence(pool, occ.id, userId)
    loggedMinutes = computeLoggedMinutes(events)
    // Walk in reverse to find the most recent disposition event.
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (!DISPOSITION_EVENT_TYPES.has(e.eventType)) continue

      const p = e.payload as Record<string, unknown>

      if (e.eventType === 'item_completed' || e.eventType === 'retroactive_completion') {
        const pct = (p.completionPercent as number) ?? 0
        disposition = {
          type: pct >= 100 ? 'completed' : 'pending',
          reasonId: null,
          comment: null,
          rescheduledToDay: null,
          derivedPercentAtClose: null,
        }
      } else if (e.eventType === 'skipped') {
        disposition = {
          type: 'skipped',
          reasonId: (p.reasonId as string | null) ?? null,
          comment: (p.comment as string | null) ?? null,
          rescheduledToDay: null,
          derivedPercentAtClose: null,
        }
      } else if (e.eventType === 'excused') {
        disposition = {
          type: 'excused',
          reasonId: (p.reasonId as string | null) ?? null,
          comment: (p.comment as string | null) ?? null,
          rescheduledToDay: null,
          derivedPercentAtClose: null,
        }
      } else if (e.eventType === 'rescheduled') {
        disposition = {
          type: 'rescheduled',
          reasonId: (p.reasonId as string | null) ?? null,
          comment: (p.comment as string | null) ?? null,
          rescheduledToDay: (p.newDay as string | null) ?? null,
          derivedPercentAtClose: null,
        }
      } else if (e.eventType === 'auto_closed') {
        disposition = {
          type: 'auto_closed',
          reasonId: null,
          comment: null,
          rescheduledToDay: null,
          derivedPercentAtClose: (p.derivedPercent as number | null) ?? null,
        }
      }
      break  // most recent disposition event wins
    }
  }

  // §9.1 — a parent's logged time rolls up its whole subtree, the same way
  // derived completion % rolls up child completions: timing a child adds to the
  // parent's total on top of anything timed directly on the parent.
  if (hasChildren) {
    const childTotals = await Promise.all(
      children.map((c) => computeSubtreeLoggedMinutes(pool, c.id, occ.appliesToDay, userId))
    )
    loggedMinutes += childTotals.reduce((sum, m) => sum + m, 0)
  }

  return {
    ...occ,
    isBlocked: blocked,
    incompletePrerequisiteIds: incompletePrereqIds,
    completionState,
    disposition,
    hasChildren,
    sortOrder,
    loggedMinutes,
  }
}
