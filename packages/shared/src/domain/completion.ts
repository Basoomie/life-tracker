// §6.1–6.4 — Pure, deterministic completion-state derivation.
//
// These functions operate on an already-fetched event list — no DB access.
// They are the single source of truth for "what is this occurrence's completion state?"
//
// Leaf completion: binary 0 or 100, driven by item_completed / retroactive_completion events.
// Parent derived %: the MEAN of its due children's own completion values — 0 due → 100% (vacuous).
// Parent declared %: from manual_parent_percent_declared events; coexists with derived %.

import type { TrackerEvent } from '../types/events'

// ── Public types ──────────────────────────────────────────────────────────────

// §6.1 — leaf completion state derived from events
export type LeafCompletionState = {
  completionPercent: 0 | 100
  completedAt: Date | null    // null = not complete
  wasRetroactive: boolean     // true when event type is retroactive_completion (§6.4)
}

// §6.1 / §6.2 — parent completion state
export type ParentCompletionState = {
  derivedPercent: number        // computed from due children; always available
  declaredPercent: number | null // from manual_parent_percent_declared; null if never set
  displayPercent: number         // declaredPercent ?? derivedPercent (what to show)
  isComplete: boolean            // derivedPercent >= 100 OR declaredPercent is set
}

// ── Leaf completion ───────────────────────────────────────────────────────────

/**
 * §6.1 — Derive leaf completion state from the occurrence's event stream.
 * The latest item_completed or retroactive_completion event determines state.
 * If none exist, the item is not complete (0%).
 */
export function deriveLeafCompletion(events: TrackerEvent[]): LeafCompletionState {
  let latest: (typeof events)[number] | null = null

  for (const event of events) {
    if (event.eventType === 'item_completed' || event.eventType === 'retroactive_completion') {
      if (!latest || event.recordedAt > latest.recordedAt) {
        latest = event
      }
    }
  }

  if (!latest) {
    return { completionPercent: 0, completedAt: null, wasRetroactive: false }
  }

  // Narrow via discriminated union: payload is typed based on eventType
  const pct =
    latest.eventType === 'item_completed' || latest.eventType === 'retroactive_completion'
      ? latest.payload.completionPercent
      : 0

  return {
    completionPercent: (pct >= 100 ? 100 : 0) as 0 | 100,
    completedAt: latest.recordedAt,
    wasRetroactive: latest.eventType === 'retroactive_completion',
  }
}

// ── Parent completion ─────────────────────────────────────────────────────────

/**
 * §6.1 — Compute derived parent % from the contributions of its due children.
 *
 * Each contribution is that child's OWN completion value on the day, 0–100:
 * binary for a leaf, its own (declared ?? derived) value for a child that is
 * itself a parent — see computeNodePercent. The parent's derived % is their
 * mean, so a sub-routine sitting at 86% is worth 86, not 0 (partial credit).
 *
 * The caller supplies only children that were DUE and NOT EXCUSED:
 *   • not-due children are invisible and out of the denominator (§6.1);
 *   • excused children are out of the denominator too — §8.1 says an excuse
 *     "does not count against completion rate," and leaving one in would drag
 *     the parent down exactly like a miss.
 *
 * Empty list → 100% (vacuous). That covers both "no children scheduled today"
 * (§6.1's Night-Routine-on-Tuesday case) and "every due child was excused" —
 * in neither case was there anything the user failed to do, and scoring it 0
 * would turn an excuse into a miss.
 */
export function computeDerivedPercent(contributions: number[]): number {
  if (contributions.length === 0) return 100
  const total = contributions.reduce((sum, pct) => sum + pct, 0)
  return Math.round(total / contributions.length)
}

/**
 * §6.1 — A node in the containment tree, reduced to just what completion needs.
 * Built by the backend domain layer (which owns due-ness, event replay and DB
 * access); this module only applies the rule to it.
 */
export type CompletionNode = {
  isParent: boolean               // has children in the containment tree
  leafPercent: number             // 0 | 100 from deriveLeafCompletion — leaves only
  declaredPercent: number | null  // manual_parent_percent_declared — parents only
  dueChildren: CompletionNode[]   // due, non-excused children only; parents only
}

/**
 * §6.1 / §6.3 — This node's own completion value, 0–100.
 *
 * A leaf is binary. A parent is its derived % (the mean of its due children,
 * recursively) unless it was manually completed, in which case the declared %
 * is its value — §6.3: "if the parent is never manually completed, its value is
 * the derived %." This is what makes a nested sub-routine count toward its
 * grandparent at all: a parent occurrence never carries an item_completed
 * event, so reading it as a leaf would score every sub-routine 0 forever.
 */
export function computeNodePercent(node: CompletionNode): number {
  if (!node.isParent) return node.leafPercent >= 100 ? 100 : 0
  const derivedPercent = computeDerivedPercent(node.dueChildren.map(computeNodePercent))
  return node.declaredPercent ?? derivedPercent
}

/**
 * §6.2 — Find the declared % from the event stream.
 * Returns the latest manual_parent_percent_declared value, or null if never manually set.
 */
export function findDeclaredPercent(events: TrackerEvent[]): number | null {
  let latest: (typeof events)[number] | null = null

  for (const event of events) {
    if (event.eventType === 'manual_parent_percent_declared') {
      if (!latest || event.recordedAt > latest.recordedAt) {
        latest = event
      }
    }
  }

  if (!latest) return null
  // manual_parent_percent_declared narrows to the correct payload shape
  return latest.eventType === 'manual_parent_percent_declared' ? latest.payload.declaredPercent : null
}

/**
 * §6.2 — Build the full ParentCompletionState from derived % and events.
 * Both values coexist and can diverge (v2 will use both independently).
 */
export function buildParentCompletionState(
  derivedPercent: number,
  events: TrackerEvent[]
): ParentCompletionState {
  const declaredPercent = findDeclaredPercent(events)
  const displayPercent = declaredPercent ?? derivedPercent
  // Declared, when present, is authoritative for completeness too — mirrors
  // displayPercent's precedence, so a declared 0% can override a vacuous
  // derived 100% and a declared 75% doesn't read as "done".
  const isComplete = declaredPercent !== null ? declaredPercent >= 100 : derivedPercent >= 100
  return { derivedPercent, declaredPercent, displayPercent, isComplete }
}
