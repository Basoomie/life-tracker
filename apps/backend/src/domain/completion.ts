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
  getItemDueSlots,
  deriveLeafCompletion,
  computeDerivedPercent,
  computeNodePercent,
  findDeclaredPercent,
  buildParentCompletionState,
} from '@tracker/shared'
import type { LeafCompletionState, ParentCompletionState, CompletionNode } from '@tracker/shared'
import * as repos from '../db/repos/index'
import { deriveDisposition } from './disposition-state'

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
 * §6.1 / §5.5 — Which of `child`'s slots count on `day`, as the occurrence backing
 * each (null where the occurrence hasn't been materialized yet).
 *
 * Recurring slots answer via getItemDueSlots; a one-time slot — and a row left behind
 * by a removed schedule — is due exactly on the day it has a stored occurrence.
 * An empty result means "not due today", which is what excludes the child from its
 * parent's denominator (§6.1, the Tuesday/MWF case).
 */
async function dueSlotOccurrences(
  pool: Pool,
  child: Item,
  day: string,
  userId: string
): Promise<(Occurrence | null)[]> {
  const [stored, schedules] = await Promise.all([
    repos.findOccurrencesByItemAndDay(pool, child.id, day, userId),
    repos.findSchedulesByItem(pool, child.id, userId),
  ])

  const occByScheduleId = new Map(stored.map((o) => [o.scheduleId, o]))
  const slots: (Occurrence | null)[] = []
  const covered = new Set<string>()

  for (const slot of getItemDueSlots(child, schedules, day, day)) {
    covered.add(slot.scheduleId)
    slots.push(occByScheduleId.get(slot.scheduleId) ?? null)
  }
  for (const occ of stored) {
    if (!covered.has(occ.scheduleId)) slots.push(occ)
  }

  return slots
}

// The same item's children are needed twice while walking the tree (once to know
// whether it's a parent at all, once to recurse into it), so they're fetched once.
async function childrenOf(
  pool: Pool,
  itemId: string,
  userId: string,
  cache: Map<string, Item[]>
): Promise<Item[]> {
  const cached = cache.get(itemId)
  if (cached) return cached
  const children = await repos.findChildItems(pool, itemId, userId)
  cache.set(itemId, children)
  return children
}

/**
 * §6.1 — Build the CompletionNode for every child of `parentItemId` that counts
 * toward its derived % on `day`: due, and not excused.
 *
 * Recurses through the containment tree (nested arbitrarily deep, §5), because a
 * child that is itself a parent has no item_completed event of its own — reading
 * it as a leaf would score a 6-of-7 sub-routine as 0. computeNodePercent applies
 * the actual rule; this function only gathers the facts (due-ness, event replay).
 *
 * `seen` guards against a malformed parent_id cycle turning this into an
 * infinite recursion; the containment tree should never contain one.
 */
async function buildDueChildNodes(
  pool: Pool,
  parentItemId: string,
  userId: string,
  day: string,
  seen: Set<string>,
  cache: Map<string, Item[]>
): Promise<CompletionNode[]> {
  if (seen.has(parentItemId)) return []
  seen.add(parentItemId)

  const children = await childrenOf(pool, parentItemId, userId, cache)
  const nodes: CompletionNode[] = []

  for (const child of children) {
    const slotOccs = await dueSlotOccurrences(pool, child, day, userId)
    if (slotOccs.length === 0) continue   // not due today

    const grandChildren = await childrenOf(pool, child.id, userId, cache)

    const slotNodes: CompletionNode[] = []
    for (const childOcc of slotOccs) {
      // An unmaterialized occurrence has no events: untouched, so 0% and no
      // disposition — but a sub-routine can still score above 0 off its own
      // children, which is why the recursion below is not gated on childOcc.
      const childEvents = childOcc
        ? await repos.findEventsByOccurrence(pool, childOcc.id, userId)
        : []

      // §8.1 — an excused slot is out of the denominator entirely, not a zero.
      if (deriveDisposition(childEvents).type === 'excused') continue

      slotNodes.push({
        isParent: grandChildren.length > 0,
        leafPercent: deriveLeafCompletion(childEvents).completionPercent,
        declaredPercent: findDeclaredPercent(childEvents),
        dueChildren: grandChildren.length > 0
          ? await buildDueChildNodes(pool, child.id, userId, day, seen, cache)
          : [],
      })
    }

    // Every slot excused → the child leaves the parent's denominator entirely,
    // exactly as a single excused child always has (§8.1).
    if (slotNodes.length === 0) continue

    // §5.5 — a child due in several slots today contributes the MEAN of them, so it
    // weighs the same as any other child instead of counting once per slot.
    //
    // Expressed as an aggregating node over its slots rather than a leaf carrying a
    // pre-computed mean: computeNodePercent binarizes a leaf (>=100 ? 100 : 0), which
    // would crush a 50% two-slot day to 0. Aggregation is exactly what the parent
    // branch already does, so this reuses the rule instead of restating it.
    // (An item with children carries at most one slot, so this is leaf-children only.)
    nodes.push(
      slotNodes.length === 1
        ? slotNodes[0]
        : { isParent: true, leafPercent: 0, declaredPercent: null, dueChildren: slotNodes }
    )
  }

  return nodes
}

/**
 * §6.1 — Derive completion state for a parent occurrence on a given day.
 *
 * Derived %: the mean of its due children's own completion values (§6.1 partial
 * credit — a child sub-routine at 86% contributes 86). Not-due children are
 * invisible and excluded from the denominator; so are excused ones (§8.1).
 * 0 due children → 100% (vacuous: parent complete on days no children are scheduled).
 *
 * Declared %: from manual_parent_percent_declared events; coexists with derived %
 * on THIS occurrence (§6.2 — v1 must not collapse them). Note the asymmetry with
 * computeNodePercent, which does collapse them for a *nested* parent: there, the
 * child's single value is what its parent is owed (§6.3).
 */
export async function getParentCompletionState(
  pool: Pool,
  parentOccurrence: Occurrence,
  userId: string,
  day: string   // YYYY-MM-DD — the logical day we're computing for
): Promise<ParentCompletionState> {
  const [dueChildNodes, parentEvents] = await Promise.all([
    buildDueChildNodes(pool, parentOccurrence.itemId, userId, day, new Set<string>(), new Map()),
    repos.findEventsByOccurrence(pool, parentOccurrence.id, userId),
  ])

  const derivedPercent = computeDerivedPercent(dueChildNodes.map(computeNodePercent))
  return buildParentCompletionState(derivedPercent, parentEvents)
}
