// §6.1–6.4 — DB-backed completion operations.
//
// All state changes are expressed as appended events — nothing is mutated in place.
// State is derived by replaying events via the pure functions in @tracker/shared.
//
// Leaf flow:   completeLeaf / uncompleteLeaf → item_completed (0 or 100%)
// Retroactive: completeRetroactive → retroactive_completion (applies-to is a past day)
// Child flow:  completeChild / uncompleteChild → fires on both child and parent occurrences
// Parent declared %: declareParentPercent → manual_parent_percent_declared
// Read path:  getLeafCompletionState / getParentCompletionState → derives from events

import type { Pool } from 'pg'
import type { Item, Occurrence, TrackerEvent } from '@tracker/shared'
import {
  getDueDays,
  itemAnchorDate,
  deriveLeafCompletion,
  computeDerivedPercent,
  buildParentCompletionState,
} from '@tracker/shared'
import type { LeafCompletionState, ParentCompletionState } from '@tracker/shared'
import * as repos from '../db/repos/index'

// ── Leaf completion ───────────────────────────────────────────────────────────

/**
 * §6.1 — Complete a leaf occurrence.
 * Fires item_completed with completionPercent: 100.
 * The occurrence's appliesToDay is used as the event's appliesToDay.
 */
export async function completeLeaf(
  pool: Pool,
  occurrence: Occurrence,
  userId: string
): Promise<TrackerEvent> {
  return repos.insertEvent(pool, {
    userId,
    eventType: 'item_completed',
    occurrenceId: occurrence.id,
    itemId: occurrence.itemId,
    appliesToDay: occurrence.appliesToDay,
    payload: { completionPercent: 100, completionKind: 'declared' },
  })
}

/**
 * §6.1 — Uncomplete a leaf occurrence (set it back to 0%).
 * Fires item_completed with completionPercent: 0.
 * The "unchecked" state is the latest event winning at 0%.
 */
export async function uncompleteLeaf(
  pool: Pool,
  occurrence: Occurrence,
  userId: string
): Promise<TrackerEvent> {
  return repos.insertEvent(pool, {
    userId,
    eventType: 'item_completed',
    occurrenceId: occurrence.id,
    itemId: occurrence.itemId,
    appliesToDay: occurrence.appliesToDay,
    payload: { completionPercent: 0, completionKind: 'declared' },
  })
}

/**
 * §6.4 — Complete a leaf occurrence retroactively (applies-to is a past day).
 * Fires retroactive_completion; recorded-at is passed explicitly so tests are
 * deterministic and the gap (recorded-at − applies-to) is always preserved.
 * Backfill is never blocked — only soft-flagged by the event type.
 */
export async function completeRetroactive(
  pool: Pool,
  occurrence: Occurrence,
  userId: string,
  recordedAt: Date = new Date()
): Promise<TrackerEvent> {
  return repos.insertEvent(pool, {
    userId,
    eventType: 'retroactive_completion',
    occurrenceId: occurrence.id,
    itemId: occurrence.itemId,
    appliesToDay: occurrence.appliesToDay,
    recordedAt,
    payload: { completionPercent: 100, completionKind: 'declared' },
  })
}

// ── Child completion ──────────────────────────────────────────────────────────

/**
 * §6.1 — Complete a child occurrence.
 * Fires item_completed on the child + child_completed on the parent (for parent history).
 */
export async function completeChild(
  pool: Pool,
  childOccurrence: Occurrence,
  parentOccurrence: Occurrence,
  userId: string
): Promise<void> {
  await repos.insertEvent(pool, {
    userId,
    eventType: 'item_completed',
    occurrenceId: childOccurrence.id,
    itemId: childOccurrence.itemId,
    appliesToDay: childOccurrence.appliesToDay,
    payload: { completionPercent: 100, completionKind: 'declared' },
  })
  await repos.insertEvent(pool, {
    userId,
    eventType: 'child_completed',
    occurrenceId: parentOccurrence.id,
    itemId: parentOccurrence.itemId,
    appliesToDay: parentOccurrence.appliesToDay,
    payload: { childItemId: childOccurrence.itemId, childOccurrenceId: childOccurrence.id },
  })
}

/**
 * §6.1 — Uncomplete a child occurrence (lower the parent's derived %).
 * Fires item_completed at 0% on the child + child_unchecked on the parent.
 */
