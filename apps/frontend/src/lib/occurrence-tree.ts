// Builds a parent/child tree from a flat occurrence array for a single day.
// Parent/child matching is item-level and same-day only — mirrors the backend's
// own rule for attaching a child occurrence to its parent occurrence (see
// apps/backend/src/domain/completion.ts).
//
// §4.1 — containment comes from the occurrence's LIVE parentItemId, not
// snapshot.parentId. The snapshot froze at materialization, so after a reparent
// it can name a stale parent (or none at all) while items.parent_id — the
// column the reorder endpoints read — says otherwise. Building the tree from
// the snapshot is what let a child be treated as a top-level item and offered a
// root drag handle the server then refused.

import type { OccurrenceWithState } from '@tracker/shared'
import type { Bucket } from '@tracker/shared'
import { sortByTiming } from './list-sort'

export type OccurrenceNode = {
  occ: OccurrenceWithState
  children: OccurrenceNode[]
}

/**
 * §4.1 — a child rendered at top level because its parent has no occurrence
 * today ("detached"), and the parent's name to label it with.
 *
 * Returns null for a genuine top-level item (no parent at all) and for a child
 * rendered inside its parent's card (parent present, so the hierarchy is
 * already visible). Non-null only for the case the UI has to explain: the item
 * is due, its parent is not, and it would otherwise look top-level.
 */
export function detachedParentName(
  occ: OccurrenceWithState,
  occsForDay: OccurrenceWithState[]
): string | null {
  if (occ.parentItemId === null) return null
  const parentPresent = occsForDay.some((o) => o.itemId === occ.parentItemId)
  return parentPresent ? null : occ.parentName
}

/** §4.1 — is this item top-level, as the server would answer it? */
export function isRootItem(occ: OccurrenceWithState): boolean {
  return occ.parentItemId === null
}

// Returns the rows that render at the top level — occurrences with no parent
// item, plus children whose parent has no occurrence this day (§4.1: those
// render as child rows carrying their parent's name, never as top-level items —
// see detachedParentName). Hiding them instead would drop work the user's own
// schedule says is due today.
export function buildOccurrenceTree(
  occs: OccurrenceWithState[],
  buckets: Bucket[]
): OccurrenceNode[] {
  // §5.5 — one entry per item is safe here ONLY because an item with children
  // carries at most one schedule, so a parent never has two occurrences on a day.
  // This map is used solely to ask "is this occurrence's parent present today?".
  // Children are grouped below from the full array, so a CHILD due in several slots
  // correctly contributes one row per slot.
  const byItemId = new Map(occs.map((o) => [o.itemId, o]))
  const childrenByParentItemId = new Map<string, OccurrenceWithState[]>()

  for (const occ of occs) {
    const parentId = occ.parentItemId
    if (!parentId || !byItemId.has(parentId)) continue
    const siblings = childrenByParentItemId.get(parentId) ?? []
    siblings.push(occ)
    childrenByParentItemId.set(parentId, siblings)
  }

  function buildNode(occ: OccurrenceWithState): OccurrenceNode {
    const rawChildren = childrenByParentItemId.get(occ.itemId) ?? []
    // Manual drag-and-drop order wins; sortByTiming is only the tiebreak for
    // children that tie at the default sortOrder (nobody's dragged them yet)
    // — stable sort preserves that timing order among ties.
    const children = sortByTiming(rawChildren, buckets)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(buildNode)
    return { occ, children }
  }

  // Root order is intentionally left as input order — callers (NowView's
  // tiering, ListView's day/priority sorting) already impose their own
  // ordering on roots and would otherwise sort twice.
  const roots = occs.filter((occ) => {
    const parentId = occ.parentItemId
    return !parentId || !byItemId.has(parentId)
  })

  return roots.map(buildNode)
}
