// Builds a parent/child tree from a flat occurrence array for a single day.
// Parent/child matching is item-level (Item.parentId) and same-day only —
// mirrors the backend's own rule for attaching a child occurrence to its
// parent occurrence (see apps/backend/src/domain/completion.ts).

import type { OccurrenceWithState } from '@tracker/shared'
import type { Bucket } from '@tracker/shared'
import { sortByTiming } from './list-sort'

export type OccurrenceNode = {
  occ: OccurrenceWithState
  children: OccurrenceNode[]
}

// Returns the roots — occurrences with no parent in this array, either
// because they have no parent item, or because the parent's occurrence
// wasn't materialized for this day (off-schedule day). Those still render
// as normal standalone rows, matching how the backend treats them as leaves.
export function buildOccurrenceTree(
  occs: OccurrenceWithState[],
  buckets: Bucket[]
): OccurrenceNode[] {
  const byItemId = new Map(occs.map((o) => [o.itemId, o]))
  const childrenByParentItemId = new Map<string, OccurrenceWithState[]>()

  for (const occ of occs) {
    const parentId = occ.snapshot.parentId
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
    const parentId = occ.snapshot.parentId
    return !parentId || !byItemId.has(parentId)
  })

  return roots.map(buildNode)
}