export async function uncompleteChild(
  pool: Pool,
  childOccurrence: Occurrence,
  parentOccurrence: Occurrence,
  userId: string
): Promise<void> {
  await repos.insertEvent(pool, {
    userId,
    eventType: 'item_completed',
    occurrenceId: childOccurrence.id,
    itemId: childOccurrence.itemId,
    appliesToDay: childOccurrence.appliesToDay,
    payload: { completionPercent: 0, completionKind: 'declared' },
  })
  await repos.insertEvent(pool, {
    userId,
    eventType: 'child_unchecked',
    occurrenceId: parentOccurrence.id,
    itemId: parentOccurrence.itemId,
    appliesToDay: parentOccurrence.appliesToDay,
    payload: { childItemId: childOccurrence.itemId, childOccurrenceId: childOccurrence.id },
  })
}

// ── Parent declared % ─────────────────────────────────────────────────────────

/**
 * §6.2 / §6.3 — Declare a manual % on a parent occurrence (the exception path).
 * Fires manual_parent_percent_declared; the declared % coexists with the derived %.
 */
export async function declareParentPercent(
  pool: Pool,
  occurrence: Occurrence,
  userId: string,
  percent: number
): Promise<TrackerEvent> {
  return repos.insertEvent(pool, {
    userId,
    eventType: 'manual_parent_percent_declared',
    occurrenceId: occurrence.id,
    itemId: occurrence.itemId,
    appliesToDay: occurrence.appliesToDay,
    payload: { declaredPercent: percent },
  })
}

// ── State derivation ──────────────────────────────────────────────────────────

/**
 * Derive completion state for a leaf occurrence by replaying its event stream.
 */
export async function getLeafCompletionState(
  pool: Pool,
  occurrence: Occurrence,
  userId: string
): Promise<LeafCompletionState> {
  const events = await repos.findEventsByOccurrence(pool, occurrence.id, userId)
  return deriveLeafCompletion(events)
}

/**
 * §6.1 — Derive completion state for a parent occurrence on a given day.
 *
 * Derived %: for each child item, check if it was due on `day` using getDueDays (2a).
 * Children not due that day are excluded from the denominator.
 * 0 due children → 100% (vacuous: parent complete on days no children are scheduled).
 *
 * Declared %: from manual_parent_percent_declared events; coexists with derived %.
 */
export async function getParentCompletionState(
  pool: Pool,
  parentOccurrence: Occurrence,
  userId: string,
  day: string   // YYYY-MM-DD — the logical day we're computing for
): Promise<ParentCompletionState> {
  const [children, parentEvents] = await Promise.all([
    repos.findChildItems(pool, parentOccurrence.itemId, userId),
    repos.findEventsByOccurrence(pool, parentOccurrence.id, userId),
  ])

  // Find which children are due on `day` using 2a's getDueDays
  const dueChildrenIds: string[] = []
  for (const child of children) {
    if (!child.recurrenceRule) {
      // One-time task child: due only if it has a stored occurrence on that day
      const occ = await repos.findOccurrenceByItemAndDay(pool, child.id, day, userId)
      if (occ) dueChildrenIds.push(child.id)
    } else {
      const dueDays = getDueDays(child.recurrenceRule, day, day, itemAnchorDate(child))
      if (dueDays.length > 0) dueChildrenIds.push(child.id)
    }
  }

  // Count how many due children have been completed on `day`
  let completedCount = 0
  if (dueChildrenIds.length > 0) {
    const childOccs = await repos.findOccurrencesByItemsAndDay(pool, dueChildrenIds, day, userId)
    const occByItemId = new Map(childOccs.map((o) => [o.itemId, o]))

    for (const childId of dueChildrenIds) {
      const childOcc = occByItemId.get(childId)
      if (!childOcc) continue  // not yet materialized → untouched → not completed
      const childEvents = await repos.findEventsByOccurrence(pool, childOcc.id, userId)
      const state = deriveLeafCompletion(childEvents)
      if (state.completionPercent >= 100) completedCount++
    }
  }

  const derivedPercent = computeDerivedPercent(dueChildrenIds.length, completedCount)
  return buildParentCompletionState(derivedPercent, parentEvents)
}
