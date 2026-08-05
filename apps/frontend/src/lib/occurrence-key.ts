// §5.5 — identifying a rendered occurrence.
//
// An item can be due more than once on a day (one occurrence per schedule), so
// `itemId` alone no longer identifies a rendered row. Anywhere a React key, a
// dnd-kit sortable id, or a lookup needs to be unique per rendered occurrence, use
// these.
//
// Getting this wrong is a silent bug, not a loud one: duplicate React keys reassign
// state to the wrong row rather than throwing, and duplicate dnd-kit ids make a drag
// move the wrong element.

import type { ComputedOccurrence } from '@tracker/shared'

type Identifiable = Pick<ComputedOccurrence, 'id' | 'itemId' | 'scheduleId'>

/**
 * A stable key for one rendered occurrence.
 *
 * Materialized rows use their own id; unmaterialized ones fall back to the identity
 * the server computed them from — (item, schedule) — which is unique within a day.
 */
export function occurrenceKey(occ: Identifiable): string {
  return occ.id ?? `${occ.itemId}:${occ.scheduleId}`
}

/**
 * A key for drag-and-drop, which reorders ITEMS (Item.sortOrder), not occurrences.
 *
 * Deliberately not occurrenceKey: this must be derivable from the occurrence alone in
 * both directions, so a drop can be mapped back to the item whose order changed.
 * Two slots of one item are two draggable rows; dragging either reorders the item,
 * which is what sortOrder means.
 */
export function sortableKey(occ: Identifiable): string {
  return `${occ.itemId}:${occ.scheduleId}`
}

/**
 * The item ids behind a list of rendered occurrences, in order, without repeats.
 *
 * The reorder endpoints speak in item ids; a multi-slot item contributes several rows
 * but only one position, so sending its id twice would be rejected as a mismatched set.
 */
export function orderedItemIds(occs: Identifiable[]): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const occ of occs) {
    if (seen.has(occ.itemId)) continue
    seen.add(occ.itemId)
    ids.push(occ.itemId)
  }
  return ids
}
