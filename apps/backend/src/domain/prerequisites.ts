// §4.2 — Prerequisite management: cycle detection, isBlocked, add/remove edges.
//
// Key rules from §4.2:
//   - Task-to-task only. Recurring habits cannot appear on either end.
//   - "Blocked" is derived (from completion events), never stored.
//   - Cycles rejected at creation: DFS from proposedPrereqId; if itemId is reachable, reject.
//   - Blocked items remain schedulable and visible; excluded from actionable-now only.
//   - Blocked-past-due takes normal disposition (§8) — not auto-excused.

import type { Pool } from 'pg'
import type { Item, ItemPrerequisite, TrackerEvent } from '@tracker/shared'
import * as repos from '../db/repos/index'

// ── Guard helpers ─────────────────────────────────────────────────────────────

/**
 * §4.2 — Habits (items with recurrenceRule) cannot participate in prerequisites.
 * Returns an error string if the item is a habit; null if it's a task.
 */
export function validateNotHabit(item: Item, role: 'item' | 'prerequisite'): string | null {
  if (item.recurrenceRule !== null) {
    return `A recurring habit cannot be used as a ${role} in a prerequisite relationship (§4.2)`
  }
  return null
}

// ── Cycle detection ───────────────────────────────────────────────────────────

/**
 * §4.2 — Would adding the edge (itemId → proposedPrereqId) form a cycle?
 *
 * Strategy: walk forward from proposedPrereqId following its own prerequisite edges.
 * If itemId is reachable → the proposed edge would close a cycle.
 *
 * Example: A→B exists; proposing B→A: walk from A following prereqs; B is reachable → reject.
 */
export async function wouldFormCycle(
  pool: Pool,
  itemId: string,
  proposedPrereqId: string,
  userId: string
): Promise<boolean> {
  // BFS from proposedPrereqId following "what does X depend on" edges
  const visited = new Set<string>()
  const queue: string[] = [proposedPrereqId]

  while (queue.length > 0) {
    const current = queue.shift()!
    if (current === itemId) return true    // itemId is reachable → cycle
    if (visited.has(current)) continue
    visited.add(current)

    const prereqs = await repos.findPrerequisitesByItem(pool, current, userId)
    for (const p of prereqs) {
      if (!visited.has(p.prerequisiteId)) {
        queue.push(p.prerequisiteId)
      }
    }
  }

  return false
}

// ── Edge management ───────────────────────────────────────────────────────────

export type AddPrerequisiteResult =
  | { ok: true; edge: ItemPrerequisite; event: TrackerEvent }
  | { ok: false; error: string }

/**
 * §4.2 — Add a prerequisite edge after all guards pass:
 *   1. Neither item nor prerequisite may be a habit.
 *   2. Edge must not form a cycle.
 *
 * On success: inserts the edge row + fires prerequisite_added event.
 * On failure: returns { ok: false, error }.
 */
export async function addPrerequisite(
  pool: Pool,
  item: Item,
  prerequisite: Item,
  userId: string
): Promise<AddPrerequisiteResult> {
  const itemErr  = validateNotHabit(item, 'item')
  if (itemErr) return { ok: false, error: itemErr }

  const prereqErr = validateNotHabit(prerequisite, 'prerequisite')
  if (prereqErr) return { ok: false, error: prereqErr }

  const cycle = await wouldFormCycle(pool, item.id, prerequisite.id, userId)
  if (cycle) {
    return { ok: false, error: `Adding this prerequisite would form a cycle (§4.2)` }
  }

  const edge = await repos.insertPrerequisite(pool, item.id, prerequisite.id, userId)
  const event = await repos.insertEvent(pool, {
    userId,
    eventType: 'prerequisite_added',
    itemId: item.id,
    payload: { prerequisiteItemId: prerequisite.id },
  })

  return { ok: true, edge, event }
}

/**
 * §4.2 — Remove a prerequisite edge and log the event.
 * Returns the event, or null if the edge didn't exist.
 */
export async function removePrerequisite(
  pool: Pool,
  itemId: string,
  prerequisiteId: string,
  userId: string
): Promise<TrackerEvent | null> {
  const deleted = await repos.deletePrerequisite(pool, itemId, prerequisiteId, userId)
  if (!deleted) return null

  return repos.insertEvent(pool, {
    userId,
    eventType: 'prerequisite_removed',
    itemId,
    payload: { prerequisiteItemId: prerequisiteId },
  })
}

// ── Blocked-status derivation ─────────────────────────────────────────────────

/**
 * §4.2 — Derive whether an item is currently blocked.
 * An item is blocked if ANY of its prerequisites has not been completed (AND semantics).
 * "Completed" = latest completion event for the prerequisite's occurrence has percent ≥ 100.
 *
 * This is derived from events — never stored as a flag.
 */
export async function isBlocked(
  pool: Pool,
  itemId: string,
  userId: string
): Promise<boolean> {
  const prereqs = await repos.findPrerequisitesByItem(pool, itemId, userId)
  if (prereqs.length === 0) return false

  for (const prereq of prereqs) {
    const completed = await repos.isItemEverCompleted(pool, prereq.prerequisiteId, userId)
    if (!completed) return true  // at least one prerequisite is incomplete → blocked
  }

  return false  // all prerequisites completed
}

/**
 * §4.2 — Return the IDs of prerequisites that are not yet complete.
 * Useful for displaying "blocked by X, Y" in the UI (future).
 */
export async function getIncompletePrerequisites(
  pool: Pool,
  itemId: string,
  userId: string
): Promise<string[]> {
  const prereqs = await repos.findPrerequisitesByItem(pool, itemId, userId)
  const incomplete: string[] = []

  for (const prereq of prereqs) {
    const completed = await repos.isItemEverCompleted(pool, prereq.prerequisiteId, userId)
    if (!completed) incomplete.push(prereq.prerequisiteId)
  }

  return incomplete
}
