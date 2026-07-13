// §6.1–6.4 — Pure, deterministic completion-state derivation.
//
// These functions operate on an already-fetched event list — no DB access.
// They are the single source of truth for "what is this occurrence's completion state?"
//
// Leaf completion: binary 0 or 100, driven by item_completed / retroactive_completion events.
// Parent derived %: (completed due children) / (due children) — 0 due → 100% (vacuous).
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
 * §6.1 — Compute derived parent % from due-child counts.
 * 0 due children → 100% (vacuous: parent is complete on days no children are scheduled,
 * e.g. Night Routine on Tuesday when only the MWF Tretinoin child exists).
 */
export function computeDerivedPercent(dueCount: number, completedCount: number): number {
  if (dueCount === 0) return 100
  return Math.round((completedCount / dueCount) * 100)
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
